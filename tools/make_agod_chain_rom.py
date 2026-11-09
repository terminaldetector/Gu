#!/usr/bin/env python3
"""Original MIT NES fixture: a THREE-step dependency whose intermediate state is
invisible in the observed RAM window.

PRE-REGISTERED FOR D1. The dependency is A, then B, then Start, each within 40
frames of the last. The progress through it lives at $6000/$6001 - cartridge
RAM, outside the 2 KiB window the driver reads - so:

  no single action moves a resource through the chain;
  no TWO-step prefix has any observable effect of its own: A->B changes only
  the hidden stage and the input echo, which the parts alone also change.
  A search that grows three-step candidates only out of CONFIRMED pairs
  therefore never reaches it, and a search that prunes a prefix because the
  window shows nothing new prunes exactly the step that matters.

TWO RESOURCES AND FOUR THINGS THAT ARE NOT:

  lives        resource, spent only by the full chain; a delayed gain follows.
  ammo         resource, spent by Up alone, floor at 0.
  echo         rises on ANY press            - action-driven, monotone, not a resource
  antiEcho     falls on ANY press            - the same, in the other direction
  frameCounter rises on its own              - time-driven
  pseudoTimer  falls on its own              - time-driven, and DEcreasing, so
                                               "it goes down" is not "it is spent"

Any other button drops the hidden stage back to 0, and the stage expires on its
own. Select restores both resources and zeroes the score.

The oracle goes to a separate path; the analyser never reads it.
"""
import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_agod_sequence_rom import M6502, read_controller, when_bit  # noqa: E402

FRAME_LO, FRAME_HI, PSEUDO_TIMER = 0x20, 0x21, 0x22
LIVES, AMMO, SCORE, PAY_TIMER, ECHO, ANTI_ECHO, PREV, BUTTONS = (
    0x32, 0x33, 0x34, 0x35, 0x36, 0x39, 0x37, 0x38)
STAGE, STAGE_TIMER = 0x6000, 0x6001          # cartridge RAM: NOT in the window
BIT_A, BIT_B, BIT_SELECT, BIT_START, BIT_UP = 0x80, 0x40, 0x20, 0x10, 0x08
OTHER_BITS = 0x20 | 0x08 | 0x04 | 0x02 | 0x01    # Select Up Down Left Right
WINDOW, PAY_FRAMES = 40, 20
MASK = {'A': 1, 'B': 2, 'Select': 4, 'Start': 8, 'Up': 16}


def program(a):
    a.label('reset')
    a.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)
    a.lda_imm(0)
    a.sta_abs(0x2000)
    a.sta_abs(0x2001)
    for _ in range(2):
        wait = a.fresh('warm')
        a.label(wait)
        a.lda_abs(0x2002)
        a.branch(0x10, wait)
    for address, value in [(FRAME_LO, 0), (FRAME_HI, 0), (PSEUDO_TIMER, 200),
                           (LIVES, 3), (AMMO, 5), (SCORE, 100), (PAY_TIMER, 0),
                           (ECHO, 0), (ANTI_ECHO, 250), (PREV, 0), (BUTTONS, 0)]:
        a.store(address, value)
    a.lda_imm(0)
    a.sta_abs(STAGE)
    a.sta_abs(STAGE_TIMER)

    a.label('frame')
    wait = a.fresh('vb')
    a.label(wait)
    a.lda_abs(0x2002)
    a.branch(0x10, wait)

    a.inc_zp(FRAME_LO)
    skip = a.fresh('carry')
    a.branch(0xD0, skip)
    a.inc_zp(FRAME_HI)
    a.label(skip)
    a.dec_zp(PSEUDO_TIMER)                       # falls on its own, wraps

    pay_done = a.fresh('pay')
    a.lda_zp(PAY_TIMER)
    a.branch(0xF0, pay_done)
    a.dec_zp(PAY_TIMER)
    a.lda_zp(PAY_TIMER)
    a.branch(0xD0, pay_done)
    a.lda_zp(SCORE)
    a.emit(0x18, 0x69, 5)
    a.sta_zp(SCORE)
    a.label(pay_done)

    # the hidden stage expires on its own
    exp_done = a.fresh('exp')
    a.lda_abs(STAGE_TIMER)
    a.branch(0xF0, exp_done)
    a.emit(0xCE, STAGE_TIMER & 255, STAGE_TIMER >> 8)   # DEC abs
    a.lda_abs(STAGE_TIMER)
    a.branch(0xD0, exp_done)
    a.lda_imm(0)
    a.sta_abs(STAGE)
    a.label(exp_done)

    read_controller(a)
    a.lda_zp(PREV)
    a.emit(0x49, 0xFF)
    a.emit(0x25, BUTTONS)
    a.emit(0xAA)
    a.lda_zp(BUTTONS)
    a.sta_zp(PREV)
    a.emit(0x8A)                                  # A = edges

    echo_done = a.fresh('echo')
    a.emit(0x48)
    a.branch(0xF0, echo_done)
    a.inc_zp(ECHO)
    a.dec_zp(ANTI_ECHO)
    a.label(echo_done)
    a.emit(0x68)

    def set_stage(value):
        a.lda_imm(value)
        a.sta_abs(STAGE)
        a.lda_imm(WINDOW if value else 0)
        a.sta_abs(STAGE_TIMER)

    def do_reset():
        a.store(LIVES, 3)
        a.store(AMMO, 5)
        a.store(SCORE, 0)
        a.store(PAY_TIMER, 0)

    when_bit(a, BIT_SELECT, 'reset', do_reset)

    def do_ammo():
        empty = a.fresh('noammo')
        a.lda_zp(AMMO)
        a.branch(0xF0, empty)
        a.dec_zp(AMMO)
        a.label(empty)

    when_bit(a, BIT_UP, 'ammo', do_ammo)

    # any button outside the chain drops the hidden progress
    def do_drop():
        set_stage(0)

    a.emit(0x48)
    a.and_imm(OTHER_BITS)
    drop_skip = a.fresh('drop')
    a.branch(0xF0, drop_skip)
    do_drop()
    a.label(drop_skip)
    a.emit(0x68)

    def do_a():
        set_stage(1)

    when_bit(a, BIT_A, 'a', do_a)

    def do_b():
        wrong = a.fresh('bwrong')
        done = a.fresh('bdone')
        a.lda_abs(STAGE)
        a.emit(0xC9, 1)                           # CMP #1
        a.branch(0xD0, wrong)
        set_stage(2)
        a.jmp(done)
        a.label(wrong)
        set_stage(0)
        a.label(done)

    when_bit(a, BIT_B, 'b', do_b)

    def do_start():
        wrong = a.fresh('swrong')
        a.lda_abs(STAGE)
        a.emit(0xC9, 2)
        a.branch(0xD0, wrong)
        a.lda_zp(LIVES)
        a.branch(0xF0, wrong)
        a.dec_zp(LIVES)
        a.store(PAY_TIMER, PAY_FRAMES)
        a.label(wrong)
        set_stage(0)

    when_bit(a, BIT_START, 'start', do_start)

    a.jmp('frame')
    a.label('interrupt')
    a.emit(0x40)


def generate(seed=0):
    a = M6502()
    program(a)
    code = a.finish()
    prg = bytearray([0xEA] * 16384)
    prg[:len(code)] = code
    for offset, name in [(0x3FFA, 'interrupt'), (0x3FFC, 'reset'), (0x3FFE, 'interrupt')]:
        prg[offset:offset + 2] = (0x8000 + a.labels[name]).to_bytes(2, 'little')
    rom = b'NES\x1A' + bytes([1, 1, 0, 0]) + bytes(8) + prg + bytes(8192)
    fields = {
        'frameCounter': {'address': FRAME_LO, 'width': 2, 'role': 'time-driven'},
        'pseudoTimer': {'address': PSEUDO_TIMER, 'width': 1, 'role': 'time-driven'},
        'lives': {'address': LIVES, 'width': 1, 'role': 'resource'},
        'ammo': {'address': AMMO, 'width': 1, 'role': 'resource'},
        'score': {'address': SCORE, 'width': 1, 'role': 'accumulator'},
        'payTimer': {'address': PAY_TIMER, 'width': 1, 'role': 'transient'},
        'echo': {'address': ECHO, 'width': 1, 'role': 'input-echo'},
        'antiEcho': {'address': ANTI_ECHO, 'width': 1, 'role': 'input-echo'},
    }
    oracle = {
        'type': 'agod-chain-oracle', 'version': 1, 'seed': seed, 'platform': 'nes',
        'fields': fields,
        'hidden': {'stage': STAGE, 'stageTimer': STAGE_TIMER,
                   'note': 'cartridge RAM, outside the observed 2 KiB window'},
        'chain': {'steps': ['A', 'B', 'Start'],
                  'masks': [MASK['A'], MASK['B'], MASK['Start']],
                  'effect': 'lives -1', 'windowFrames': WINDOW,
                  'delayed': {'field': 'score', 'delta': 5, 'delayFrames': PAY_FRAMES}},
        'twoStepPrefixesHaveNoOwnEffect': True,
        'singleActionResource': {'field': 'ammo', 'mask': MASK['Up']},
        'resources': ['lives', 'ammo'],
        'notResource': ['echo', 'antiEcho', 'frameCounter', 'pseudoTimer', 'payTimer', 'score'],
        'resetAction': {'button': 'Select', 'mask': MASK['Select']},
        'exhaustiveTriples': 8 * 8 * 8,
        'note': 'checker-only metadata; the analyser must never read this file',
    }
    return rom, oracle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--oracle-out', type=Path)
    parser.add_argument('--seed', type=int, default=0)
    args = parser.parse_args()
    rom, oracle = generate(args.seed)
    payload = {'kind': 'nes', 'name': 'FLY AGOD CHAIN',
               'sha256': hashlib.sha256(rom).hexdigest(),
               'base64': base64.b64encode(rom).decode()}
    args.out.write_text(json.dumps(payload, indent=2) + '\n')
    if args.oracle_out:
        args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')
    print('chain fixture: ' + payload['sha256'][:16])


if __name__ == '__main__':
    main()
