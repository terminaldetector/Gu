#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Original MIT NES writer fixture; oracle is emitted only for the checker.

All code, graphics and sound are original GU test material. No game ROM is used.
The cartridge has two static 16 KiB PRG banks (NROM-256). Oracle PCs and write
values are assembler output, never inputs to the production probe or tracer.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path


class Assembly:
    def __init__(self, origin):
        self.origin = origin
        self.code = bytearray()
        self.labels = {}
        self.patches = []
        self.writes = []

    @property
    def pc(self):
        return self.origin + len(self.code)

    def emit(self, *values):
        self.code.extend(values)

    def label(self, name):
        assert name not in self.labels
        self.labels[name] = self.pc

    def absolute(self, opcode, target):
        self.emit(opcode, 0, 0)
        self.patches.append((len(self.code) - 2, target, False))

    def branch(self, opcode, target):
        self.emit(opcode, 0)
        self.patches.append((len(self.code) - 1, target, True))

    def write(self, name, instruction, address, *values):
        pc = self.pc
        self.emit(*instruction)
        for value in values:
            self.writes.append({'name': name, 'writerPc': pc, 'opcode': instruction[0],
                                'logicalAddress': address, 'address': address & 0x7ff,
                                'value': value, 'physicalBank': (pc - 0x8000) // 0x4000,
                                'prgOffset': pc - 0x8000, 'bankOffset': (pc - 0x8000) % 0x4000})

    def finish(self, external=None):
        labels = {**(external or {}), **self.labels}
        for offset, label, relative in self.patches:
            target = labels[label]
            if relative:
                delta = target - (self.origin + offset + 1)
                assert -128 <= delta <= 127, (label, delta)
                self.code[offset] = delta & 255
            else:
                self.code[offset:offset + 2] = target.to_bytes(2, 'little')
        return self.code


def generate():
    low, high = Assembly(0x8000), Assembly(0xc000)
    low.label('reset')
    low.emit(0x78, 0xd8, 0xa2, 0xff, 0x9a)  # SEI, CLD, LDX #ff, TXS.
    low.emit(0xa9, 0x11)
    low.write('sta-zp', (0x85, 0x40), 0x40, 0x11)
    low.emit(0xa9, 0x22)
    low.write('sta-absolute-mirror', (0x8d, 0x40, 0x08), 0x0840, 0x22)
    low.emit(0xa2, 3, 0xa9, 0x33)
    low.write('sta-zp-x', (0x95, 0x3d), 0x40, 0x33)
    low.emit(0xa0, 4, 0xa9, 0x44)
    low.write('sta-absolute-y-mirror', (0x99, 0x3c, 0x10), 0x1040, 0x44)
    low.emit(0xa9, 0x50)
    low.write('pointer-low', (0x85, 0x10), 0x10, 0x50)
    low.emit(0xa9, 0x18)
    low.write('pointer-high', (0x85, 0x11), 0x11, 0x18)
    low.emit(0xa2, 4, 0xa9, 0x55)
    low.write('sta-indexed-indirect', (0x81, 0x0c), 0x1850, 0x55)
    low.emit(0xa0, 3, 0xa9, 0x66)
    low.write('sta-indirect-indexed', (0x91, 0x10), 0x1853, 0x66)
    low.emit(0xa2, 2, 0xa9, 0x77)
    low.write('sta-absolute-x-mirror', (0x9d, 0x3e, 0x08), 0x0840, 0x77)
    low.emit(0xa0, 0x88)
    low.write('sty-zp', (0x84, 0x41), 0x41, 0x88)
    low.emit(0xa2, 0x99)
    low.write('stx-absolute-mirror', (0x8e, 0x42, 0x08), 0x0842, 0x99)
    low.emit(0xa2, 2)
    low.write('sty-zp-x', (0x94, 0x3f), 0x41, 0x88)
    low.emit(0xa0, 4, 0xa2, 0x99)
    low.write('stx-zp-y', (0x96, 0x3e), 0x42, 0x99)
    low.emit(0xa9, 0x0f)
    low.write('rmw-initial', (0x85, 0x43), 0x43, 0x0f)
    # JSNES models the 6502 old-value dummy write and final RMW write.
    low.write('inc-zp', (0xe6, 0x43), 0x43, 0x0f, 0x10)
    low.write('dec-absolute-mirror', (0xce, 0x43, 0x08), 0x0843, 0x10, 0x0f)
    low.write('asl-zp', (0x06, 0x43), 0x43, 0x0f, 0x1e)
    low.write('lsr-absolute-mirror', (0x4e, 0x43, 0x10), 0x1043, 0x1e, 0x0f)
    low.emit(0x18)
    low.write('rol-zp', (0x26, 0x43), 0x43, 0x0f, 0x1e)
    low.emit(0x38)
    low.write('ror-absolute-mirror', (0x6e, 0x43, 0x18), 0x1843, 0x1e, 0x8f)
    low.emit(0xa9, 0xa5)
    low.write('pha', (0x48,), 0x1ff, 0xa5)
    low.emit(0x68)  # PLA restores SP.
    jsr_pc = low.pc
    low.absolute(0x20, 'bank-one-writer')
    # JSR's two direct stack writes have the JSR instruction's PC.
    for address, value in [(0x1ff, (jsr_pc + 2) >> 8), (0x1fe, (jsr_pc + 2) & 255)]:
        low.writes.append({'name': 'jsr-stack', 'writerPc': jsr_pc, 'opcode': 0x20,
                           'logicalAddress': address, 'address': address, 'value': value,
                           'physicalBank': 0, 'prgOffset': jsr_pc - 0x8000,
                           'bankOffset': jsr_pc - 0x8000})
    high.label('bank-one-writer')
    high.emit(0xa9, 0xab)
    high.write('bank-one-sta-zp', (0x85, 0x40), 0x40, 0xab)
    high.emit(0xa9, 0xcd)
    high.write('bank-one-pha', (0x48,), 0x1fd, 0xcd)
    high.emit(0x68, 0x60)
    low.emit(0xa9, 1)
    low.write('oracle-complete', (0x85, 0x7f), 0x7f, 1)
    # Ordinary video/audio exercise follows the exact instruction oracle phase.
    low.emit(0xa9, 0)
    for address in [0x2000, 0x2001, 0x4010, 0x4015]:
        low.emit(0x8d, address & 255, address >> 8)
    for label in ['vblank-one', 'vblank-two']:
        low.label(label)
        low.emit(0x2c, 2, 0x20)
        low.branch(0x10, label)
    low.emit(0xa9, 0x3f, 0x8d, 6, 0x20, 0xa9, 0, 0x8d, 6, 0x20, 0xa2, 0)
    low.label('palette-loop')
    low.absolute(0xbd, 'palette')
    low.emit(0x8d, 7, 0x20, 0xe8, 0xe0, 32)
    low.branch(0xd0, 'palette-loop')
    low.emit(0xa9, 0x20, 0x8d, 6, 0x20, 0xa9, 0, 0x8d, 6, 0x20, 0xa0, 4, 0xa2, 0)
    low.label('nametable-loop')
    low.emit(0xa9, 1, 0x8d, 7, 0x20, 0xe8)
    low.branch(0xd0, 'nametable-loop')
    low.emit(0x88)
    low.branch(0xd0, 'nametable-loop')
    for address, value in [(0x2005, 0), (0x2005, 0), (0x2001, 0x0a),
                           (0x4015, 1), (0x4000, 0xbf), (0x4002, 0xfd), (0x4003, 8)]:
        low.emit(0xa9, value, 0x8d, address & 255, address >> 8)
    low.label('frame')
    low.emit(0x2c, 2, 0x20)
    low.branch(0x10, 'frame')
    low.emit(0xe6, 0x60, 0xa9, 1, 0x8d, 0x16, 0x40, 0xa9, 0, 0x8d, 0x16, 0x40)
    low.emit(0xad, 0x16, 0x40, 0x29, 1)
    low.branch(0xf0, 'neutral')
    low.emit(0xe6, 0x40)
    low.label('neutral')
    low.emit(0xa9, 0x3f, 0x8d, 6, 0x20, 0xa9, 1, 0x8d, 6, 0x20,
             0xa5, 0x60, 0x29, 0x0f, 0x09, 0x20, 0x8d, 7, 0x20,
             0xa9, 0, 0x8d, 5, 0x20, 0x8d, 5, 0x20)
    low.absolute(0x4c, 'frame')
    low.label('interrupt')
    low.emit(0x40)
    low.label('palette')
    low.emit(*([0x0f, 0x21, 0x12, 0x30] * 8))
    low.finish(high.labels)
    high.finish(low.labels)
    assert len(low.code) < 0x4000 and len(high.code) < 0x3ffa
    prg = bytearray([0xea] * 32768)
    prg[:len(low.code)] = low.code
    prg[0x4000:0x4000 + len(high.code)] = high.code
    for offset, label in [(0x7ffa, 'interrupt'), (0x7ffc, 'reset'), (0x7ffe, 'interrupt')]:
        prg[offset:offset + 2] = low.labels[label].to_bytes(2, 'little')
    chr_data = bytearray(8192)
    chr_data[16:24] = bytes([0xff, 0x81, 0x99, 0xa5, 0xa5, 0x99, 0x81, 0xff])
    rom = b'NES\x1a' + bytes([2, 1, 0, 0]) + bytes(8) + prg + chr_data
    # Put callee writes between the JSR stack and post-return marker.
    expected = low.writes[:-1] + high.writes + low.writes[-1:]
    oracle = {'type': 'gu-nes-writer-oracle', 'version': 1, 'license': 'MIT',
              'mapper': 0, 'prgBanks16KiB': 2, 'doneAddress': 0x7f, 'doneValue': 1,
              'expectedWrites': expected, 'interruptPc': low.labels['interrupt'],
              'loopPc': low.labels['frame'], 'watchpoints': sorted({item['address'] for item in expected})}
    return rom, oracle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--oracle-out', type=Path, required=True)
    args = parser.parse_args()
    rom, oracle = generate()
    descriptor = {'name': 'GU original NES writer fixture', 'license': 'MIT',
                  'author': 'GU contributors', 'sha256': hashlib.sha256(rom).hexdigest(),
                  'base64': base64.b64encode(rom).decode()}
    args.out.write_text(json.dumps(descriptor) + '\n')
    args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')


if __name__ == '__main__':
    main()
