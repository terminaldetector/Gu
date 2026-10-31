#!/usr/bin/env python3
"""Fourth independent MIT NES fixture family: single-transition discrimination.

S11A asks whether a field that changes ONCE can be taken to have a constant
step. That question has two opposite right answers, and no earlier family
contains either case, so a rule tested only on them could not be wrong in a
visible way. This family supplies both, on one cartridge:

  oneShotSwitch   a byte that flips from one value to another the first time a
                  button is pressed, and never moves again however long the
                  observation runs. It is NOT a resource: nothing depends on it,
                  the flip is a latch. Typing it as a constant-step decreasing
                  field is a FALSE TYPING, and a rule that rejects it is right.

  singleUnit      a genuine resource with exactly ONE unit. Pressing the cost
                  button takes it from 1 to 0, play stops there, and no horizon
                  can ever show a second transition because there is no second
                  unit to spend. Rejecting it is a LOST USEFUL CANDIDATE, and a
                  rule that rejects it is wrong - correctly, unavoidably wrong,
                  which is exactly what has to be measured rather than hidden.

So a transition-support rule cannot score well on both. The oracle below states
which is which, closed, and is emitted only to a test-only path.
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
    rng = random.Random(0x7A1 + seed)
    taken = set()

    def allocate(width):
        # A third disjoint region, so a layout here cannot coincide with either
        # of the earlier families by accident.
        candidates = list(range(0x60, 0xC0 - width))
        rng.shuffle(candidates)
        for base in candidates:
            region = set(range(base, base + width))
            if not region & taken:
                taken.update(region)
                return base
        raise AssertionError('no room for a field of width %d' % width)

    switch_from, switch_to = 0x5A, 0x13      # one flip, a latch, never a counter
    fields = {
        'oneShotSwitch': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'singleUnit': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'score': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'frameCounter': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        'noise': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
    }
    addr = lambda name: fields[name]['address']

    latch = [0, 1, 7][seed % 3]          # flips oneShotSwitch, once
    spend = [2, 3, 6][(seed // 3) % 3]   # spends the single unit, once
    play = 4                             # raises score while the unit remains

    asm = Assembler()
    writers = {}

    def writer(name):
        label = asm.fresh('writer_' + name)
        asm.label(label)
        writers.setdefault(name, []).append(label)

    def conditional_jump(address, target, when_zero=True):
        skip = asm.fresh('conditional')
        asm.zp(0xA5, address)
        asm.branch(0xD0 if when_zero else 0xF0, skip)
        asm.jump(target)
        asm.label(skip)

    def edge(index, action):
        done = asm.fresh('edge_done')
        conditional_jump(0x10 + index, done, True)     # not pressed now
        conditional_jump(0x20 + index, done, False)    # was pressed last frame
        action()
        asm.label(done)

    asm.label('reset')
    asm.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)            # sei, cld, ldx #$ff, txs
    for address, value in [(addr('oneShotSwitch'), switch_from),
                           (addr('singleUnit'), 1),
                           (addr('score'), 0),
                           (addr('noise'), 0),
                           (addr('frameCounter'), 0),
                           (addr('frameCounter') + 1, 0)]:
        asm.lda(value)
        asm.sta(address)
    for index in range(8):
        asm.lda(0)
        asm.sta(0x10 + index)
        asm.sta(0x20 + index)

    asm.label('loop')
    # ---- read the controller into 0x10..0x17, previous state into 0x20..0x27
    for index in range(8):
        asm.zp(0xA5, 0x10 + index)
        asm.zp(0x85, 0x20 + index)
    asm.lda(0x01)
    asm.sta(0x4016)
    asm.lda(0x00)
    asm.sta(0x4016)
    for index in range(8):
        asm.emit(0xAD, 0x16, 0x40)                    # lda $4016
        asm.emit(0x29, 0x01)                          # and #$01
        asm.zp(0x85, 0x10 + index)

    # ---- frameCounter: a free-running 16-bit timer, the usual decoy
    writer('frameCounter')
    asm.zp(0xE6, addr('frameCounter'))
    skip_carry = asm.fresh('no_carry')
    asm.branch(0xD0, skip_carry)
    asm.zp(0xE6, addr('frameCounter') + 1)
    asm.label(skip_carry)

    # ---- oneShotSwitch: flips once on the first press of `latch`, then latched
    def flip_switch():
        done = asm.fresh('already_flipped')
        asm.zp(0xA5, addr('oneShotSwitch'))
        asm.emit(0xC9, switch_to)                     # cmp #switch_to
        asm.branch(0xF0, done)                        # already flipped: nothing
        writer('oneShotSwitch')
        asm.lda(switch_to)
        asm.sta(addr('oneShotSwitch'))
        asm.label(done)
    edge(latch, flip_switch)

    # ---- singleUnit: one unit, spent once; play stops when it is gone
    def spend_unit():
        done = asm.fresh('nothing_left')
        asm.zp(0xA5, addr('singleUnit'))
        asm.branch(0xF0, done)                        # already zero
        writer('singleUnit')
        asm.lda(0)
        asm.sta(addr('singleUnit'))
        asm.label(done)
    edge(spend, spend_unit)

    def raise_score():
        done = asm.fresh('no_play')
        asm.zp(0xA5, addr('singleUnit'))
        asm.branch(0xF0, done)                        # the unit is spent: play stops
        writer('score')
        asm.zp(0xE6, addr('score'))
        asm.label(done)
    edge(play, raise_score)

    asm.jump('loop')
    asm.label('interrupt')
    asm.emit(0x40)                                    # rti

    code = asm.finish()
    assert len(code) < 0x3FFA
    prg = bytearray([0xEA] * 16384)
    prg[:len(code)] = code
    for offset, label in [(0x3FFA, 'interrupt'), (0x3FFC, 'reset'), (0x3FFE, 'interrupt')]:
        prg[offset:offset + 2] = (0x8000 + asm.labels[label]).to_bytes(2, 'little')
    chr_data = bytearray(8192)
    chr_data[16:24] = bytes([0xFF, 0x81, 0xBD, 0xA5, 0xA5, 0xBD, 0x81, 0xFF])
    rom = b'NES\x1A' + bytes([1, 1, 0, 0]) + bytes(8) + prg + chr_data
    oracle = {
        'type': 'agod-transition-oracle', 'version': 1, 'seed': seed,
        'family': 'single-transition',
        'fields': fields,
        'latchMask': 1 << latch, 'spendMask': 1 << spend, 'playMask': 1 << play,
        'switchFrom': switch_from, 'switchTo': switch_to,
        'echoAddresses': list(range(0x10, 0x18)),
        # Closed labels: which single transition is spurious and which is real.
        'transitionLabels': {
            'oneShotSwitch': {
                'transitionsAvailable': 1,
                'isResource': False,
                'rejectingItIs': 'CORRECT',
                'why': 'a latch: it flips once on the first press and never moves again, nothing '
                       'reads it, and no horizon can produce a second transition because there is '
                       'no mechanism to produce one. Typing it as a constant-step resource is a '
                       'false typing.',
            },
            'singleUnit': {
                'transitionsAvailable': 1,
                'isResource': True,
                'rejectingItIs': 'A LOST USEFUL CANDIDATE',
                'why': 'a genuine resource with exactly one unit. Spending it stops play, which is '
                       'the terminal structure NEGATIVE looks for, and no horizon can ever show a '
                       'second transition because there is no second unit. Any rule that demands '
                       'two transitions must lose this field, and that cost has to be measured '
                       'rather than hidden.',
            },
        },
        'writerSites': {name: [{'pc': 0x8000 + asm.labels[label], 'bank': 0,
                                'prgOffset': asm.labels[label]} for label in sites]
                        for name, sites in writers.items()},
    }
    return rom, oracle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--oracle-out', type=Path, help='checker-only metadata; never load into analyser')
    args = parser.parse_args()
    rom, oracle = generate(args.seed)
    output = {'name': 'GU AGOD single-transition fixture', 'license': 'MIT',
              'author': 'GU contributors',
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
