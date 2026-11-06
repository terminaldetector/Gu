#!/usr/bin/env python3
"""Original MIT Mega Drive AGOD discovery fixture.

Same contract as tools/make_agod_test_rom.py, on a different console: a
resource a specific action depletes, an accumulator another action raises, a
reset that restores the resource and destroys the gain, and a time-driven decoy
that no action causes. The oracle is written to a separate path and the
analyser never reads it.

WHY A NEW CARTRIDGE. tools/make_sega_rom.py already moves a counter on
Left/Right, which is why agod-pipeline.js types a field on it - but it has no
resource, no floor and no terminal structure, so the run refuses at `induce`
with polarity UNKNOWN. That refusal is correct and therefore useless as a
positive control: a fixture that cannot be verified cannot show that
verification works.

ONLY TH=1 BUTTONS ARE USED. $A10003 with TH high exposes Up, Down, Left,
Right, B and C; A and Start live behind TH low. The fixture confines itself to
the first group, so no part of the pad multiplexing is assumed.

Button indices are the FlyPlatforms order - A B C Start Up Down Left Right -
because that is the order agod-platform-driver.js turns into mask bits.
"""
import argparse
import base64
import hashlib
import json
import struct
from pathlib import Path

PAD1 = 0xA10003
WORK = 0xFF0000
# work RAM layout, as logical offsets from the start of work RAM
FRAME, LIVES, SCORE, LATCH, LEVEL, LOCK = 0x00, 0x02, 0x04, 0x06, 0x07, 0x08
# $A10003 bit positions with TH high
BIT = {'up': 0, 'down': 1, 'left': 2, 'right': 3, 'b': 4, 'c': 5}
# FlyPlatforms index -> mask, for the oracle only
INDEX = {'a': 0, 'b': 1, 'c': 2, 'start': 3, 'up': 4, 'down': 5, 'left': 6, 'right': 7}


class M68K:
    def __init__(self, rom, pc):
        self.rom, self.pc, self.labels, self.fix = rom, pc, {}, []

    def words(self, *values):
        for value in values:
            struct.pack_into('>H', self.rom, self.pc, value & 0xFFFF)
            self.pc += 2

    def long(self, value):
        self.words(value >> 16, value)

    def label(self, name):
        assert name not in self.labels, name
        self.labels[name] = self.pc

    def branch(self, opcode, name):
        self.words(opcode, 0)
        self.fix.append((self.pc - 2, name))

    # absolute-long forms, the same ones tools/make_sega_rom.py uses
    def move_b_imm(self, value, address):
        self.words(0x13FC, value)
        self.long(address)

    def move_w_imm(self, value, address):
        self.words(0x33FC, value)
        self.long(address)

    def move_l_imm(self, value, address):
        self.words(0x23FC)
        self.long(value)
        self.long(address)

    def read_b(self, address):          # MOVE.B (xxx).L,D0
        self.words(0x1039)
        self.long(address)

    def read_b_d1(self, address):       # MOVE.B (xxx).L,D1
        self.words(0x1239)
        self.long(address)

    def write_b_d0(self, address):      # MOVE.B D0,(xxx).L
        self.words(0x13C0)
        self.long(address)

    def addq_w(self, address):          # ADDQ.W #1,(xxx).L
        self.words(0x5279)
        self.long(address)

    def addq_b(self, address):          # ADDQ.B #1,(xxx).L
        self.words(0x5239)
        self.long(address)

    def subq_b(self, address):          # SUBQ.B #1,(xxx).L
        self.words(0x5339)
        self.long(address)

    def clr_w(self, address):           # CLR.W (xxx).L
        self.words(0x4279)
        self.long(address)

    def clr_b(self, address):           # CLR.B (xxx).L
        self.words(0x4239)
        self.long(address)

    def tst_b(self, address):           # TST.B (xxx).L
        self.words(0x4A39)
        self.long(address)

    def btst_d0(self, bit):             # BTST #bit,D0
        self.words(0x0800, bit)

    def btst_d1(self, bit):             # BTST #bit,D1
        self.words(0x0801, bit)

    def finish(self):
        for position, name in self.fix:
            struct.pack_into('>h', self.rom, position, self.labels[name] - position)


def generate(seed=0):
    rom = bytearray(0x10000)
    struct.pack_into('>II', rom, 0, 0xFFFF00, 0x200)
    for i in range(2, 64):
        struct.pack_into('>I', rom, i * 4, 0x200)
    for offset, length, text in [
            (0x100, 16, 'SEGA MEGA DRIVE'), (0x110, 16, '(C)FLY 2026'),
            (0x120, 48, 'FLY AGOD SEGA FIXTURE'), (0x150, 48, 'FLY AGOD SEGA FIXTURE'),
            (0x180, 14, 'GM FLY00001-00'), (0x190, 16, 'J'), (0x1F0, 16, 'U')]:
        rom[offset:offset + length] = text.encode().ljust(length, b' ')
    struct.pack_into('>IIII', rom, 0x1A0, 0, len(rom) - 1, 0xFF0000, 0xFFFFFF)

    a = M68K(rom, 0x200)
    a.words(0x46FC, 0x2700)                       # MOVE #$2700,SR - interrupts off
    for register in [0x8004, 0x8104, 0x8230, 0x8407, 0x8578, 0x8F02, 0x8700]:
        a.move_w_imm(register, 0xC00004)
    # clear VRAM, exactly as the working diagnostic does
    a.move_l_imm(0x40000000, 0xC00004)
    a.words(0x203C)
    a.long(0)
    a.words(0x323C, 0x3FFF)
    a.label('clear')
    a.words(0x23C0)
    a.long(0xC00000)
    a.branch(0x51C9, 'clear')                     # DBRA D1,clear
    a.move_w_imm(0x8144, 0xC00004)                # display on

    # controller ports: TH as output, high
    for address in [0xA10009, 0xA10003, 0xA1000B, 0xA10005]:
        a.move_b_imm(0x40, address)

    # initial state. lives starts at 3, as on NES; score starts at a value that
    # is not zero so "decreasing" and "increasing" cannot be confused with
    # "initialised".
    a.clr_w(WORK + FRAME)
    a.move_b_imm(3, WORK + LIVES)
    a.move_w_imm(100 + (seed % 7), WORK + SCORE)
    a.clr_b(WORK + LATCH)
    a.move_b_imm(1, WORK + LEVEL)
    a.clr_b(WORK + LOCK)

    # ---- one iteration per vertical blank ----
    a.label('top')
    # wait for vblank to end, then begin: the same handshake the diagnostic uses
    a.label('endblank')
    a.words(0x3039)
    a.long(0xC00004)
    a.words(0x0800, 3)
    a.branch(0x6600, 'endblank')
    a.label('blank')
    a.words(0x3039)
    a.long(0xC00004)
    a.words(0x0800, 3)
    a.branch(0x6700, 'blank')

    # THE TIME-DRIVEN DECOY. No action causes it; the neutral trajectory must
    # account for it and no stage may attribute it to a button.
    a.addq_w(WORK + FRAME)

    # read the pad once. $A10003 is ACTIVE LOW: a clear bit is a held button.
    a.read_b(PAD1)
    a.words(0x4600)                               # NOT.B D0 -> 1 means held
    a.words(0x0240, 0x003F)                       # AND.W #$3F,D0
    # edge = held now AND NOT held last frame
    a.read_b_d1(WORK + LATCH)
    a.write_b_d0(WORK + LATCH)                    # latch := held (D0 preserved)
    a.words(0x4601)                               # NOT.B D1 -> 1 means was free
    a.words(0xC001)                               # AND.B D1,D0 -> D0 = edges

    # a respawn lockout, so the cost action cannot fire every frame: this is
    # what makes the resource track a staircase rather than a cliff
    a.tst_b(WORK + LOCK)
    a.branch(0x6700, 'unlocked')
    a.subq_b(WORK + LOCK)
    a.branch(0x6000, 'top')
    a.label('unlocked')

    # RESET, on Up: restores the resource and DESTROYS the accumulated gain.
    # This is the arm the reversal stage looks for, and zeroing the score is
    # what distinguishes depletion from a sacrifice.
    a.btst_d0(BIT['up'])
    a.branch(0x6700, 'no_reset')
    a.move_b_imm(3, WORK + LIVES)
    a.move_w_imm(0, WORK + SCORE)
    a.label('no_reset')

    # once the resource is gone nothing advances: the terminal structure
    a.tst_b(WORK + LIVES)
    a.branch(0x6700, 'top')

    # THE ACCUMULATOR, on B
    a.btst_d0(BIT['b'])
    a.branch(0x6700, 'no_gain')
    a.addq_w(WORK + SCORE)
    a.label('no_gain')

    # THE COST, on C: one life, then a lockout
    a.btst_d0(BIT['c'])
    a.branch(0x6700, 'no_cost')
    a.subq_b(WORK + LIVES)
    a.move_b_imm(18, WORK + LOCK)
    a.label('no_cost')

    # a second accumulator on Right, so "increasing" is not unique to one
    # button and the proposer cannot win by guessing
    a.btst_d0(BIT['right'])
    a.branch(0x6700, 'no_level')
    a.addq_b(WORK + LEVEL)
    a.label('no_level')

    a.branch(0x6000, 'top')
    a.finish()

    fields = {
        'frameCounter': {'offset': FRAME, 'width': 2, 'timeDriven': True},
        'lives': {'offset': LIVES, 'width': 1},
        'score': {'offset': SCORE, 'width': 2},
        'level': {'offset': LEVEL, 'width': 1},
    }
    oracle = {
        'type': 'agod-sega-oracle', 'version': 1, 'seed': seed,
        'platform': 'sega', 'workRamBase': WORK,
        'fields': fields,
        'resource': 'lives', 'accumulator': 'score',
        'costAction': {'button': 'C', 'index': INDEX['c'], 'mask': 1 << INDEX['c']},
        'gainAction': {'button': 'B', 'index': INDEX['b'], 'mask': 1 << INDEX['b']},
        'resetAction': {'button': 'up', 'index': INDEX['up'], 'mask': 1 << INDEX['up']},
        'notPositive': ['score', 'level', 'frameCounter'],
        'terminal': 'nothing advances once lives reaches 0',
        'note': 'checker-only metadata; the analyser must never read this file',
    }
    return rom, oracle


def quiet(seed=0):
    """THE NEGATIVE CONTROL: the same cartridge with the inputs disconnected.

    Identical header, identical VDP setup, identical time-driven counter, and
    no action does anything at all. A pipeline that returns VERIFIED here has
    found structure that is not present, so this is the cartridge that decides
    whether a positive result means anything.
    """
    rom, oracle = generate(seed)
    rom = bytearray(rom)
    a = M68K(rom, 0x200)
    # rebuild the prologue, then a loop that only counts frames
    a.words(0x46FC, 0x2700)
    for register in [0x8004, 0x8104, 0x8230, 0x8407, 0x8578, 0x8F02, 0x8700]:
        a.move_w_imm(register, 0xC00004)
    a.move_l_imm(0x40000000, 0xC00004)
    a.words(0x203C)
    a.long(0)
    a.words(0x323C, 0x3FFF)
    a.label('clear')
    a.words(0x23C0)
    a.long(0xC00000)
    a.branch(0x51C9, 'clear')
    a.move_w_imm(0x8144, 0xC00004)
    for address in [0xA10009, 0xA10003, 0xA1000B, 0xA10005]:
        a.move_b_imm(0x40, address)
    a.clr_w(WORK + FRAME)
    a.move_b_imm(3, WORK + LIVES)
    a.move_w_imm(100, WORK + SCORE)
    a.label('top')
    a.label('endblank')
    a.words(0x3039)
    a.long(0xC00004)
    a.words(0x0800, 3)
    a.branch(0x6600, 'endblank')
    a.label('blank')
    a.words(0x3039)
    a.long(0xC00004)
    a.words(0x0800, 3)
    a.branch(0x6700, 'blank')
    a.addq_w(WORK + FRAME)
    a.branch(0x6000, 'top')
    # everything after the new loop is left as the old code but unreachable;
    # blank it so the cartridge contains no action handling at all
    for offset in range(a.pc, 0x4000):
        rom[offset] = 0
    a.finish()
    oracle = {'type': 'agod-sega-oracle', 'version': 1, 'seed': seed,
              'platform': 'sega', 'workRamBase': WORK,
              'fields': {'frameCounter': {'offset': FRAME, 'width': 2, 'timeDriven': True}},
              'resource': None, 'accumulator': None,
              'costAction': None, 'gainAction': None, 'resetAction': None,
              'notPositive': ['frameCounter'],
              'expectation': 'REFUSED: no action changes anything on this cartridge',
              'note': 'checker-only metadata; the analyser must never read this file'}
    return rom, oracle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--oracle-out', type=Path, help='checker-only; never load into the analyser')
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--negative', action='store_true', help='the no-structure control')
    args = parser.parse_args()
    rom, oracle = quiet(args.seed) if args.negative else generate(args.seed)
    payload = {'kind': 'sega', 'name': 'FLY AGOD SEGA FIXTURE',
               'sha256': hashlib.sha256(bytes(rom)).hexdigest(),
               'base64': base64.b64encode(bytes(rom)).decode()}
    args.out.write_text(json.dumps(payload, indent=2) + '\n')
    if args.oracle_out:
        args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')
    print(('negative' if args.negative else 'positive') + ' sega fixture: '
          + payload['sha256'][:16])


if __name__ == '__main__':
    main()
