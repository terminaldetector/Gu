#!/usr/bin/env python3
"""Original MIT NES fixture whose resource moves ONLY under a two-step action.

WHY THIS CARTRIDGE EXISTS. Every AGOD fixture so far yields to a single-action
probe: hold one button, watch one byte. This one does not. Nothing any single
button does changes a resource. The cost is gated behind a latch that another
button sets, so the dependency is A THEN B and a one-action search must refuse.
That makes it the control for G5.2: the single-action pipeline is expected to
REFUSE here, and a sequence search is expected to find the dependency and
reproduce it.

WHAT IS HIDDEN FROM THE ALGORITHM, by construction and not by labelling:

  hidden condition    B costs a life only while the latch A set is still up;
                      the latch expires on its own after 30 frames.
  delayed consequence the gain does not land on the frame of the sequence; it
                      lands 20 frames later, so a probe that reads RAM right
                      after the action sees nothing.
  dependent resources once lives is spent, the same sequence spends shield
                      instead - a second resource reachable only through the
                      first being empty.
  false counter       echo rises on ANY button press. It is monotone, it is
                      action-driven, and it is not a resource.
  time-driven decoy   frameCounter rises on its own and no action causes it.
  dead state          with lives and shield both empty, no action changes any
                      resource at all.

The oracle is written to a separate path. The analyser never reads it, and the
checker opens it only after discovery has committed its answer.

CONTROLLER BIT ORDER. $4016 is read serially A, B, Select, Start, Up, Down,
Left, Right, and this code rotates each bit in with ROL, so the first bit read
ends up in bit 7: A=$80, B=$40, Select=$20. That is internal to the cartridge;
the driver's own mask bit 0 is still A.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path

# zero page, which is also the first page of the RAM window the driver reads
FRAME_LO, FRAME_HI = 0x20, 0x21
ARMED, ARM_TIMER = 0x30, 0x31
LIVES, SHIELD, SCORE, PAY_TIMER, ECHO, PREV, BUTTONS = (
    0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38)

BIT_A, BIT_B, BIT_SELECT = 0x80, 0x40, 0x20
LATCH_FRAMES, PAY_FRAMES = 30, 20
# driver mask bits, for the oracle only
MASK = {'A': 1, 'B': 2, 'Select': 4, 'Start': 8}


class M6502:
    def __init__(self):
        self.code = bytearray()
        self.labels = {}
        self.rel = []
        self.abs = []
        self.serial = 0

    def emit(self, *values):
        self.code.extend(values)

    def label(self, name):
        assert name not in self.labels, name
        self.labels[name] = len(self.code)

    def fresh(self, prefix):
        self.serial += 1
        return '%s_%d' % (prefix, self.serial)

    def branch(self, opcode, name):
        self.emit(opcode, 0)
        self.rel.append((len(self.code) - 1, name))

    def jmp(self, name):
        self.emit(0x4C, 0, 0)
        self.abs.append((len(self.code) - 2, name))

    def lda_imm(self, v):
        self.emit(0xA9, v)

    def lda_zp(self, a):
        self.emit(0xA5, a)

    def sta_zp(self, a):
        self.emit(0x85, a)

    def lda_abs(self, a):
        self.emit(0xAD, a & 255, a >> 8)

    def sta_abs(self, a):
        self.emit(0x8D, a & 255, a >> 8)

    def inc_zp(self, a):
        self.emit(0xE6, a)

    def dec_zp(self, a):
        self.emit(0xC6, a)

    def and_imm(self, v):
        self.emit(0x29, v)

    def store(self, a, v):
        self.lda_imm(v)
        self.sta_zp(a)

    def finish(self):
        for position, name in self.rel:
            delta = self.labels[name] - (position + 1)
            assert -128 <= delta <= 127, (name, delta)
            self.code[position] = delta & 255
        for position, name in self.abs:
            target = 0x8000 + self.labels[name]
            self.code[position] = target & 255
            self.code[position + 1] = target >> 8
        return self.code


def read_controller(a):
    """$4016 strobe, then eight serial bits rotated into BUTTONS."""
    a.lda_imm(1)
    a.sta_abs(0x4016)
    a.lda_imm(0)
    a.sta_abs(0x4016)
    a.emit(0xA2, 8)                      # LDX #8
    a.label('poll')
    a.lda_abs(0x4016)
    a.emit(0x4A)                         # LSR A -> bit0 into carry
    a.emit(0x26, BUTTONS)                # ROL BUTTONS
    a.emit(0xCA)                         # DEX
    a.branch(0xD0, 'poll')               # BNE


def when_bit(a, bit, tag, body):
    """Run body when `bit` is set in the accumulator; A is preserved."""
    skip = a.fresh('skip_' + tag)
    a.emit(0x48)                         # PHA
    a.and_imm(bit)
    a.branch(0xF0, skip)                 # BEQ: not set
    body()
    a.label(skip)
    a.emit(0x68)                         # PLA


def program(a):
    # ---- reset ----
    a.label('reset')
    a.emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A)         # SEI CLD LDX #$FF TXS
    a.lda_imm(0)
    a.sta_abs(0x2000)
    a.sta_abs(0x2001)
    for _ in range(2):                            # two vblanks, as the PPU needs
        wait = a.fresh('warm')
        a.label(wait)
        a.lda_abs(0x2002)
        a.branch(0x10, wait)                      # BPL
    a.store(FRAME_LO, 0)
    a.store(FRAME_HI, 0)
    a.store(ARMED, 0)
    a.store(ARM_TIMER, 0)
    a.store(LIVES, 3)
    a.store(SHIELD, 2)
    a.store(SCORE, 100)
    a.store(PAY_TIMER, 0)
    a.store(ECHO, 0)
    a.store(PREV, 0)
    a.store(BUTTONS, 0)

    # ---- one iteration per frame ----
    a.label('frame')
    wait = a.fresh('vb')
    a.label(wait)
    a.lda_abs(0x2002)
    a.branch(0x10, wait)                          # BPL: wait for vblank

    # the time-driven decoy, caused by nothing
    a.inc_zp(FRAME_LO)
    skip_carry = a.fresh('carry')
    a.branch(0xD0, skip_carry)
    a.inc_zp(FRAME_HI)
    a.label(skip_carry)

    # THE DELAYED CONSEQUENCE, resolved before this frame's input so the gain
    # can never land on the same frame as the sequence that earned it
    pay_done = a.fresh('pay')
    a.lda_zp(PAY_TIMER)
    a.branch(0xF0, pay_done)                      # BEQ: nothing pending
    a.dec_zp(PAY_TIMER)
    a.lda_zp(PAY_TIMER)
    a.branch(0xD0, pay_done)                      # BNE: not due yet
    a.lda_zp(SCORE)
    a.emit(0x18, 0x69, 5)                         # CLC ADC #5
    a.sta_zp(SCORE)
    a.label(pay_done)

    read_controller(a)

    # edges = BUTTONS & ~PREV
    a.lda_zp(PREV)
    a.emit(0x49, 0xFF)                            # EOR #$FF
    a.emit(0x25, BUTTONS)                         # AND BUTTONS
    a.emit(0xAA)                                  # TAX  (keep edges)
    a.lda_zp(BUTTONS)
    a.sta_zp(PREV)
    a.emit(0x8A)                                  # TXA  -> A = edges

    # THE FALSE COUNTER: any press at all raises it
    echo_done = a.fresh('echo')
    a.emit(0x48)                                  # PHA
    a.branch(0xF0, echo_done)                     # BEQ: no edge this frame
    a.inc_zp(ECHO)
    a.label(echo_done)
    a.emit(0x68)                                  # PLA

    # the reset arm, so the resources can be restored from the floor
    def do_reset():
        a.store(LIVES, 3)
        a.store(SHIELD, 2)
        a.store(SCORE, 0)
        a.store(ARMED, 0)
        a.store(ARM_TIMER, 0)
        a.store(PAY_TIMER, 0)

    when_bit(a, BIT_SELECT, 'reset', do_reset)

    # A ARMS THE LATCH. On its own this changes the latch and nothing else -
    # no resource moves, which is what makes a single-action search refuse.
    def do_arm():
        a.store(ARMED, 1)
        a.store(ARM_TIMER, LATCH_FRAMES)

    when_bit(a, BIT_A, 'arm', do_arm)

    # the latch expires on its own, so the window is real and bounded
    expire_done = a.fresh('expire')
    arm_live = a.fresh('armlive')
    a.emit(0x48)                                  # PHA
    a.and_imm(BIT_A)
    a.branch(0xD0, expire_done)                   # A pressed this frame: keep it
    a.lda_zp(ARM_TIMER)
    a.branch(0xF0, expire_done)                   # BEQ: already expired
    a.dec_zp(ARM_TIMER)
    a.lda_zp(ARM_TIMER)
    a.branch(0xD0, expire_done)                   # BNE: still open
    a.store(ARMED, 0)
    a.label(expire_done)
    a.emit(0x68)                                  # PLA

    # B SPENDS, BUT ONLY WHILE THE LATCH IS UP.
    def do_spend():
        not_armed = a.fresh('notarmed')
        a.lda_zp(ARMED)
        a.branch(0xF0, not_armed)                 # BEQ: B does nothing at all
        a.store(ARMED, 0)                         # the latch is consumed
        a.store(ARM_TIMER, 0)
        shield_branch = a.fresh('shield')
        done = a.fresh('spent')
        a.lda_zp(LIVES)
        a.branch(0xF0, shield_branch)             # BEQ: lives empty
        a.dec_zp(LIVES)
        a.store(PAY_TIMER, PAY_FRAMES)            # the delayed gain is owed
        a.jmp(done)
        a.label(shield_branch)
        # THE DEPENDENT RESOURCE: reachable only once the first is empty
        a.lda_zp(SHIELD)
        a.branch(0xF0, done)                      # BEQ: the dead state
        a.dec_zp(SHIELD)
        a.label(done)
        a.label(not_armed)

    when_bit(a, BIT_B, 'spend', do_spend)

    a.jmp('frame')

    a.label('interrupt')
    a.emit(0x40)                                  # RTI


def generate(seed=0):
    a = M6502()
    program(a)
    code = a.finish()
    assert len(code) < 0x3FFA, len(code)
    prg = bytearray([0xEA] * 16384)
    prg[:len(code)] = code
    for offset, name in [(0x3FFA, 'interrupt'), (0x3FFC, 'reset'), (0x3FFE, 'interrupt')]:
        prg[offset:offset + 2] = (0x8000 + a.labels[name]).to_bytes(2, 'little')
    rom = b'NES\x1A' + bytes([1, 1, 0, 0]) + bytes(8) + prg + bytes(8192)

    fields = {
        'frameCounter': {'address': FRAME_LO, 'width': 2, 'timeDriven': True},
        'armed': {'address': ARMED, 'width': 1, 'role': 'latch'},
        'armTimer': {'address': ARM_TIMER, 'width': 1, 'role': 'transient'},
        'lives': {'address': LIVES, 'width': 1, 'role': 'resource'},
        'shield': {'address': SHIELD, 'width': 1, 'role': 'resource', 'dependsOn': 'lives'},
        'score': {'address': SCORE, 'width': 1, 'role': 'accumulator'},
        'payTimer': {'address': PAY_TIMER, 'width': 1, 'role': 'transient'},
        'echo': {'address': ECHO, 'width': 1, 'role': 'input-echo'},
    }
    oracle = {
        'type': 'agod-sequence-oracle', 'version': 1, 'seed': seed, 'platform': 'nes',
        'fields': fields,
        'singleActionEffects': {
            'A': ['armed', 'armTimer', 'echo'],
            'B': ['echo'],
            'Select': ['lives', 'shield', 'score', 'armed', 'armTimer', 'payTimer', 'echo'],
            'other': ['echo'],
        },
        'noSingleActionSpendsAResource': True,
        'sequences': [
            {'steps': ['A', 'B'], 'masks': [MASK['A'], MASK['B']],
             'effect': 'lives -1', 'requires': 'the latch A set is still up',
             'withinFrames': LATCH_FRAMES, 'delayFrames': 0},
            {'steps': ['A', 'B'], 'masks': [MASK['A'], MASK['B']],
             'effect': 'score +5', 'delayFrames': PAY_FRAMES,
             'note': 'the gain lands PAY_FRAMES after the sequence, never on its frame'},
            {'steps': ['A', 'B'], 'masks': [MASK['A'], MASK['B']],
             'effect': 'shield -1', 'requires': 'lives already 0', 'delayFrames': 0},
        ],
        'resources': ['lives', 'shield'],
        'notResource': ['echo', 'frameCounter', 'armTimer', 'payTimer', 'score'],
        'resetAction': {'button': 'Select', 'mask': MASK['Select']},
        'deadState': 'with lives and shield both 0 no action changes any resource',
        'expectation': {
            'singleActionPipeline': 'REFUSED - no single action decreases a resource',
            'sequenceSearch': 'A then B is confirmed, reproducibly, with the latch '
                              'as its condition and a delayed gain',
        },
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
    payload = {'kind': 'nes', 'name': 'FLY AGOD SEQUENCE',
               'sha256': hashlib.sha256(rom).hexdigest(),
               'base64': base64.b64encode(rom).decode()}
    args.out.write_text(json.dumps(payload, indent=2) + '\n')
    if args.oracle_out:
        args.oracle_out.write_text(json.dumps(oracle, indent=2) + '\n')
    print('sequence fixture: ' + payload['sha256'][:16])


if __name__ == '__main__':
    main()
