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
