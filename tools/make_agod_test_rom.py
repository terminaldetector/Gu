#!/usr/bin/env python3
"""Original MIT NES discovery fixture; oracle is emitted only to a test-only path.

The production analyser receives ROM bytes and ordinary emulator observations.
It must never import this module or the independently requested oracle metadata.
"""
import argparse
import base64
import hashlib
import json
import random
import sys
from pathlib import Path


class Assembler:
    def __init__(self):
        self.code = bytearray()
        self.labels = {}
        self.patches = []
        self.serial = 0

    def emit(self, *values):
        self.code.extend(values)

    def label(self, name):
        assert name not in self.labels, name
        self.labels[name] = len(self.code)

    def fresh(self, prefix):
        self.serial += 1
        return f'{prefix}_{self.serial}'

    def branch(self, opcode, name):
        self.emit(opcode, 0)
        self.patches.append((len(self.code) - 1, name, True))

    def jump(self, name):
        self.emit(0x4C, 0, 0)
        self.patches.append((len(self.code) - 2, name, False))

    def lda(self, value):
        self.emit(0xA9, value)

    def sta(self, address):
        self.emit(0x8D, address & 255, address >> 8)

    def zp(self, opcode, address):
        self.emit(opcode, address)

    def conditional_jump(self, address, target, when_zero=True):
        skip = self.fresh('conditional')
        self.zp(0xA5, address)
        self.branch(0xD0 if when_zero else 0xF0, skip)
        self.jump(target)
        self.label(skip)

    def finish(self):
        for offset, name, relative in self.patches:
            if relative:
                delta = self.labels[name] - (offset + 1)
                assert -128 <= delta <= 127, (name, delta)
                self.code[offset] = delta & 255
            else:
                self.code[offset:offset + 2] = (0x8000 + self.labels[name]).to_bytes(2, 'little')
        return self.code


def generate(seed=1):
    rng = random.Random(seed)
    used = set(range(0x40))

    def allocate(width):
        addresses = list(range(0x40, 0xE0 - width))
        rng.shuffle(addresses)
        for base in addresses:
            region = set(range(base, base + width))
            if not region & used:
                used.update(region)
                return base
        raise AssertionError('fixture RAM allocation exhausted')

    fmt = ['unsigned', 'bcd', 'signed'][seed % 3]
    width = 1 + seed % 4
    endian = 'big' if seed % 2 else 'little'
    score = allocate(width)
    fields = {
        'score': {'address': score, 'width': width, 'format': fmt, 'endian': endian},
        'lives': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'level': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'frameCounter': {'address': allocate(4), 'width': 4, 'format': 'unsigned', 'endian': 'little'},
        'timer': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'highScoreDecoy': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        'noise': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'menu': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'respawn': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
    }
    addr = lambda name: fields[name]['address']
    positive = [0, 4, 7][seed % 3]  # A / Up / Right; serial controller indices.
    negative = [1, 5, 6][(seed // 3) % 3]
    asm = Assembler()
    writers = {}

    def writer(name):
        label = asm.fresh('writer_' + name)
        asm.label(label)
        writers.setdefault(name, []).append(label)

    def binary_increment(name, address, count, byteorder='little'):
        done = asm.fresh('increment_done')
        order = list(range(count)) if byteorder == 'little' else list(reversed(range(count)))
        for index in order:
            writer(name)
            asm.zp(0xE6, address + index)
            asm.branch(0xD0, done)
        asm.label(done)

    def score_increment():
        if fmt != 'bcd':
            binary_increment('score', score, width, endian)
            return
        done = asm.fresh('bcd_done')
        order = list(range(width)) if endian == 'little' else list(reversed(range(width)))
        for index in order:
            address = score + index
            asm.zp(0xA5, address)
            asm.emit(0x18, 0x69, 1)
            writer('score')
            asm.zp(0x85, address)
            asm.emit(0x29, 15, 0xC9, 10)
            asm.branch(0x90, done)
            asm.zp(0xA5, address)
            asm.emit(0x18, 0x69, 6)
            writer('score')
            asm.zp(0x85, address)
            asm.emit(0xC9, 0xA0)
            asm.branch(0x90, done)
            asm.lda(0)
            writer('score')
            asm.zp(0x85, address)
        asm.label(done)

    def edge(index, action):
        done = asm.fresh('edge_done')
        asm.conditional_jump(0x10 + index, done, True)
        asm.conditional_jump(0x20 + index, done, False)
        action()
        asm.label(done)

    asm.label('reset')
    asm.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)  # SEI, CLD, LDX #$ff, TXS.
    asm.lda(0)
    for address in [0x2000, 0x2001, 0x4010, 0x4015]:
        asm.sta(address)
    asm.emit(0xA2, 0)
    asm.label('clear_ram')
    asm.emit(0x95, 0, 0xE8)
    asm.branch(0xD0, 'clear_ram')
    for name, value in [('lives', 3), ('level', 1), ('timer', 90), ('noise', 1 + seed % 254)]:
        asm.lda(value)
        asm.zp(0x85, addr(name))
    initial_score = -5 if fmt == 'signed' else 9 if fmt == 'bcd' else 250
    initial_bytes = initial_score.to_bytes(width, endian, signed=fmt == 'signed')
    for index, value in enumerate(initial_bytes):
        asm.lda(value)
        asm.zp(0x85, score + index)
    asm.lda(112)
    asm.zp(0x85, 0)
    for name in ['vblank1', 'vblank2']:
        asm.label(name)
        asm.emit(0x2C, 2, 0x20)
        asm.branch(0x10, name)
    asm.lda(0x3F)
    asm.sta(0x2006)
    asm.lda(0)
    asm.sta(0x2006)
    asm.emit(0xA2, 0)
    asm.label('palette_loop')
    asm.emit(0xBD, 0, 0)
    asm.patches.append((len(asm.code) - 2, 'palette', False))
    asm.sta(0x2007)
    asm.emit(0xE8, 0xE0, 32)
    asm.branch(0xD0, 'palette_loop')
    asm.lda(0x20)
    asm.sta(0x2006)
    asm.lda(0)
    asm.sta(0x2006)
    asm.emit(0xA0, 4, 0xA2, 0)
    asm.label('nametable_loop')
    asm.lda(1)
    asm.sta(0x2007)
    asm.emit(0xE8)
    asm.branch(0xD0, 'nametable_loop')
    asm.emit(0x88)
    asm.branch(0xD0, 'nametable_loop')
    asm.emit(0xA2, 0)
    asm.lda(255)
    asm.label('hide_sprites')
    asm.emit(0x9D, 0, 2, 0xE8)
    asm.branch(0xD0, 'hide_sprites')
    for address, value in [(0x0200, 100), (0x0201, 2), (0x0202, 0), (0x0203, 112)]:
        asm.lda(value)
        asm.sta(address)
    asm.lda(0)
    asm.sta(0x2005)
    asm.sta(0x2005)
    asm.lda(0x1E)
    asm.sta(0x2001)
    asm.label('frame')
    asm.emit(0x2C, 2, 0x20)
    asm.branch(0x10, 'frame')
    asm.lda(1)
    asm.sta(0x4016)
    asm.lda(0)
    asm.sta(0x4016)
    for index in range(8):
        asm.emit(0xAD, 0x16, 0x40, 0x29, 1, 0x85, 0x10 + index)
    binary_increment('frameCounter', addr('frameCounter'), 4)
    asm.zp(0xC6, addr('timer'))
    timer_done = asm.fresh('timer_done')
    asm.branch(0xD0, timer_done)
    asm.lda(90)
    asm.zp(0x85, addr('timer'))
    asm.label(timer_done)
    asm.zp(0xA5, addr('noise'))
    asm.emit(0x0A)
    noise_done = asm.fresh('noise_done')
    asm.branch(0x90, noise_done)
    asm.emit(0x49, 0x1D)
    asm.label(noise_done)
    asm.zp(0x85, addr('noise'))
    asm.zp(0xA5, addr('frameCounter'))
    asm.emit(0x29, 7)
    decoy_done = asm.fresh('decoy_done')
    asm.branch(0xD0, decoy_done)
    binary_increment('highScoreDecoy', addr('highScoreDecoy'), 2)
    asm.label(decoy_done)

    def toggle_menu():
        asm.zp(0xA5, addr('menu'))
        asm.emit(0x49, 1)
        asm.zp(0x85, addr('menu'))

    def game_reset():
        asm.lda(3)
        writer('lives')
        asm.zp(0x85, addr('lives'))
        asm.lda(0)
        for index in range(width):
            writer('score')
            asm.zp(0x85, score + index)
        asm.zp(0x85, addr('menu'))
        asm.zp(0x85, addr('respawn'))

    edge(3, toggle_menu)
    edge(2, game_reset)
    asm.conditional_jump(addr('menu'), 'output', False)
    asm.conditional_jump(addr('lives'), 'output', True)
    respawn_done = asm.fresh('respawn_done')
    asm.zp(0xA5, addr('respawn'))
    asm.branch(0xF0, respawn_done)
    asm.zp(0xC6, addr('respawn'))
    asm.jump('output')
    asm.label(respawn_done)

    def positive_event():
        score_increment()
        asm.zp(0xA5, 0)
        asm.emit(0x18, 0x69, 7)
        asm.zp(0x85, 0)

    def negative_event():
        writer('lives')
        asm.zp(0xC6, addr('lives'))
        asm.lda(24)
        asm.zp(0x85, addr('respawn'))
        asm.lda(112)
        asm.zp(0x85, 0)

    def level_event():
        writer('level')
        asm.zp(0xE6, addr('level'))

    edge(positive, positive_event)
    edge(negative, negative_event)
    edge(1 if negative != 1 else 6, level_event)
    asm.label('output')
    asm.zp(0xA5, 0)
    asm.sta(0x0203)
    asm.lda(2)
    asm.sta(0x4014)
    asm.lda(0x3F)
    asm.sta(0x2006)
    asm.lda(1)
    asm.sta(0x2006)
    asm.zp(0xA5, addr('menu'))
    asm.emit(0x0A, 0x18, 0x69, 0x20)
    asm.sta(0x2007)
    asm.lda(0)
    asm.sta(0x2005)
    asm.sta(0x2005)
    for index in range(8):
        asm.zp(0xA5, 0x10 + index)
        asm.zp(0x85, 0x20 + index)
    asm.jump('frame')
    asm.label('interrupt')
    asm.emit(0x40)
    asm.label('palette')
    asm.emit(*([0x0F, 0x21, 0x12, 0x30] * 4 + [0x0F, 0x16, 0x30, 0x21] * 4))
    code = asm.finish()
    assert len(code) < 0x3FFA
    prg = bytearray([0xEA] * 16384)
    prg[:len(code)] = code
    for offset, label in [(0x3FFA, 'interrupt'), (0x3FFC, 'reset'), (0x3FFE, 'interrupt')]:
        prg[offset:offset + 2] = (0x8000 + asm.labels[label]).to_bytes(2, 'little')
    chr_data = bytearray(8192)
    chr_data[16:24] = bytes([0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF])
    chr_data[32:40] = bytes([0x18, 0x3C, 0x7E, 0xDB, 0xFF, 0x7E, 0x24, 0x42])
    rom = b'NES\x1A' + bytes([1, 1, 0, 0]) + bytes(8) + prg + chr_data
    oracle = {'type': 'agod-test-oracle', 'version': 1, 'seed': seed, 'fields': fields, 'initialScore': initial_score,
              'positiveMask': 1 << positive, 'negativeMask': 1 << negative,
              'menuMask': 8, 'resetMask': 4, 'echoAddresses': list(range(0x10, 0x18)),
              'writerSites': {name: [{'pc': 0x8000 + asm.labels[label], 'bank': 0,
                                     'prgOffset': asm.labels[label]} for label in sites]
                              for name, sites in writers.items()}}
    return rom, oracle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--oracle-out', type=Path, help='checker-only metadata; never load into analyser')
    args = parser.parse_args()
    rom, oracle = generate(args.seed)
    output = {'name': 'GU AGOD controlled fixture', 'license': 'MIT', 'author': 'GU contributors',
              'sha256': hashlib.sha256(rom).hexdigest(), 'base64': base64.b64encode(rom).decode()}
    encoded = json.dumps(output) + '\n'
    if args.out:
        args.out.write_text(encoded)
    else:
        sys.stdout.write(encoded)
    if args.oracle_out:
        args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')


if __name__ == '__main__':
    main()
