# V2 status after unfinished-zone audit

Implemented:
- GPU shader uses CPU LIF coefficients, voltage stimulation, reset/current clearing, refractory rules and the 19-slot / 1.8 ms delay queue.
- SSBO ring aliases bindings 3/4 intentionally; dispatches are separated by shader-storage barriers.
- GPU initialization checks ES version, SSBO block/binding count and largest-buffer size; allocation/dispatch errors are surfaced. Out-of-range q16.8 weights are rejected, never silently clipped.
- Production shader executes in Mesa EGL CI and compares each simulation step against LIF equations for forced input, silence, inhibition, gain and lesions.
- FDB CPU overlay editor supports explicit added edges and existing-edge weight deltas using string FlyWire IDs; SHA binds each overlay to its graph. JSON exports/profiles carry overlays. Checkpoint/restore uses device storage.
- GraphDelta bounds deltas/growth and checkpoints, keeps deterministic genome ordering and monotonic rollback revisions.
- GMode controller tests execute production frontend functions. Single-player manual directions take priority; co-op input remains independent; switching roles releases both ports.

Limitations:
- GPU Poisson RNG differs from Java Random; float/q16.8 differs from CPU double/float. Stochastic bit-for-bit parity is not claimed.
- This GPU implementation needs 10 compute SSBO blocks. GLES 3.1 alone does not guarantee that limit. Unsupported devices receive an explicit initialization error and may choose CPU.
- Approximate SSBO storage is 100 MiB for 138639 neurons / 15091983 edges, plus Java graph, staging allocations and driver memory. Mobile performance still requires hardware measurement.
- FDB overlay executes on CPU only. Automatic topology learning, new neurons, pruning and Recursive Lab scheduling remain unimplemented.
- Sega P2 remains unavailable in the bundled API3 WASM. It requires a core-source rebuild and controller regression test; frontend routing alone cannot implement it.
- Compilation and software GPU tests are not a real-phone performance benchmark.

Bundled graph: 53119189 compressed bytes (~50.7 MiB), 122399548 packed bytes (~116.7 MiB), 136817992 estimated CPU array bytes (~130.5 MiB).
