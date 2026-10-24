# JSNES CPU source for the opt-in write tracer

`cpu.js` and `LICENSE` are byte-for-byte copies of `package/src/cpu.js` and
`package/LICENSE` from JSNES 2.1.0's npm archive:

https://registry.npmjs.org/jsnes/-/jsnes-2.1.0.tgz

Archive SHA256:
`167081846a907e19bdd7cba75c648d827d49ea50e0fb58c079ad1a6613dee3c1`.

`python3 tools/build_nes_trace.py` verifies the pinned source and produces the
readable `nes-write-trace.js` helper, its source metadata and Apache-2.0 license.
`--check` compares those artifacts without writing them. `--fetch-source`
verifies the original npm archive online; `--upstream-archive PATH` performs
the same verification using a local copy. Both also compare the original CPU,
license and ordinary minified distribution against the checked-in bytes.

The build extracts the upstream opcode constants and only the `emulate`,
`write` and `push` methods. Each transform asserts the expected site count.
The pinned upstream `emulate` has no direct RAM assignments: all instruction
writes go through `write`, while stack pushes write directly in `push`.
The generated helper replaces these three methods on one live CPU instance;
it neither constructs another CPU nor changes its serializer or the ordinary
vendor bundle. Detach restores the exact original property descriptors.

Compatibility is limited to the pinned unmodified JSNES 2.1.0 distribution;
runtime feature checks do not prove arbitrary compatible-looking cores safe.
Events describe writes actually performed by JSNES, with unknown cycle phase.
Only instruction writes have known writer PCs and `cpu` origin; interrupt and
outside-instruction writes have unknown PCs and origin. NROM mapper 0 with one
or two 16 KiB PRG banks has known physical bank/offset provenance; every other
mapping is explicitly unknown. No mapper or I/O reads are added for tracing.
