#!/usr/bin/env python3
"""Second, independent MIT NES fixture family: sacrifice, not survival.

The first family (make_agod_test_rom.py) encodes survival: an action drains
lives, the floor is death, and play stops there. Every mechanism built against
it learned that shape. This family inverts the meaning while keeping the
observable *form* identical, which is the point:

  - a charge must be SPENT to make progress, and progress scales the gain;
  - the floor of the resource is COMPLETION, not death: the act button stops
    working because there is nothing left to do;
  - restarting refills the charges and keeps the treasure, so the terminal
    state is reversible and reaching it again is useful.

So the chain E4 requires for NEGATIVE - monotone decrease, a floor, and
previously confirmed effects ceasing at the floor - is fully present here, on an
action that is *required* for progress. Any mechanism that reads that chain as
"this action is harmful" is wrong on this cartridge, and that is what it is for.

The oracle is emitted only to a test-only path and carries the closed judgement
labels. No analyser, pipeline or agent may read it.
"""
import argparse
import base64
import hashlib
import json
import random
import sys
from pathlib import Path

SPRITE = 0x00      # sprite X, mirrors activity like the first family does
TEMP = 0x01        # scratch for the multi-byte add


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
    rng = random.Random(0x5AC + seed)
    taken = set()

    def allocate(width):
        # Allocated from the top of the usable page downwards, so a layout from
        # this family never coincides with one from the first family by accident.
        candidates = list(range(0xD0 - width, 0x40, -1))
        rng.shuffle(candidates)
        for base in candidates:
            region = set(range(base, base + width))
            if not region & taken:
                taken.update(region)
                return base
        raise AssertionError('no room for a field of width %d' % width)

    treasure_width = 1 + seed % 3
    treasure_endian = 'big' if (seed // 2) % 2 else 'little'
    charges_start = 3
    treasure = allocate(treasure_width)
    fields = {
        'treasure': {'address': treasure, 'width': treasure_width,
                     'format': 'unsigned', 'endian': treasure_endian},
        'charges': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'progress': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'gate': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'frameCounter': {'address': allocate(4), 'width': 4, 'format': 'unsigned', 'endian': 'little'},
        'timer': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'ledgerDecoy': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        'noise': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
    }
    addr = lambda name: fields[name]['address']

    # Button wiring is drawn from index sets disjoint from the first family's,
    # so no mechanism can carry a learned button over between the two.
    spend = [2, 3, 6][seed % 3]
    act = [0, 1, 7][(seed // 3) % 3]
    restart = 4
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

    def binary_increment(name, address, count, byteorder='little'):
        done = asm.fresh('increment_done')
        order = list(range(count)) if byteorder == 'little' else list(reversed(range(count)))
        for index in order:
            writer(name)
            asm.zp(0xE6, address + index)
            asm.branch(0xD0, done)
        asm.label(done)

    def add_progress_to_treasure():
        """treasure += progress + 1, so the act button always does something and
        does more once charges have been spent."""
        asm.zp(0xA5, addr('progress'))
        asm.emit(0x18, 0x69, 1)          # CLC, ADC #1
        asm.zp(0x85, TEMP)
        done = asm.fresh('treasure_done')
        order = (list(range(treasure_width)) if treasure_endian == 'little'
                 else list(reversed(range(treasure_width))))
        asm.zp(0xA5, treasure + order[0])
        asm.emit(0x18)                   # CLC
        asm.zp(0x65, TEMP)               # ADC TEMP
        writer('treasure')
        asm.zp(0x85, treasure + order[0])
        asm.branch(0x90, done)           # BCC: no carry, finished
        for index in order[1:]:
            writer('treasure')
            asm.zp(0xE6, treasure + index)
            asm.branch(0xD0, done)
        asm.label(done)

    asm.label('reset')
    asm.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)
    asm.lda(0)
    for address in [0x2000, 0x2001, 0x4010, 0x4015]:
        asm.sta(address)
    asm.emit(0xA2, 0)
    asm.label('clear_ram')
    asm.emit(0x95, 0, 0xE8)
    asm.branch(0xD0, 'clear_ram')
    for name, value in [('charges', charges_start), ('timer', 75), ('noise', 3 + seed % 250)]:
        asm.lda(value)
        asm.zp(0x85, addr(name))
    asm.lda(96)
    asm.zp(0x85, SPRITE)
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
    for address, value in [(0x0200, 108), (0x0201, 2), (0x0202, 0), (0x0203, 96)]:
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

    # Time-driven distractors: none of them is caused by any action.
    binary_increment('frameCounter', addr('frameCounter'), 4)
    asm.zp(0xC6, addr('timer'))
    timer_done = asm.fresh('timer_done')
    asm.branch(0xD0, timer_done)
    asm.lda(75)
    asm.zp(0x85, addr('timer'))
    asm.label(timer_done)
    asm.zp(0xA5, addr('noise'))
    asm.emit(0x0A)
    noise_done = asm.fresh('noise_done')
    asm.branch(0x90, noise_done)
    asm.emit(0x49, 0x2B)
    asm.label(noise_done)
    asm.zp(0x85, addr('noise'))
    asm.zp(0xA5, addr('frameCounter'))
    asm.emit(0x29, 15)
    decoy_done = asm.fresh('decoy_done')
    asm.branch(0xD0, decoy_done)
    binary_increment('ledgerDecoy', addr('ledgerDecoy'), 2)
    asm.label(decoy_done)

    def spend_event():
        """Spending a charge is how progress is made. At zero the run is
        complete, which is what closes the gate."""
        done = asm.fresh('spend_done')
        asm.zp(0xA5, addr('charges'))
        asm.branch(0xF0, done)           # no charges left: nothing happens
        writer('charges')
        asm.zp(0xC6, addr('charges'))
        writer('progress')
        asm.zp(0xE6, addr('progress'))
        asm.zp(0xA5, addr('charges'))
        asm.branch(0xD0, done)
        asm.lda(1)
        writer('gate')
        asm.zp(0x85, addr('gate'))       # completion
        asm.label(done)
        asm.lda(120)
        asm.zp(0x85, SPRITE)

    def act_event():
        """Worth more the more charges have been spent, and worth nothing once
        the run is complete."""
        done = asm.fresh('act_done')
        asm.zp(0xA5, addr('gate'))
        asm.branch(0xD0, done)           # complete: the act button is inert
        add_progress_to_treasure()
        asm.zp(0xA5, SPRITE)
        asm.emit(0x18, 0x69, 5)
        asm.zp(0x85, SPRITE)
        asm.label(done)

    def restart_event():
        """Refills the charges and clears the gate, and deliberately KEEPS the
        treasure: going round again is useful, so the floor is not an ending."""
        asm.lda(charges_start)
        writer('charges')
        asm.zp(0x85, addr('charges'))
        asm.lda(0)
        writer('progress')
        asm.zp(0x85, addr('progress'))
        writer('gate')
        asm.zp(0x85, addr('gate'))
        asm.lda(96)
        asm.zp(0x85, SPRITE)

    edge(spend, spend_event)
    edge(act, act_event)
    edge(restart, restart_event)

    asm.label('output')
    asm.zp(0xA5, SPRITE)
    asm.sta(0x0203)
    asm.lda(2)
    asm.sta(0x4014)
    asm.lda(0x3F)
    asm.sta(0x2006)
    asm.lda(1)
    asm.sta(0x2006)
    asm.zp(0xA5, addr('gate'))
    asm.emit(0x0A, 0x18, 0x69, 0x24)
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
    asm.emit(*([0x0F, 0x29, 0x19, 0x30] * 4 + [0x0F, 0x14, 0x30, 0x29] * 4))

    code = asm.finish()
    assert len(code) < 0x3FFA
    prg = bytearray([0xEA] * 16384)
    prg[:len(code)] = code
    for offset, label in [(0x3FFA, 'interrupt'), (0x3FFC, 'reset'), (0x3FFE, 'interrupt')]:
        prg[offset:offset + 2] = (0x8000 + asm.labels[label]).to_bytes(2, 'little')
    chr_data = bytearray(8192)
    chr_data[16:24] = bytes([0xFF, 0x81, 0xBD, 0xA5, 0xA5, 0xBD, 0x81, 0xFF])
    chr_data[32:40] = bytes([0x3C, 0x42, 0x99, 0xA5, 0xA5, 0x99, 0x42, 0x3C])
    rom = b'NES\x1A' + bytes([1, 1, 0, 0]) + bytes(8) + prg + chr_data
    oracle = {
        'type': 'agod-sacrifice-oracle', 'version': 1, 'seed': seed,
        'family': 'sacrifice',
        'fields': fields,
        'chargesStart': charges_start,
        'spendMask': 1 << spend, 'actMask': 1 << act, 'restartMask': 1 << restart,
        'echoAddresses': list(range(0x10, 0x18)),
        # Closed judgement labels. These are the answers, not observations.
        'judgement': {
            'resourceField': 'charges',
            'terminalResourceDepletion': True,
            'negativeGameReward': False,
            'why': 'spending every charge is the only way to raise progress, progress scales the '
                   'gain of the act button, the floor is completion rather than death, and '
                   'restarting refills the charges while keeping the treasure',
            'coupledGainField': 'progress',
            'requiredForProgress': 'spendMask',
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
    output = {'name': 'GU AGOD sacrifice fixture', 'license': 'MIT', 'author': 'GU contributors',
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
