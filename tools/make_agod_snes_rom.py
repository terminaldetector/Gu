#!/usr/bin/env python3
"""Original MIT SNES AGOD discovery fixture.

The same contract as tools/make_agod_test_rom.py on the fourth console: a
resource one action depletes to a floor, an accumulator another action raises,
a reset that restores the resource and destroys the gain, a second accumulator,
and a time-driven counter no action causes. The oracle goes to a separate path
and the analyser never reads it.

HOW A MASK BIT REACHES THIS CARTRIDGE. tools/retro/bridge.cpp maps driver mask
bit i to libretro joypad id map[i] with
map = {8, 0, 1, 3, 4, 5, 6, 7, 9, 10, 11, 2}, and libretro's joypad id order is
itself the SNES serial order (B Y Select Start Up Down Left Right A X L R). So
serial position k carries libretro id k, and the three buttons this fixture
uses land at:

    driver mask 1   (A, FlyPlatforms index 0)  -> libretro 8 -> serial 8
    driver mask 2   (B, index 1)               -> libretro 0 -> serial 0
    driver mask 16  (Up, index 4)              -> libretro 4 -> serial 4
    driver mask 128 (Right, index 7)           -> libretro 7 -> serial 7

That chain is derived from the bridge, not guessed, and the fixture probe
measures it afterwards.

PACED BY VBLANK via $4212, so one iteration is one frame.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path

# WRAM, which the core's read window exposes from offset 0; bank-0 $0000..$1FFF
# is the same memory, so direct-page stores land in the window.
FRAME, LIVES, SCORE, LEVEL, LOCK = 0x00, 0x02, 0x03, 0x04, 0x05
NOW, PREV = 0x0010, 0x0020          # 12 sampled bits, and last frame's
SERIAL = {'b': 0, 'y': 1, 'select': 2, 'start': 3, 'up': 4, 'down': 5,
          'left': 6, 'right': 7, 'a': 8, 'x': 9, 'l': 10, 'r': 11}
INDEX = {'a': 0, 'b': 1, 'y': 2, 'start': 3, 'up': 4, 'down': 5, 'left': 6,
         'right': 7, 'x': 8, 'l': 9, 'r': 10, 'select': 11}


class W65816:
    def __init__(self):
        self.code = bytearray()
        self.labels = {}
        self.short = []
        self.far = []

    def emit(self, *values):
        self.code.extend(values)

    def label(self, name):
        assert name not in self.labels, name
        self.labels[name] = len(self.code)

    def lda_imm(self, value):
        self.emit(0xA9, value)

    def lda_dp(self, address):
        self.emit(0xA5, address)

    def sta_dp(self, address):
        self.emit(0x85, address)

    def lda_abs(self, address):
        self.emit(0xAD, address & 255, address >> 8)

    def sta_abs(self, address):
        self.emit(0x8D, address & 255, address >> 8)

    def stz_abs(self, address):
        self.emit(0x9C, address & 255, address >> 8)

    def inc_dp(self, address):
        self.emit(0xE6, address)

    def dec_dp(self, address):
        self.emit(0xC6, address)

    def store(self, address, value):
        self.lda_imm(value)
        self.sta_dp(address)

    def branch(self, opcode, name):
        self.emit(opcode, 0)
        self.short.append((len(self.code) - 1, name))

    def jmp(self, name):
        self.emit(0x4C, 0, 0)
        self.far.append((len(self.code) - 2, name))

    def finish(self):
        for position, name in self.short:
            delta = self.labels[name] - (position + 1)
            assert -128 <= delta <= 127, (name, delta)
            self.code[position] = delta & 255
        for position, name in self.far:
            target = 0x8000 + self.labels[name]
            self.code[position] = target & 255
            self.code[position + 1] = target >> 8


def prologue(a):
    """Native mode, 8-bit accumulator, 16-bit index, a stack, the screen on -
    the same sequence the working diagnostic in tools/make_retro_roms.py uses."""
    a.emit(0x78, 0x18, 0xFB, 0xC2, 0x10, 0xE2, 0x20, 0xA2, 0xFF, 0x1F, 0x9A)
    for address, value in [(0x2100, 0x80), (0x2121, 0), (0x2122, 0x1F),
                           (0x2122, 0), (0x4200, 0), (0x2100, 0x0F)]:
        a.lda_imm(value)
        a.sta_abs(address)


def sample_pad(a):
    """Strobe the controller port and leave the twelve serial bits at NOW."""
    a.lda_imm(1)
    a.sta_abs(0x4016)
    a.stz_abs(0x4016)
    a.emit(0xA2, 0, 0)                      # LDX #0 (X is 16-bit)
    a.label('serial')
    a.lda_abs(0x4016)
    a.emit(0x29, 1)                         # AND #1
    a.emit(0x9D, NOW & 255, NOW >> 8)       # STA NOW,X
    a.emit(0xE8)                            # INX
    a.emit(0xE0, 12, 0)                     # CPX #12
    a.branch(0xD0, 'serial')


def latch_pad(a):
    """PREV := NOW, for the next frame's edge test."""
    a.emit(0xA2, 0, 0)
    a.label('latch')
    a.emit(0xBD, NOW & 255, NOW >> 8)       # LDA NOW,X
    a.emit(0x9D, PREV & 255, PREV >> 8)     # STA PREV,X
    a.emit(0xE8)
    a.emit(0xE0, 12, 0)
    a.branch(0xD0, 'latch')


def edge(a, position, tag, body):
    """Run body only on the frame a button goes from free to held."""
    a.lda_abs(NOW + position)
    a.branch(0xF0, 'skip_' + tag)           # BEQ: not held
    a.lda_abs(PREV + position)
    a.branch(0xD0, 'skip_' + tag)           # BNE: was already held
    body()
    a.label('skip_' + tag)


def body(a, seed, quiet_mode):
    a.store(FRAME, 0)
    a.store(FRAME + 1, 0)
    a.store(LIVES, 3)
    a.store(SCORE, 100 + (seed % 7))
    a.store(LEVEL, 1)
    a.store(LOCK, 0)

    a.label('top')
    a.label('wait_vb')
    a.lda_abs(0x4212)
    a.branch(0x10, 'wait_vb')               # BPL: not in vblank yet

    # THE TIME-DRIVEN DECOY, 16 bits, caused by nothing.
    a.inc_dp(FRAME)
    a.branch(0xD0, 'no_carry')
    a.inc_dp(FRAME + 1)
    a.label('no_carry')

    if not quiet_mode:
        sample_pad(a)

        a.lda_dp(LOCK)
        a.branch(0xF0, 'unlocked')          # BEQ
        a.dec_dp(LOCK)
        a.jmp('tail')
        a.label('unlocked')

        def do_reset():
            a.store(LIVES, 3)
            a.store(SCORE, 0)

        def do_level():
            a.inc_dp(LEVEL)

        # the reset arm is tested before the terminal check, so it works at
        # the floor - which is the whole point of a reversal arm
        edge(a, SERIAL['up'], 'reset', do_reset)
        edge(a, SERIAL['right'], 'level', do_level)

        a.lda_dp(LIVES)
        a.branch(0xF0, 'tail')              # terminal: nothing advances at 0

        def do_gain():
            a.inc_dp(SCORE)

        def do_cost():
            a.dec_dp(LIVES)
            a.store(LOCK, 18)

        edge(a, SERIAL['a'], 'gain', do_gain)
        edge(a, SERIAL['b'], 'cost', do_cost)

        a.label('tail')
        latch_pad(a)
    else:
        a.label('tail')

    a.label('wait_out')
    a.lda_abs(0x4212)
    a.branch(0x30, 'wait_out')              # BMI: still in vblank
    a.jmp('top')
    a.finish()


def cartridge(code, title):
    rom = bytearray([0xFF]) * 65536
    assert len(code) <= 0x7FC0, len(code)
    rom[:len(code)] = code
    rom[0x7FC0:0x7FD5] = title.encode().ljust(21, b' ')
    rom[0x7FD5:0x7FDC] = bytes([0x20, 0, 6, 0, 1, 0x33, 0])
    for address in range(0x7FE0, 0x8000, 2):
        rom[address:address + 2] = bytes([0, 0x80])
    rom[0x7FDC:0x7FE0] = bytes(4)
    checksum = (sum(rom) + 510) & 0xFFFF
    rom[0x7FDC:0x7FE0] = ((checksum ^ 0xFFFF).to_bytes(2, 'little')
                          + checksum.to_bytes(2, 'little'))
    return rom


def generate(seed=0):
    a = W65816()
    prologue(a)
    body(a, seed, False)
    rom = cartridge(a.code, 'FLY AGOD SNES')
    oracle = {
        'type': 'agod-snes-oracle', 'version': 1, 'seed': seed,
        'platform': 'snes', 'workRamBase': 0x7E0000,
        'fields': {
            'frameCounter': {'offset': FRAME, 'width': 2, 'timeDriven': True},
            'lives': {'offset': LIVES, 'width': 1},
            'score': {'offset': SCORE, 'width': 1},
            'level': {'offset': LEVEL, 'width': 1}},
        'resource': 'lives', 'accumulator': 'score',
        'costAction': {'button': 'B', 'index': INDEX['b'], 'mask': 1 << INDEX['b'],
                       'serialPosition': SERIAL['b']},
        'gainAction': {'button': 'A', 'index': INDEX['a'], 'mask': 1 << INDEX['a'],
                       'serialPosition': SERIAL['a']},
        'resetAction': {'button': 'up', 'index': INDEX['up'], 'mask': 1 << INDEX['up'],
                        'serialPosition': SERIAL['up']},
        'notPositive': ['score', 'level', 'frameCounter'],
        'terminal': 'nothing advances once lives reaches 0',
        'note': 'checker-only metadata; the analyser must never read this file'}
    return rom, oracle


def quiet(seed=0):
    """THE NEGATIVE CONTROL: the same header, screen setup and time-driven
    counter, and the controller port is never even strobed."""
    a = W65816()
    prologue(a)
    body(a, seed, True)
    rom = cartridge(a.code, 'FLY AGOD SNES Q')
    oracle = {'type': 'agod-snes-oracle', 'version': 1, 'seed': seed,
              'platform': 'snes', 'workRamBase': 0x7E0000,
              'fields': {'frameCounter': {'offset': FRAME, 'width': 2,
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
    parser.add_argument('--negative', action='store_true')
    args = parser.parse_args()
    rom, oracle = (quiet if args.negative else generate)(args.seed)
    payload = {'kind': 'snes', 'name': 'FLY AGOD SNES',
               'sha256': hashlib.sha256(bytes(rom)).hexdigest(),
               'base64': base64.b64encode(bytes(rom)).decode()}
    args.out.write_text(json.dumps(payload, indent=2) + '\n')
    if args.oracle_out:
        args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')
    print(('negative' if args.negative else 'positive') + ' snes fixture: '
          + payload['sha256'][:16])


if __name__ == '__main__':
    main()
