# research/mesen-causal — independent causal instrumentation

Stage B of the external architecture specification. The question is whether a
second, independent instrument can observe the CPU events behind a RAM change,
and whether its trace agrees with GU's own observations.

**Nothing here changes production GU, and no external source is copied into GU.**
The instrument is `mesen-agent`, a headless front-end to Mesen's emulation core,
licensed **GPL-3.0**. It is used as a separate process addressed by `argv` and
JSON Lines — the architecture the specification prescribes. The licence analysis
is part of B5 and is not settled by the existence of that boundary.

## The instrument

| | |
|---|---|
| repository | `https://github.com/atonamy/mesen-agent` |
| SHA used | `dbc2c744ad52e1c89a8570d22d7fa92507ad4816` |
| spec SHA | identical — the external `master` HEAD had not moved |
| Mesen version | 2.1.1 |
| licence | GPL-3.0 |
| build | `make agent -j4`, clang 18.1.3, Ubuntu 24.04 x86_64 |
| needs | neither SDL2 nor the .NET SDK, as its README claims and this build confirms |

The source is cloned and built **outside this repository** and is never committed.

## B0 — capability audit

`b0_capability_audit.cjs` → `results/b0_capability_audit.json`

The rule: *a CLI argument is not a capability.* Every row is exercised by a real
call and checked against something known independently of the instrument —
mostly the closed oracle of a GU synthetic fixture, including the **writer
program counters** its generator recorded.

| capability | verified by | result |
|---|---|---|
| 1. launch a synthetic NES ROM | `loaded` record, console `Nes` | PASS |
| 2. execute exactly N frames | summary, the fixture's own counter in RAM, repeat, N vs N+1 | PASS |
| 3. button schedules via `--input` | `cadenceOnly` steps once per 3 press edges and nothing else moves it, so the schedule predicts the value | PASS |
| 4. save and restore state | RAM hash at save vs after reload | PASS |
| 5. read RAM | declared start value after reset | PASS |
| 6. save a CPU trace | the trace contains the oracle's writer PC when the button is pressed and not when it never is | PASS |
| 7. read / write / execute breakpoints | stops only when the driving button is pressed, at the oracle's writer PC | PASS |
| 8. obtain a video frame | valid PNG, 256×240, two points of the run differ | PASS |
| 9. fresh-boot reproducibility | not on the original list; see below | PASS |

The decisive row is 7. A write breakpoint on `cadenceOnly` stopped at PC
**`0x81a8`** — exactly the writer PC the generator recorded for that field — and
did not stop at all when the driving button was never pressed. An execute
breakpoint set directly on `0x81a8` stopped at the same place. The instrument
located the writing instruction without ever being shown the oracle.

### Three corrections, all mine

The first run failed three rows, and all three were my assumptions:

- **RAM read** expected the declared start value at `--frames 0`. That is a
  *pre-reset* state, so RAM there is power-on content; the read was working.
- **Breakpoints** expected no write to `cadenceOnly` without a press. The
  fixture's own reset handler writes it at boot — a real write, correctly
  caught. The audit now starts from a post-boot state and discriminates by PC.
- **Video** required the PNG to exceed 1000 bytes. 718 bytes is the *correct*
  size for this fixture's near-uniform screen. A byte threshold was a bad proxy
  for "a real picture"; the check is now the IHDR dimensions and that two points
  of the run differ.

### Row 9: the capability gap

Row 4 reported that a restored state was bit-exact while restore-plus-50-frames
did not match a fresh longer run. That had to be explained, not filed away.

**This instrument randomises power-on RAM, and the CLI cannot change it.**
`Core/Shared/SettingTypes.h` declares `RamState { Random = 0, AllZeros = 1,
AllOnes = 2 }`; `Core/NES/NesConsole.cpp` initialises RAM from
`NesConfig.RamPowerOnState`, so the default is `Random`; and
`Headless/AgentCli.cpp` sets no settings at all. Three identical fresh runs give
three different whole-RAM hashes.

This is a gap, not a defect — real hardware does not guarantee zeroed RAM, and
jsnes, which zeroes it, is the one making the convenient assumption.

**Mitigation, measured rather than assumed:** drive every comparison from one
canonical saved state. Verified bit-identical across repeats, with and without
input, with input still changing the result. That is the same discipline GU's
declared starts already use, so no new assumption is introduced.

**Consequence for B2, recorded before B2 rather than discovered during it:** a
cross-core comparison against jsnes may not compare whole-RAM hashes from
independent boots. It must run both cores from a declared procedure and compare
only addresses the ROM itself initialises, or compare trajectories rather than
absolute content.

### What the instrument does not give

`Core/Debugger/ScriptingContext.cpp` `InternalCallMemoryCallback` pushes exactly
**two** values to a Lua memory callback: the relative address and the value. It
does **not** pass the program counter, the CPU cycle, the frame number or the
input state. Those must be sampled inside the callback via `emu.getState()` —
which is a *different provenance claim*: a sample taken at callback time, not a
field of the event. B4 records it as such.

`emu.addMemoryCallback` does exist and is a real per-access watcher, so
Mesen2-Diz's `IpcMemoryWatcher` is not needed for B1. That remains the fallback
if the callback path proves insufficient.

## Reproducing

```bash
git clone https://github.com/atonamy/mesen-agent.git   # outside this repository
cd mesen-agent && git checkout dbc2c744ad52e1c89a8570d22d7fa92507ad4816
make agent -j4                                          # bin/linux-x64/Release/mesen-agent

MESEN_AGENT=<path>/mesen-agent \
 MESEN_SHA=dbc2c744ad52e1c89a8570d22d7fa92507ad4816 \
 B0_REPORT=/tmp/b0.json \
 node research/mesen-causal/b0_capability_audit.cjs
```

## B0 supplement — the three completeness items

`b0b_completeness_supplement.cjs` → `results/b0b_completeness_supplement.json`

The historical B0 is not rewritten. All four items PASS, and one of them found a
defect in my reasoning rather than a missing capability.

| item | result |
|---|---|
| 4.1 read breakpoint, now a mandatory condition | stops under presses at the oracle's writer site; does **not** stop under neutral play |
| 4.2 `--list-memory` | works, and always did: `NesInternalRam` 2048, `NesMemory` 65536, `NesPrgRom` 16384, seven spaces |
| 4.3a two frames, one state, one trajectory (synthetic) | the images are **identical** |
| 4.3b the same question on a cartridge that renders | frames 30 and 300 differ; the same point reproduces |

**B0 row 8's "two points of the run differ" is withdrawn as evidence.** It
compared frame 30 of one run with frame 400 of another, and on this instrument
two independent runs also have different power-on RAM — so it was passing on the
wrong variable. Asked properly, this fixture's picture is constant along a
trajectory, because the ROM never programs the PPU. The claim was then tested
where it can be: Life Force, one saved state after the S8 entry procedure.

## B1 prerequisites — PC provenance and address semantics

`b1_pc_and_address_semantics.cjs` → `results/b1_pc_and_address_semantics.json`

A Lua memory callback receives `(relativeAddress, value)` and nothing else, so
PC, cycle and frame come from `emu.getState()` *inside* the callback — a sample
of state at callback time, not a field of the event.

| accessing instruction | length | sampled PC | offset |
|---|---|---|---|
| `DEC $D6` @ `0x81A8` (= the oracle's writer site) | 2 | `0x81AA` | **2** |
| `STA $00D6` @ `0x8039` | 3 | `0x803C` | **3** |

**The sampled PC is the address of the NEXT instruction** — the accessing
instruction plus *its own* length. The offset therefore varies with the
addressing mode and **no fixed offset recovers the accessing site**. It is
recorded as `nextInstructionPc`; the accessing instruction is resolved through
disassembly or a breakpoint, never by subtracting a constant.

Getting the 3-byte case needed a cold start: from a post-boot state the reset
handler's absolute `STA` has already run, and with only 2-byte accesses left a
single length cannot establish that the offset tracks the length.

Also established:

- **Read sites resolve** at two distinct places: `0x81A4` (the `LDA` that tests
  the field) and `0x81A8` (the read half of the `DEC` read-modify-write).
- **The observer does not alter the run.** RAM is bit-identical with the callback
  sampling, with it attached but silent, and with none. No callback returns a
  value — a Lua memory callback that returns an integer *overwrites* the memory
  operation.
- **The NES mirror mapping, measured.** A marker written via `0x00D6`, `0x08D6`,
  `0x10D6`, `0x18D6` all lands in physical byte `0xD6`; via `0x20D6` (PPU
  registers) it does not.
- **The memory type a callback registers on is not cosmetic.** On `nesMemory`
  (relative, CPU-visible) it received every write; on `nesInternalRam` (physical)
  it received **none** over the same trajectory. An unobserved address is not an
  unwritten one.

## B1 — synthetic causal trace, two observation modes

`b1_synthetic_causal_trace.cjs` → `results/b1_synthetic_causal_trace.json`

5/5 checks; 7/7 controls classified correctly; **event loss exactly zero** — the
callback's own count equals the independent access-counter count in every
regime/control cell, reads and writes alike.

### B1-B: write behaviour under three action regimes

| control | neutral | hold | train | class (observed = declared) |
|---|---:|---:|---:|---|
| `cadenceOnly` | 0 | 0 | 12 | `WRITTEN_PER_ACTION_EDGE` |
| `timeAndAction` | 74 | 76 | 192 | `WRITTEN_BY_TIME_AND_ACTION` |
| `pureTime` | 74 | 70 | 72 | `WRITTEN_REGARDLESS_OF_ACTION` |
| `pureAction` | 0 | 2 | 40 | `WRITTEN_PER_ACTION_EDGE` |
| `singleUnit` | 0 | 1 | 1 | `WRITTEN_ONLY_UNDER_ACTION` |
| `oneShotSwitch` | 0 | 1 | 1 | `WRITTEN_ONLY_UNDER_ACTION` |
| `firstThenLater` | 0 | 2 | 4 | `WRITTEN_ONLY_UNDER_ACTION` |

The class is read out of the trace first; the declared expectation is compared
afterwards. The expectations live in the control table, derived from each
generator's documented mechanism.

**B1's success criterion is met for `cadenceOnly`**: the RAM transition, the
executing instruction (`DEC $D6` @ `0x81A8`, matching the writer PC the
generator recorded and the instrument never saw) and the action under which it
occurs are all independently confirmed, with the trace cost measured.

### The fourth regime, and a negative that was mine

`singleUnit` (a genuine one-unit resource) and `oneShotSwitch` (a latch) are
identical under all three regimes above: same writes, same read counts, one
reader site each. Differing site *addresses* (`0x811A` vs `0x80F9`) are expected
of two different variables and say nothing about kind.

But all three regimes press only the field's **own driving button**, and
`singleUnit`'s consumer is gated on a *different* button. That consumer never
ran. A fourth regime drives it:

| under `trainPlusConsumer` | reads | distinct reader sites |
|---|---:|---|
| `singleUnit` | **21** | **2** — `0x811A`, `0x8131` |
| `oneShotSwitch` | 20 | 1 — `0x80F9` |

**Separated — but only by a schedule that exercises the consumer.** The extra
reader *site* is the structural difference, not the differing address. The first
negative was a property of my action schedule, not of the instrument.

This still does **not** establish that `singleUnit` is a game resource. An extra
read from a distinct instruction is a **lead** about a consumer; it is never
promoted to `GAME_COST_EVIDENCED`, because HUD code, animation and timers read
fields too. Separating resource from latch *by kind* needs evidence about what
the consumer **does** with the value.

**Carried forward to B3:** an action schedule must drive candidate **consumers**,
not only the candidate's own driver.

### B1-A: access summary, and one cheap signal

`emu.getAccessCounters()` over a declared window costs nothing and surfaces the
mechanism directly. One result worth keeping: `transientPulse` shows **40 writes
and 0 reads** — a field nothing consumes, which is a strong *negative* for
"resource" and is free to obtain.

### Cost — measured in CPU time, because wall clock cannot see it

Every run is paced at **16.96 ms/frame (≈59 fps)** and `--no-max-speed` changes
nothing (6776 ms vs 6787 ms over 400 frames), although `AgentCli.cpp:699` sets
`EmulationFlags::MaximumSpeed` by default. **Wall-clock ratios are 1.00 for every
mode** and are not a cost measurement.

| mode | events seen | CPU | ×baseline |
|---|---:|---:|---:|
| no observation | — | 1.67 s | 1.00 |
| callback on one byte, no state sample | 24 | 1.69 s | 1.01 |
| callback on one byte, bounded 16 samples | 24 | 1.61 s | 0.96 |
| callback on one byte, `getState()` every access | 24 | 1.76 s | 1.05 |
| full CPU instruction trace | — | 2.77 s | **1.66** |
| whole zero page, no state sample | 2,197,276 | 1.95 s | 1.16 |
| whole zero page, `getState()` every access | 2,197,276 | **252.5 s** | **150.8×** |

**≈114–129 µs per `getState()` call.** It serialises the entire console — APU,
PPU, mapper, palette, sprite RAM — so the cost is per *call*, independent of how
little of the result is used. **The two-stage scheme is mandatory, not a
refinement.** The single-byte rows do not establish otherwise: they see ~24
events in a whole window.

Baseline CPU varied 1.67–2.05 s across runs (~15%), so **rows between 0.9× and
1.15× are indistinguishable from 1.00 and from each other**. Only the trace row
and the whole-zero-page sampling row are outside the noise.

The instruction trace writes **146 KB per frame** (58.6 MB per 400 frames).

**Throughput consequence for B5:** at ~59 fps a 2.5 M-frame campaign — the size
of the S11B corpus — is roughly **12 hours** of wall clock against 47 minutes in
jsnes.

### Start states

Every run starts from **one canonical post-boot saved state per fixture**,
because this instrument randomises power-on RAM (B0 row 9). Runs are comparable
within this core and are **not** comparable with an independent jsnes cold start
— B2 must handle that explicitly rather than discover it.
