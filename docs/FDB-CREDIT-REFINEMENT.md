# FDB: action-path credit refinement (experimental)

## Scope of this change

This patch builds on the existing Expanded FDB implementation without altering
the immutable FlyWire/Male CNS W0 connectomes, emulator, ROM identity, Layer Set
container format, CPU/GPU LIF equations or number of neurons.

**Expanded mode only** now uses:

* **Selected motor credit:** the policy-gradient feedback frontier starts from
  the motor ports belonging to the actually sampled action. Unselected motor
  outputs do not originate a new trace. A neutral (zero-button) action adds no
  new motor frontier, but previous eligibility may still receive delayed credit.
* **Active internal path gate:** a backpropagated eligibility path requires
  observed non-zero activity at each internal source and intermediate target.
  The selected terminal motor may have zero spikes so the rule can still learn
  to activate it. This is a bounded action-attribution surrogate, **not proof
  of causal influence** in the biological graph.
* **Dual-timescale eligibility:** fast trace time constant 0.6 s (legacy)
  and slow trace time constant 3.0 s; combined update eligibility is
  `0.75 * fast + 0.25 * slow`. Both are independently clipped to [-2,2].
  The slow timescale is exponential, not an exact fixed-N decision buffer.
* **Same decision budget:** the existing combined capped update budget,
  sign-preserving W0 trust region, Wexo limits, neuron thresholds and
  evaluation/lesion/intervention guards remain.
* **Observability:** `plasticityTop20` in the learner checkpoint contains
  deterministic ranked top-20 lists for each parameter family: ROOT ΔW,
  grown Wexo synapses, and threshold offsets. Rankings use absolute changes
  **within each family**; scores in different units are not directly compared.
  They report cumulative parameters, not the last 100 actions.

Other plasticity modes retain their previous credit behavior to enable
side-by-side ablation against Expanded. This prevents a silent behavioral
change to the base controller.

## Persistence

* Learner checkpoint **version 5** uses algorithm ID
  `dual-timescale action-path eligibility v5` and saves the new
  `slowEligibility` member on edge and neuron traces.
* Restoring a valid version 5 preserves both timescales, RNG, weights,
  counter state and thresholds. As before, an exact in-flight game/LIF
  continuation is **not** implied by restoring a Layer Set.
* Restoring a version 4 Expanded checkpoint retains acquired parameters
  and history but clears its obsolete temporal credit. Version 4 base,
  ROOT, Wexo and dynamics traces may be preserved if their previous
  projection/identities still match.
* The outer Layer Set version is unchanged. Graph fingerprint, ordered
  ports and projection validation remain in place.
* Pauses, invalid/mismatched outcomes and manual boundaries clear **both**
  trace timescales, without deleting learned parameters.

## Validation / limits

`tools/ExpandedPlasticityCheck.java` now checks strict selected-motor
attribution, inactive internal-path rejection, nonzero slow credit,
midstream v5 checkpoint roundtrip, v4 invalidation, boundary clearing and
bounded parameter diagnostics.

A passing unit test does not establish improved commercial-game policy.
Long-horizon credit, counterfactual attribution and reproducible cross-ROM
transfer still require measured experiments with fixed seeds and ablations.

## Next changes, deliberately not mixed into this patch

1. Dynamic ROOT/Wexo candidate reselection and explicit capacity partitions
   need a versioned candidate-identity contract so resumed training cannot
   silently point to a different set of synapses.
2. Add ROM tasks with held-button, multi-action sequencing and 5–10-decision
   reward delay, then log steps to 80% success, stability after reload,
   negative transfer and per-seed variance.
3. Genre/ROOT upward consolidation needs evidence from multiple distinct
   ROM identities, explicit approval or a configured safety threshold,
   SHA validation and rollback. Single-game success must not contaminate ROOT.
4. Batch GPU weight patches and split topology revisions from weight revisions.
   Confirm end-to-end CPU/GPU parity and Android thermal/latency measurements.
5. For neuron-threshold eligibility based on pre/post-action spike-rate
   changes, add **new telemetry from the actual executed interval** before
   claiming a causal proxy; the current feedback API does not contain it.

Do not interpret these unfinished items as implemented features.
