#!/usr/bin/env python3
"""Fifth independent MIT NES fixture family: what the probe can and cannot resolve.

Two instrument questions on one cartridge: a field with two causes at once
(R4 / A4), and a change too short for the sampling grid to see (R5 / A5).

S11B-R / R4 (specification A4). The phase-leak indicator
`confirmedThatNeutralAlsoMoved` asks whether the neutral arm moved an address
the probe went on to confirm. On every earlier fixture family that question has
one answer, because every field is either time-driven or action-driven and never
both. On such a corpus the indicator looks like proof: whenever it fires, the
confirmation really is an artefact. That is a property of the corpus, not of the
indicator, and a corpus that cannot distinguish the two is why the distinction
was never forced.

This family supplies the missing case:

  timeAndAction   a counter that advances on its own every N game iterations
                  AND is decremented by a button. It moves in the neutral arm,
                  so the indicator fires. It is also genuinely caused by the
                  action. Recording it as a false causal event is WRONG - and
                  it is exactly what a rule that reads the indicator as proof
                  would do.

  pureTime        advances on its own only. Confirming it is a FALSE
                  CONFIRMATION; the indicator firing here is right.

  pureAction      moves on the button only, never by itself. The indicator must
                  NOT fire here; if it does, the neutral trajectory is leaking.

  slowTime        advances on its own much more slowly, so that at a short
                  horizon it does not move at all and at a long one it does.
                  It separates "the field is time-driven" from "the horizon was
                  long enough to see it".

  cadenceOnly     a resource that steps down once every K press edges, and is
                  moved by nothing else. A continuous hold of ANY duration
                  produces exactly ONE press edge, so it can never move this
                  field; a pulse train of K or more pulses does. Its ground
                  truth is therefore "action structure, not duration" - the
                  positive control the cadence series never had. B = 0 on the
                  pre-registered corpus could not be told apart from an
                  instrument unable to see cadence at all without it.

                  timeAndAction is NOT that control: its action half fires on
                  every edge, so the single edge of a continuous hold already
                  moves it and the train adds nothing qualitative. Measured:
                  confirmed under both structures at all five horizons, so
                  "confirmed under the train only" was empty by construction.

  transientPulse  R5 / A5. A byte that is raised on a press edge and cleared
                  again a couple of frames later, entirely inside one sampling
                  interval. The probe samples every 12 frames, so neither the
                  endpoint nor any intermediate snapshot ever sees it: the
                  honest verdict is NO_CHANGE_AT_SAMPLED_POINTS, never
                  NO_EVENT_IN_HORIZON. The event is real, it is caused by the
                  action, and the instrument cannot see it. A fixture is the
                  only way to tell that apart from a field that truly never
                  moves, and without one the corrected label is a wording
                  change rather than a measurement.

                  transientWitness counts how many times transientPulse has
                  been raised. It is NOT part of the sampling question: it
                  exists so a test can prove the transient really happened
                  during a window in which the probe saw nothing, rather than
                  asserting it.

The three labels together make the indicator falsifiable in both directions:
pureAction catches a leak, pureTime catches a miss, and timeAndAction catches
the inference that the indicator proves falsity. The oracle states which is
which, closed, and is emitted only to a test-only path.

Addresses live in a fourth disjoint region so a layout here cannot coincide with
any earlier family by accident.
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


def generate(seed=1, fast_divider=6, slow_divider=40, action_step=3, start_value=120,
             edges_per_step=3, transient_iterations=480, transient_value=0x5B):
    rng = random.Random(0xD0A + seed)
    taken = set()

    def allocate(width):
        candidates = list(range(0xC0, 0x100 - width))
        rng.shuffle(candidates)
        for base in candidates:
            region = set(range(base, base + width))
            if not region & taken:
                taken.update(region)
                return base
        raise AssertionError('no room for a field of width %d' % width)

    # The main loop is NOT frame-synchronised: it runs about 161 iterations per
    # emulated frame when neutral and about 151 with buttons held, measured on
    # this cartridge. A one-byte divider therefore fires several times per frame
    # and the 6 per cent iteration-rate difference between a held and a neutral
    # arm swamps the mechanism entirely - the first version of this family was
    # unusable for exactly that reason. The dividers are 16-bit: a tick fires
    # every 256 * divider iterations, so fast_divider 6 is roughly one advance
    # per 9.5 frames and slow_divider 40 roughly one per 64 frames.
    assert fast_divider >= 1 and slow_divider > fast_divider
    assert 1 <= action_step <= 64
    # 2 or more, or a continuous hold's single edge would move cadenceOnly and
    # the control would stop being about action structure.
    assert edges_per_step >= 2
    # The transient must live and die inside one 12-frame sampling interval. At
    # roughly 161 iterations per frame, that is well under 1900 iterations.
    assert 64 <= transient_iterations <= 1500
    assert 1 <= transient_value <= 255
    fields = {
        # the point of this family
        'timeAndAction': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        # the two one-sided controls
        'pureTime': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'pureAction': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        # time-driven, but only visibly so at a long horizon
        'slowTime': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        # the periodic dividers, exposed so a reader can see the mechanism
        'fastTick': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        'slowTick': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        'frameCounter': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        # the cadence positive control, and its edge counter
        'cadenceOnly': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'edgeCount': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        # the transient, its countdown, and the witness that it fired
        'transientPulse': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
        'transientTimer': {'address': allocate(2), 'width': 2, 'format': 'unsigned', 'endian': 'little'},
        'transientWitness': {'address': allocate(1), 'width': 1, 'format': 'unsigned', 'endian': 'little'},
    }
    addr = lambda name: fields[name]['address']

    # one button drives timeAndAction, a different one drives pureAction, so a
    # specificity test against an alternative mask has something to find
    dual = [1, 2, 7][seed % 3]
    solo = [4, 3, 6][(seed // 3) % 3]
    assert dual != solo

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

    def every(tick_name, divider, action):
        """Run `action` once every 256 * divider game iterations.

        A 16-bit divider, because one byte fires several times per emulated
        frame on this loop and the mechanism would be lost in the iteration-rate
        difference between a held arm and a neutral one.
        """
        done = asm.fresh('not_yet')
        writer(tick_name)
        asm.zp(0xE6, addr(tick_name))                  # inc low byte
        asm.branch(0xD0, done)                         # bne: low byte has not wrapped
        asm.zp(0xE6, addr(tick_name) + 1)              # inc high byte
        asm.zp(0xA5, addr(tick_name) + 1)
        asm.emit(0xC9, divider)                        # cmp #divider
        asm.branch(0xD0, done)                         # bne: not time yet
        asm.lda(0)
        asm.sta(addr(tick_name) + 1)
        action()
        asm.label(done)

    asm.label('reset')
    asm.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)             # sei, cld, ldx #$ff, txs
    for address, value in [(addr('timeAndAction'), start_value),
                           (addr('pureTime'), start_value),
                           (addr('pureAction'), start_value),
                           (addr('slowTime'), start_value),
                           (addr('fastTick'), 0),
                           (addr('fastTick') + 1, 0),
                           (addr('slowTick'), 0),
                           (addr('slowTick') + 1, 0),
                           (addr('frameCounter'), 0),
                           (addr('frameCounter') + 1, 0),
                           (addr('cadenceOnly'), start_value),
                           (addr('edgeCount'), 0),
                           (addr('transientPulse'), 0),
                           (addr('transientTimer'), 0),
                           (addr('transientTimer') + 1, 0),
                           (addr('transientWitness'), 0)]:
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
        asm.emit(0xAD, 0x16, 0x40)                     # lda $4016
        asm.emit(0x29, 0x01)                           # and #$01
        asm.zp(0x85, 0x10 + index)

    # ---- frameCounter: a free-running 16-bit timer, the usual decoy
    writer('frameCounter')
    asm.zp(0xE6, addr('frameCounter'))
    skip_carry = asm.fresh('no_carry')
    asm.branch(0xD0, skip_carry)
    asm.zp(0xE6, addr('frameCounter') + 1)
    asm.label(skip_carry)

    # ---- the TIME half of the dual field, and the two time-only controls
    def on_fast_tick():
        # A CEILING on the rising half, for the same reason as the floor below:
        # without it the field wraps from 255 to 0 and the fixture measures an
        # overflow rather than a mechanism.
        ceiling = asm.fresh('at_ceiling')
        asm.zp(0xA5, addr('timeAndAction'))
        asm.emit(0xC9, 0xFF)                           # cmp #255
        asm.branch(0xF0, ceiling)                      # beq: already at the top
        writer('timeAndAction')
        asm.zp(0xE6, addr('timeAndAction'))            # time makes it RISE
        asm.label(ceiling)
        floor = asm.fresh('at_floor')
        asm.zp(0xA5, addr('pureTime'))
        asm.branch(0xF0, floor)                        # beq: already at zero
        writer('pureTime')
        asm.zp(0xC6, addr('pureTime'))                 # a plain time-driven decoy
        asm.label(floor)
    every('fastTick', fast_divider, on_fast_tick)

    def on_slow_tick():
        floor = asm.fresh('slow_floor')
        asm.zp(0xA5, addr('slowTime'))
        asm.branch(0xF0, floor)
        writer('slowTime')
        asm.zp(0xC6, addr('slowTime'))
        asm.label(floor)
    every('slowTick', slow_divider, on_slow_tick)

    # ---- the ACTION half of the dual field: the button makes it FALL
    # Opposite directions on purpose: a probe that only looks at "did it change"
    # cannot tell the two causes apart, while the value itself can be above or
    # below the neutral trajectory depending on which cause dominated.
    def spend_dual():
        done = asm.fresh('dual_floor')
        # A FLOOR, not a zero test. With a step larger than one, "skip when the
        # value is exactly zero" lets the field step straight past zero and wrap
        # at 256 - which is what the first build of this family did at 60
        # pulses, turning a monotone resource into a sawtooth. A resource that
        # wraps is not a resource, and the fixture would have been measuring an
        # overflow instead of a mechanism.
        asm.zp(0xA5, addr('timeAndAction'))
        asm.emit(0xC9, action_step)                    # cmp #action_step
        asm.branch(0x90, done)                         # bcc: less than one step left
        writer('timeAndAction')
        for _ in range(action_step):
            asm.zp(0xC6, addr('timeAndAction'))
        asm.label(done)
    # Edge-driven, so the effect is frame-quantised and immune to the
    # iteration-rate drift that defeats a divider-driven action. One press edge
    # per press: a pulse train of P pulses applies the step P times, a
    # continuous hold of the same DURATION applies it once. The two therefore
    # differ by action structure and not by duration, which is what makes this
    # family a positive control for the cadence series rather than another
    # duration decoy.
    edge(dual, spend_dual)

    # ---- transientPulse: raised on a press edge, cleared about
    # transient_iterations game iterations later. At roughly 161 iterations per
    # emulated frame, the default 480 is about three frames - well inside the
    # 12-frame sampling interval, so no snapshot of the probe can catch it.
    def run_transient_timer():
        idle = asm.fresh('transient_idle')
        asm.zp(0xA5, addr('transientTimer'))
        asm.branch(0xD0, 'transient_tick_%d' % id(fields))   # low byte non-zero: tick
        asm.zp(0xA5, addr('transientTimer') + 1)
        asm.branch(0xF0, idle)                               # both bytes zero: nothing running
        asm.label('transient_tick_%d' % id(fields))
        # decrement the 16-bit timer
        asm.zp(0xA5, addr('transientTimer'))
        asm.branch(0xD0, 'transient_low_%d' % id(fields))    # low byte non-zero
        asm.zp(0xC6, addr('transientTimer') + 1)             # borrow from the high byte
        asm.label('transient_low_%d' % id(fields))
        asm.zp(0xC6, addr('transientTimer'))
        # cleared when both bytes reach zero
        asm.zp(0xA5, addr('transientTimer'))
        asm.branch(0xD0, idle)
        asm.zp(0xA5, addr('transientTimer') + 1)
        asm.branch(0xD0, idle)
        writer('transientPulse')
        asm.lda(0)
        asm.sta(addr('transientPulse'))
        asm.label(idle)
    run_transient_timer()

    def raise_transient():
        writer('transientPulse')
        asm.lda(transient_value)
        asm.sta(addr('transientPulse'))
        asm.lda(transient_iterations & 255)
        asm.sta(addr('transientTimer'))
        asm.lda(transient_iterations >> 8)
        asm.sta(addr('transientTimer') + 1)
        # the witness: proof the transient fired, for the test only. It is a
        # separate address so the sampling question is not answered by it.
        writer('transientWitness')
        asm.zp(0xE6, addr('transientWitness'))
    edge(dual, raise_transient)

    # ---- cadenceOnly: one step per K press edges, and nothing else moves it.
    # A continuous hold of any duration is ONE edge, so it never reaches K.
    def tick_edges():
        done = asm.fresh('cadence_done')
        writer('edgeCount')
        asm.zp(0xE6, addr('edgeCount'))                # inc edgeCount
        asm.zp(0xA5, addr('edgeCount'))
        asm.emit(0xC9, edges_per_step)                 # cmp #edges_per_step
        asm.branch(0xD0, done)                         # bne: not enough edges yet
        asm.lda(0)
        asm.sta(addr('edgeCount'))
        floor = asm.fresh('cadence_floor')
        asm.zp(0xA5, addr('cadenceOnly'))
        asm.branch(0xF0, floor)                        # beq: already at zero
        writer('cadenceOnly')
        asm.zp(0xC6, addr('cadenceOnly'))
        asm.label(floor)
        asm.label(done)
    edge(dual, tick_edges)

    # ---- pureAction: the button only, never time
    def spend_solo():
        done = asm.fresh('solo_floor')
        asm.zp(0xA5, addr('pureAction'))
        asm.branch(0xF0, done)                         # step is one, so zero is the floor
        writer('pureAction')
        asm.zp(0xC6, addr('pureAction'))
        asm.label(done)
    edge(solo, spend_solo)

    asm.jump('loop')
    asm.label('interrupt')
    asm.emit(0x40)                                     # rti

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
        'type': 'agod-dual-dependence-oracle', 'version': 1, 'seed': seed,
        'family': 'dual-dependence',
        'fields': fields,
        'dualMask': 1 << dual, 'soloMask': 1 << solo,
        'fastDivider': fast_divider, 'slowDivider': slow_divider,
        'fastPeriodIterations': 256 * fast_divider,
        'slowPeriodIterations': 256 * slow_divider,
        'actionStep': action_step, 'startValue': start_value,
        'edgesPerStep': edges_per_step,
        'transientIterations': transient_iterations,
        'transientValue': transient_value,
        'transientApproximateFrames': round(transient_iterations / 161.0, 2),
        'loopIterationsPerFrame': {'neutral': 161, 'buttonsHeld': 151,
                                   'measuredOn': 'this cartridge, jsnes, 10-frame windows',
                                   'why': 'the main loop is not frame-synchronised, so a one-byte '
                                          'divider fires several times per frame and the 6 per cent '
                                          'iteration-rate difference between a held arm and a '
                                          'neutral one swamps the mechanism'},
        'cadencePositiveControl': {
            'field': 'cadenceOnly',
            'edgesPerStep': edges_per_step,
        'transientIterations': transient_iterations,
        'transientValue': transient_value,
        'transientApproximateFrames': round(transient_iterations / 161.0, 2),
            'pressEdgesUnderTrain': 'one per pulse',
            'pressEdgesUnderContinuousHold': 1,
            'movesUnderContinuousHold': False,
            'movesUnderTrainOfAtLeast': edges_per_step,
            'why': 'cadenceOnly steps down once every %d press edges and is moved by nothing else. '
                   'A continuous hold of ANY duration is one press edge, so it can never move this '
                   'field; a train of %d or more pulses does. Its ground truth is action structure '
                   'rather than duration. This family exists to test whether the instrument CAN '
                   'detect an action-structure effect at all: it is an instrument attestation, '
                   'reported apart from the pre-registered corpus, and it is not evidence about any '
                   'game.' % (edges_per_step, edges_per_step),
            'whyNotTimeAndAction': 'timeAndAction has an edge-driven action half that fires on EVERY '
                   'edge, so the single edge of a continuous hold already moves it. Measured: it is '
                   'confirmed under both the train and the duration-matched hold at all five '
                   'horizons, so "confirmed under the train only" is empty by construction and that '
                   'null result says nothing about whether cadence is detectable.'},
        'echoAddresses': list(range(0x10, 0x18)),
        # Closed labels: what the phase-leak indicator is entitled to conclude.
        'dependenceLabels': {
            'timeAndAction': {
                'timeDriven': True, 'actionDriven': True,
                'neutralArmMoves': True,
                'indicatorFiresLegitimately': True,
                'recordingItAsAFalseCausalEventIs': 'WRONG',
                'why': 'it rises on its own every %d game iterations AND falls on each press of the '
                       'dual button, so the neutral arm moves it and the action also causes it. The '
                       'phase-leak indicator is entitled to say the horizon is UNCERTAIN here. It is '
                       'not entitled to say the confirmation is false, and a rule that reads the '
                       'indicator as proof of a false causal link gets this field wrong.'
                       % (256 * fast_divider),
            },
            'pureTime': {
                'timeDriven': True, 'actionDriven': False,
                'neutralArmMoves': True,
                'indicatorFiresLegitimately': True,
                'confirmingItIs': 'A FALSE CONFIRMATION',
                'why': 'advances on its own only. The indicator firing here is correct and a '
                       'confirmation here means the neutral trajectory failed to cover its drift.',
            },
            'pureAction': {
                'timeDriven': False, 'actionDriven': True,
                'neutralArmMoves': False,
                'indicatorMustNotFire': True,
                'why': 'moves on the solo button only and never by itself. If the indicator fires '
                       'here the neutral trajectory is leaking, which is a defect of the instrument '
                       'and not a property of the field.',
            },
            'cadenceOnly': {
                'timeDriven': False, 'actionDriven': True,
                'neutralArmMoves': False,
                'requiresMultipleEdges': edges_per_step,
                'movesUnderContinuousHold': False,
                'why': 'steps down once every %d press edges. A continuous hold of any duration '
                       'produces one edge and therefore cannot move it at all, while a pulse train '
                       'of %d or more pulses can. Confirming it under the train and NOT under the '
                       'duration-matched hold is the correct answer; confirming it under a '
                       'continuous hold would mean the instrument is attributing something else to '
                       'it.' % (edges_per_step, edges_per_step),
            },
            'transientPulse': {
                'timeDriven': False, 'actionDriven': True,
                'neutralArmMoves': False,
                'livesForIterations': transient_iterations,
                'livesForApproximateFrames': round(transient_iterations / 161.0, 2),
                'visibleToA12FrameSamplingGrid': False,
                'witnessField': 'transientWitness',
                'why': 'raised on a press edge and cleared about %.1f frames later, entirely inside '
                       'one 12-frame sampling interval. The event is real and caused by the action, '
                       'and no snapshot of the probe can catch it. The only honest verdict is '
                       'NO_CHANGE_AT_SAMPLED_POINTS; NO_EVENT_IN_HORIZON would present the sampling '
                       'density as the absence of a game event. transientWitness counts the firings '
                       'so a test can prove the event happened rather than assert it.'
                       % (transient_iterations / 161.0),
            },
            'slowTime': {
                'timeDriven': True, 'actionDriven': False,
                'neutralArmMoves': True,
                'movesOnlyAtLongHorizons': True,
                'slowPeriodIterations': 256 * slow_divider,
                'why': 'advances on its own once every %d game iterations, so a short horizon does '
                       'not move it at all. It separates "this field is time-driven" from "the '
                       'horizon was long enough to see that it is".' % (256 * slow_divider),
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
    parser.add_argument('--fast-divider', type=int, default=6,
                        help='timeAndAction and pureTime advance every 256*divider game iterations')
    parser.add_argument('--slow-divider', type=int, default=40,
                        help='slowTime advances every 256*divider game iterations')
    parser.add_argument('--transient-iterations', type=int, default=480,
                        help='game iterations transientPulse stays raised; ~161 iterations is one '
                             'emulated frame, so 480 is about three frames')
    parser.add_argument('--transient-value', type=int, default=0x5B)
    parser.add_argument('--edges-per-step', type=int, default=3,
                        help='press edges per step of cadenceOnly; must be 2 or more, or a '
                             'continuous hold would move it')
    parser.add_argument('--action-step', type=int, default=3,
                        help='how much one press edge moves timeAndAction')
    parser.add_argument('--start-value', type=int, default=120,
                        help='chosen so that neither the rising nor the falling half reaches its '
                             'bound inside the longest declared horizon of 720 frames')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--oracle-out', type=Path, help='checker-only metadata; never load into analyser')
    args = parser.parse_args()
    rom, oracle = generate(args.seed, args.fast_divider, args.slow_divider,
                           args.action_step, args.start_value, args.edges_per_step,
                           args.transient_iterations, args.transient_value)
    output = {'name': 'GU AGOD instrument-resolution fixture', 'license': 'MIT',
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
