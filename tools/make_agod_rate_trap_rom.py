#!/usr/bin/env python3
"""Third MIT NES fixture family: two traps aimed at the POSITIVE rule.

S4 proposed a field as provisionally positive when it rose by a constant step,
survived the action that restores the resource, and had a gain rate that changed
between two game states. Sol's review found that the last factor established
context dependence, not which field modulated the rate - and that this one
factor carried every correct proposal. This family is built to attack both ends
of that, with two fields that are deliberately hard:

  steadyGain   genuinely worth having - the cartridge defines a threshold on it,
               and crossing that threshold UNLOCKS a button that did nothing
               before - but its gain rate is CONSTANT. The rate factor can never
               fire on it, so under the S4 rule it is a false negative.

  fickleDecoy  genuinely useless - nothing in the cartridge reads it, no
               threshold, no gating, no effect on play - but its increment is
               (1 + fuel), so it is CAUSALLY rate-modulated by a real
               action-driven field, and it survives the reset. Under the S4 rule
               it is a false positive, and it is designed to stay one even after
               the causality of the modulation is proven, because from inside
               the emulator it is indistinguishable from a field that matters.

The second trap is the point. Proving which field modulates a rate is possible;
proving that a modulated, persisted, monotone quantity is worth pursuing is not,
and this cartridge is the counterexample.

The oracle is emitted only to a test-only path and carries the closed labels.
"""
import argparse
import base64
import hashlib
import json
import random
import sys
from pathlib import Path

SPRITE = 0x00
THRESHOLD = 12


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
    rng = random.Random(0x7A17 + seed)
    taken = set()

    def allocate(width):
        # A third layout rule again: the middle of the page outwards.
        candidates = list(range(0x70, 0xC0 - width)) + list(range(0x6F, 0x40, -1))
        rng.shuffle(candidates)
        for base in candidates:
            region = set(range(base, base + width))
            if not region & taken:
                taken.update(region)
                return base
        raise AssertionError('no room for a field of width %d' % width)

    steady_width = 1 + seed % 2
    fields = {
        'steadyGain': {'address': allocate(steady_width), 'width': steady_width,
                       'format': 'unsigned', 'endian': 'little'},
        'fickleDecoy': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'fuel': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'unlocked': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'bonusCount': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'frameCounter': {'address': allocate(4), 'width': 4, 'format': 'unsigned', 'endian': 'little'},
        'timer': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'noise': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
    }
    addr = lambda name: fields[name]['address']
    steady = addr('steadyGain')

    collect = [0, 1][seed % 2]
    fiddle = [4, 5][seed % 2]
    spend = [6, 7][seed % 2]
    bonus = 3
    reset = 2
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
        conditional_jump(0x10 + index, done, True)
        conditional_jump(0x20 + index, done, False)
        action()
        asm.label(done)

    def binary_increment(name, address, count):
        done = asm.fresh('increment_done')
        for index in range(count):
            writer(name)
            asm.zp(0xE6, address + index)
            asm.branch(0xD0, done)
        asm.label(done)

    asm.label('reset_vector')
    asm.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)
    asm.lda(0)
    for address in [0x2000, 0x2001, 0x4010, 0x4015]:
        asm.sta(address)
    asm.emit(0xA2, 0)
    asm.label('clear_ram')
    asm.emit(0x95, 0, 0xE8)
    asm.branch(0xD0, 'clear_ram')
    for name, value in [('fuel', 3), ('timer', 60), ('noise', 7 + seed % 240)]:
        asm.lda(value)
        asm.zp(0x85, addr(name))
    asm.lda(84)
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
    for address, value in [(0x0200, 112), (0x0201, 2), (0x0202, 0), (0x0203, 84)]:
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
    asm.lda(60)
    asm.zp(0x85, addr('timer'))
    asm.label(timer_done)
    asm.zp(0xA5, addr('noise'))
    asm.emit(0x0A)
    noise_done = asm.fresh('noise_done')
    asm.branch(0x90, noise_done)
    asm.emit(0x49, 0x3B)
    asm.label(noise_done)
    asm.zp(0x85, addr('noise'))

    def collect_event():
        """Constant +1, and crossing the threshold unlocks the bonus button."""
        done = asm.fresh('collect_done')
        asm.zp(0xA5, addr('fuel'))
        asm.branch(0xF0, done)                 # out of fuel: play is suppressed
        binary_increment('steadyGain', steady, steady_width)
        asm.zp(0xA5, steady)                   # low byte is enough for the threshold
        asm.emit(0xC9, THRESHOLD)
        below = asm.fresh('below_threshold')
        asm.branch(0x90, below)                # BCC: still below
        asm.lda(1)
        writer('unlocked')
        asm.zp(0x85, addr('unlocked'))
        asm.label(below)
        asm.zp(0xA5, SPRITE)
        asm.emit(0x18, 0x69, 3)
        asm.zp(0x85, SPRITE)
        asm.label(done)

    def fiddle_event():
        """Increment is 1 + fuel, so the rate really is modulated by a real
        action-driven field. Nothing reads this counter, ever."""
        asm.zp(0xA5, addr('fuel'))
        asm.emit(0x18, 0x69, 1)
        asm.emit(0x18)
        asm.zp(0x65, addr('fickleDecoy'))
        writer('fickleDecoy')
        asm.zp(0x85, addr('fickleDecoy'))

    def spend_event():
        done = asm.fresh('spend_done')
        asm.zp(0xA5, addr('fuel'))
        asm.branch(0xF0, done)
        writer('fuel')
        asm.zp(0xC6, addr('fuel'))
        asm.label(done)

    def bonus_event():
        """Inert until the threshold is crossed: this is the new mode."""
        done = asm.fresh('bonus_done')
        asm.zp(0xA5, addr('unlocked'))
        asm.branch(0xF0, done)
        writer('bonusCount')
        asm.zp(0xE6, addr('bonusCount'))
        asm.label(done)

    def reset_event():
        """Refills the fuel and keeps everything earned, including the decoy."""
        asm.lda(3)
        writer('fuel')
        asm.zp(0x85, addr('fuel'))
        asm.lda(84)
        asm.zp(0x85, SPRITE)

    edge(collect, collect_event)
    edge(fiddle, fiddle_event)
    edge(spend, spend_event)
    edge(bonus, bonus_event)
    edge(reset, reset_event)

    asm.label('output')
    asm.zp(0xA5, SPRITE)
    asm.sta(0x0203)
    asm.lda(2)
    asm.sta(0x4014)
    asm.lda(0x3F)
    asm.sta(0x2006)
    asm.lda(1)
    asm.sta(0x2006)
    asm.zp(0xA5, addr('unlocked'))
    asm.emit(0x0A, 0x18, 0x69, 0x28)
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
    asm.emit(*([0x0F, 0x27, 0x17, 0x30] * 4 + [0x0F, 0x11, 0x30, 0x27] * 4))

    code = asm.finish()
    assert len(code) < 0x3FFA
    prg = bytearray([0xEA] * 16384)
    prg[:len(code)] = code
    for offset, label in [(0x3FFA, 'interrupt'), (0x3FFC, 'reset_vector'), (0x3FFE, 'interrupt')]:
        prg[offset:offset + 2] = (0x8000 + asm.labels[label]).to_bytes(2, 'little')
    chr_data = bytearray(8192)
    chr_data[16:24] = bytes([0xFF, 0x81, 0x99, 0xA5, 0xA5, 0x99, 0x81, 0xFF])
    chr_data[32:40] = bytes([0x7E, 0x81, 0xA5, 0x81, 0xBD, 0x99, 0x42, 0x3C])
    rom = b'NES\x1A' + bytes([1, 1, 0, 0]) + bytes(8) + prg + chr_data
    oracle = {
        'type': 'agod-rate-trap-oracle', 'version': 1, 'seed': seed, 'family': 'rate-trap',
        'fields': fields, 'threshold': THRESHOLD,
        'collectMask': 1 << collect, 'fiddleMask': 1 << fiddle, 'spendMask': 1 << spend,
        'bonusMask': 1 << bonus, 'resetMask': 1 << reset,
        'echoAddresses': list(range(0x10, 0x18)),
        'positiveLabel': {
            'anyFieldDemonstrablyBeneficial': True,
            'field': 'steadyGain',
            'why': 'the cartridge defines a threshold on steadyGain, and crossing it unlocks a '
                   'button that was inert before, so more of it demonstrably changes what the '
                   'player can do. Its gain rate is constant, which is the trap.',
            'instrumental': ['unlocked', 'bonusCount'],
            'resource': 'fuel',
            'notPositive': ['fickleDecoy', 'fuel', 'timer', 'frameCounter', 'noise'],
        },
        'traps': {
            'falseNegativeUnderS4Rule': {
                'field': 'steadyGain',
                'why': 'beneficial but its gain rate never changes, so a rule that requires rate '
                       'modulation must miss it',
            },
            'falsePositiveUnderS4Rule': {
                'field': 'fickleDecoy',
                'why': 'useless, yet monotone, persisted across the reset, and genuinely causally '
                       'rate-modulated by fuel. It is designed to remain a false positive even '
                       'after the causality of the modulation is proven, because nothing inside '
                       'the emulator distinguishes it from a quantity that matters.',
                'expectedToRemainUnsolvableFromInside': True,
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
    output = {'name': 'GU AGOD rate-trap fixture', 'license': 'MIT', 'author': 'GU contributors',
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
