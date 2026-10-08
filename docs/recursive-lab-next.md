# Recursive Lab: next branch design

Status: design for dual-agent inference; named single-agent Layer Set is implemented in alpha08.

The console is an environment; human and agents are replaceable owners of P1/P2. The FlyWire graph supplies a seed topology. Acquired structure and runtime state must remain distinct, inspectable and versioned.

## Available foundation: named Layer Set

Alpha08 persists portable readout + FDB checkpoints as named sets with graph/ROM identities, neural ports, reward profile, growth state and an attributed experience journal. Multiple sets share the immutable graph; only one agent runs. A saved set can move between solo and human/agent P2 without changing the console state. In the dual-agent branch, each AgentSlot should load its own set rather than borrowing mutable state from the current slot.

Use save-as to keep a baseline and a separate growing branch. Train the branch, annotate live observations (for example a Mortal Kombat continue/round), then evaluate both from the same captured start. Manual notes, RAM criteria and mere learning boundaries remain distinct. This prepares provenance for future branch selection/pruning; it does not yet implement the recursive mutations or arbiter below.

## Agent identity and two flies

AgentSlot must own graph SHA, graph/readout port bindings, backend, seed, LIF state, FDB layer/growth state, SARSA weights/traces/RNG, reward profile, telemetry and action safety mask. The console ROM and clock are shared. Loading a different P2 model must not mutate P1. The same graph arrays may be shared read-only, but each agent needs separate voltages, currents, delayed events and learning state. Different graphs need distinct allocation budgets; two copies of graph plus GPU mirrors may be expensive on a phone. More neurons/edges is a capacity difference, not evidence of better play.

Scheduler: capture one immutable frame and RAM observation, tag by console generation/frame; give both slots that observation. Realtime keeps last valid action per port with watchdog; a late result never leaks into the other port. Lockstep waits for both only when explicitly chosen. Pause/reconnect never implies reset. Console reset has its own generation; agent reset is slot-specific.

## FDB direction

Keep the base graph immutable. Seed -> local recurrent motifs -> specialized branch -> growth -> reinforcement -> budgeted pruning -> routing. Store the growth genome, provenance, rewards and ablation evidence independently of the readout. Current alpha07 growth is a bounded source/target coactivity heuristic, not yet recursive branch duplication or conditional computation.

Snapshots have separate levels: structural layer; growth checkpoint; policy/readout; complete dynamical state (voltages, currents, pending spikes). Existing alpha07 saves the first three pieces only. Do not call it a full brain snapshot. A full checkpoint needs backend-specific format plus graph, options, slot and schema identity. Cross-backend transplantation needs an explicit conversion and parity test.

Next measurable feature: split/specialize a bounded recurrent motif only after sustained reward evidence; keep neutral control, fixed-graph and readout-only baselines. Prune proposals in a copy, replay from a checkpoint, then keep a mutation if it improves held-out trials under the same budget. Route only into active branches when implementation physically avoids work; a logical router alone does not reduce LIF compute.

## Council / ensemble

Three agents propose **valid action masks** with confidence/uncertainty and timing. Arbiter selects one complete action; bitwise majority can create illegal opposing directions or Start combinations. Track disagreement, winner and reward. An ensemble is a distinct optional experiment, not a claimed improvement or the definition of recursion. Compute budget and heat on mobile must be measured.

## Evidence and goals

Local offline work remains the scope. Keep ROM SHA, graph SHA, profile, readout/FDB versions, training/eval flag, nominal and measured FPS, CPU/GPU milliseconds, input source and per-port masks in reports. Compare readout-only, neuron-only, learned network and synthetic layer; test success across seeds from a captured game state. Field reports of adaptation in Mortal Kombat, Dune or Pulseman motivate these tests but do not establish causality.
