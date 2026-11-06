#!/usr/bin/env python3
"""Original MIT Game Boy AGOD discovery fixture.

The same contract as tools/make_agod_test_rom.py on a third console: a resource
one action depletes to a floor, an accumulator another action raises, a reset
that restores the resource and destroys the gain, a second accumulator so
"increasing" is not unique to one button, and a time-driven counter no action
causes. The oracle goes to a separate path; the analyser never reads it.

PACED BY THE SCREEN. tools/make_retro_roms.py loops at CPU speed, so its
counter moves thousands of times per frame. This fixture waits on LY ($FF44)
reaching 144 and then leaving it, so one iteration is one frame and a pulse of
four held frames is four iterations - which is what makes a resource track a
readable staircase instead of a cliff.

BOTH JOYPAD GROUPS ARE READ. $FF00 selects directions with P14 low ($20
written) and buttons with P15 low ($10 written); each read returns four
ACTIVE-LOW bits. The fixture reads both every frame, so every one of the eight
buttons FlyPlatforms declares is reachable.

Button indices are the FlyPlatforms order - A B Select Start Up Down Left
Right - because that is the order agod-platform-driver.js turns into mask bits.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path

# work RAM, which starts at $C000 on this console
FRAME_LO, FRAME_HI, LIVES, SCORE, BTN_LATCH, DIR_LATCH, LEVEL, LOCK = (
    0xC000, 0xC001, 0xC002, 0xC003, 0xC004, 0xC005, 0xC006, 0xC007)
# bit positions in the low nibble of each $FF00 group, active low
BUTTON_BIT = {'a': 0, 'b': 1, 'select': 2, 'start': 3}
DIR_BIT = {'right': 0, 'left': 1, 'up': 2, 'down': 3}
INDEX = {'a': 0, 'b': 1, 'select': 2, 'start': 3,
         'up': 4, 'down': 5, 'left': 6, 'right': 7}

LOGO = ('CEED6666CC0D000B03730083000C000D0008111F8889000EDCCC6EE6DDDDD999BBBB'
        '67636E0EECCCDDDC999FBBB9333E')


class LR35902:
    def __init__(self, origin):
        self.code = bytearray()
        self.origin = origin
        self.labels = {}
        self.short = []   # JR patch sites
        self.far = []     # JP patch sites

    def emit(self, *values):
        self.code.extend(values)

    def label(self, name):
        assert name not in self.labels, name
        self.labels[name] = len(self.code)

    def ld_a(self, value):
        self.emit(0x3E, value)

    def ld_nn_a(self, address):             # LD (nn),A
        self.emit(0xEA, address & 255, address >> 8)

    def ld_a_nn(self, address):             # LD A,(nn)
        self.emit(0xFA, address & 255, address >> 8)

    def ldh_a(self, port):                  # LDH A,($FFxx)
        self.emit(0xF0, port)

    def ldh_port_a(self, port):             # LDH ($FFxx),A
        self.emit(0xE0, port)

    def inc_mem(self, address):             # LD HL,nn : INC (HL)
        self.emit(0x21, address & 255, address >> 8, 0x34)

    def dec_mem(self, address):             # LD HL,nn : DEC (HL)
        self.emit(0x21, address & 255, address >> 8, 0x35)

    def store(self, address, value):
        self.ld_a(value)
        self.ld_nn_a(address)

    def jr(self, opcode, name):             # JR cc,e8
        self.emit(opcode, 0)
        self.short.append((len(self.code) - 1, name))

    def jp(self, name):
        self.emit(0xC3, 0, 0)
        self.far.append((len(self.code) - 2, name))

    def finish(self):
        for position, name in self.short:
            delta = self.labels[name] - (position + 1)
            assert -128 <= delta <= 127, (name, delta)
            self.code[position] = delta & 255
        for position, name in self.far:
            target = self.origin + self.labels[name]
            self.code[position] = target & 255
            self.code[position + 1] = target >> 8


def cartridge(code, color, name):
    rom = bytearray(32768)
    rom[0x100:0x104] = bytes([0xC3, 0x50, 0x01, 0])      # JP $0150
    rom[0x104:0x134] = bytes.fromhex(LOGO)
    rom[0x134:0x143] = name.encode().ljust(15, b' ')
    rom[0x143] = 0x80 if color else 0
    rom[0x147] = 0                                        # ROM only
    rom[0x14D] = (-sum(rom[0x134:0x14D]) - 25) & 255
    assert len(code) <= 32768 - 0x150, len(code)
    rom[0x150:0x150 + len(code)] = code
    return rom


def prologue(a):
    """Interrupts off, a stack, the screen on, a palette - the minimum the
    core needs to run and the same sequence tools/make_retro_roms.py uses."""
    a.emit(0xF3, 0x31, 0xFE, 0xFF)                        # DI : LD SP,$FFFE
    a.store(0xFF40, 0)                                    # LCD off while setting up
    for address, value in [(0xFF47, 0xE4), (0xFF40, 0x91)]:
        a.ld_a(value)
        a.ldh_port_a(address & 255)


def frame_gate(a, tag):
    """One iteration per frame: wait for LY to reach 144, and later to leave."""
    a.label('vb_' + tag)
    a.ldh_a(0x44)
    a.emit(0xFE, 0x90)                                    # CP 144
    a.jr(0x20, 'vb_' + tag)                               # JR NZ


def frame_release(a, tag):
    a.label('out_' + tag)
    a.ldh_a(0x44)
    a.emit(0xFE, 0x90)
    a.jr(0x28, 'out_' + tag)                              # JR Z


def read_group(a, select, latch):
    """Held-and-newly-pressed bits of one joypad group, left in A.

    $FF00 is active low, so the read is complemented; the latch holds last
    frame's held bits, so A ends as the rising edges alone.
    """
    a.ld_a(select)
    a.ldh_port_a(0x00)
    a.ldh_a(0x00)
    a.ldh_a(0x00)                                         # twice: the port settles
    a.emit(0x2F, 0xE6, 0x0F)                              # CPL : AND $0F -> held
    a.emit(0x47)                                          # LD B,A (held)
    a.ld_a_nn(latch)
    a.emit(0x2F)                                          # CPL -> 1 where it was free
    a.emit(0xA0)                                          # AND B -> rising edges
    a.emit(0x4F)                                          # LD C,A (edges)
    a.emit(0x78)                                          # LD A,B
    a.ld_nn_a(latch)                                      # latch := held
    a.emit(0x79)                                          # LD A,C -> edges


def edge(a, bit, tag, body):
    """Run body when the given bit of A is a rising edge; A is preserved."""
    a.emit(0x47)                                          # LD B,A
    a.emit(0xE6, 1 << bit)                                # AND mask
    a.jr(0x28, 'skip_' + tag)                             # JR Z
    body()
    a.label('skip_' + tag)
    a.emit(0x78)                                          # LD A,B


def generate(seed=0, color=False):
    a = LR35902(0x150)
    prologue(a)
    a.store(FRAME_LO, 0)
    a.store(FRAME_HI, 0)
    a.store(LIVES, 3)
    a.store(SCORE, 100 + (seed % 7))
    a.store(BTN_LATCH, 0)
    a.store(DIR_LATCH, 0)
    a.store(LEVEL, 1)
    a.store(LOCK, 0)

    a.label('top')
    frame_gate(a, 'top')

    # THE TIME-DRIVEN DECOY: a 16-bit counter no action causes.
    a.inc_mem(FRAME_LO)
    a.jr(0x20, 'no_carry')                                # JR NZ, INC (HL) sets Z
    a.inc_mem(FRAME_HI)
    a.label('no_carry')

    # the respawn lockout, so the cost cannot fire on consecutive frames
    a.ld_a_nn(LOCK)
    a.emit(0xB7)                                          # OR A
    a.jr(0x28, 'unlocked')                                # JR Z
    a.dec_mem(LOCK)
    a.jp('tail')
    a.label('unlocked')

    # directions first: the RESET arm lives here
    read_group(a, 0x20, DIR_LATCH)

    def do_reset():
        a.store(LIVES, 3)
        a.store(SCORE, 0)

    def do_level():
        a.inc_mem(LEVEL)

    edge(a, DIR_BIT['up'], 'reset', do_reset)
    edge(a, DIR_BIT['right'], 'level', do_level)

    # terminal: once the resource is gone, nothing else advances
    a.ld_a_nn(LIVES)
    a.emit(0xB7)
    a.jr(0x28, 'tail_jr')

    read_group(a, 0x10, BTN_LATCH)

    def do_gain():
        a.inc_mem(SCORE)

    def do_cost():
        a.dec_mem(LIVES)
        a.store(LOCK, 18)

    edge(a, BUTTON_BIT['a'], 'gain', do_gain)
    edge(a, BUTTON_BIT['b'], 'cost', do_cost)

    a.label('tail_jr')
    a.label('tail')
    frame_release(a, 'top')
    a.jp('top')
    a.finish()

    rom = cartridge(a.code, color, 'FLY AGOD GB')
    oracle = {
        'type': 'agod-gb-oracle', 'version': 1, 'seed': seed,
        'platform': 'gb', 'workRamBase': 0xC000,
        'fields': {
            'frameCounter': {'offset': FRAME_LO - 0xC000, 'width': 2, 'timeDriven': True},
            'lives': {'offset': LIVES - 0xC000, 'width': 1},
            'score': {'offset': SCORE - 0xC000, 'width': 1},
            'level': {'offset': LEVEL - 0xC000, 'width': 1}},
        'resource': 'lives', 'accumulator': 'score',
        'costAction': {'button': 'B', 'index': INDEX['b'], 'mask': 1 << INDEX['b']},
        'gainAction': {'button': 'A', 'index': INDEX['a'], 'mask': 1 << INDEX['a']},
        'resetAction': {'button': 'up', 'index': INDEX['up'], 'mask': 1 << INDEX['up']},
        'notPositive': ['score', 'level', 'frameCounter'],
        'terminal': 'nothing advances once lives reaches 0',
        'note': 'checker-only metadata; the analyser must never read this file'}
    return rom, oracle


def quiet(seed=0, color=False):
    """THE NEGATIVE CONTROL: identical header and screen setup, the same
    time-driven counter, and no input handling whatsoever. A VERIFIED here
    would be structure that is not in the cartridge."""
    a = LR35902(0x150)
    prologue(a)
    a.store(FRAME_LO, 0)
    a.store(FRAME_HI, 0)
    a.store(LIVES, 3)
    a.store(SCORE, 100)
    a.label('top')
    frame_gate(a, 'top')
    a.inc_mem(FRAME_LO)
    a.jr(0x20, 'no_carry')
    a.inc_mem(FRAME_HI)
    a.label('no_carry')
    frame_release(a, 'top')
    a.jp('top')
    a.finish()
    rom = cartridge(a.code, color, 'FLY AGOD GB Q')
    oracle = {'type': 'agod-gb-oracle', 'version': 1, 'seed': seed,
              'platform': 'gb', 'workRamBase': 0xC000,
              'fields': {'frameCounter': {'offset': FRAME_LO - 0xC000, 'width': 2,
                                          'timeDriven': True}},
              'resource': None, 'accumulator': None,
              'costAction': None, 'gainAction': None, 'resetAction': None,
              'notPositive': ['frameCounter'],
              'expectation': 'REFUSED: no action changes anything on this cartridge',
              'note': 'checker-only metadata; the analyser must never read this file'}
    return rom, oracle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--oracle-out', type=Path)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--color', action='store_true', help='a GBC cartridge')
    parser.add_argument('--negative', action='store_true')
    args = parser.parse_args()
    build = quiet if args.negative else generate
    rom, oracle = build(args.seed, args.color)
    payload = {'kind': 'gb', 'name': 'FLY AGOD GB',
               'sha256': hashlib.sha256(bytes(rom)).hexdigest(),
               'base64': base64.b64encode(bytes(rom)).decode()}
    args.out.write_text(json.dumps(payload, indent=2) + '\n')
    if args.oracle_out:
        args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')
    print(('negative' if args.negative else 'positive') + ' gb fixture: '
          + payload['sha256'][:16])


if __name__ == '__main__':
    main()
