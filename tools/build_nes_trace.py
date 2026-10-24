#!/usr/bin/env python3
"""Rebuild the opt-in JSNES 2.1.0 CPU write tracer without npm dependencies.

The ordinary vendor bundle is never changed. Default builds use the checked-in
upstream CPU source. --fetch-source or --upstream-archive verifies the original
npm archive before checking that source; --check verifies generated artifacts.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "tools/vendor/jsnes"
ASSETS = ROOT / "app/src/main/assets/lab"
URL = "https://registry.npmjs.org/jsnes/-/jsnes-2.1.0.tgz"
ARCHIVE_SHA256 = "167081846a907e19bdd7cba75c648d827d49ea50e0fb58c079ad1a6613dee3c1"
CPU_SHA256 = "efbc3071930c51e2c941f26303aee8d4807733709009d605089b71b380c4211f"
LICENSE_SHA256 = "530136cec696ac1fcdeb792a77472cb273f9f814ad0ed795dccdc95db7423e0a"
NORMAL_CORE_SHA256 = "84946f0dae4bcf3b2dfebe84ad3bfeb1dbcb413bd9b1a69e1f45910a95fd7b41"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verified(data, expected, label):
    actual = sha256(data)
    if actual != expected:
        raise ValueError(f"{label} SHA256 mismatch: {actual} != {expected}")
    return data


def method(source, name, arguments=""):
    """Extract one intact upstream method, asserting its unique boundaries."""
    start = f"  {name}({arguments}) {{\n"
    if source.count(start) != 1:
        raise ValueError(f"Unexpected upstream {name} method count")
    begin = source.index(start)
    end = source.index("\n  }\n", begin) + len("\n  }\n")
    return source[begin:end]


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f"Unexpected upstream transform count for {old!r}")
    return source.replace(old, new)


INSTALLER = r'''
  // No CPU is constructed here. Only three methods on this one live CPU are
  // replaced; memory, mapper, callbacks and save-state serializers stay intact.
  const traceStates = new WeakMap();
  const methodNames = ["emulate", "write", "push"];

  function supports(core) {
    const cpu = core && core.cpu;
    if (!cpu || cpu.nes !== core || !cpu.mem || cpu.mem.length !== 0x10000 ||
        typeof cpu.mem.BYTES_PER_ELEMENT !== "number" ||
        cpu.mem.BYTES_PER_ELEMENT !== 1 ||
        typeof cpu.loadFromCartridge !== "function" ||
        typeof cpu._cyclesToNextDmcFetch !== "function" ||
        typeof cpu.doNonMaskableInterrupt !== "function" ||
        typeof cpu.loadDirect !== "function" ||
        typeof cpu.toJSON !== "function" || typeof cpu.fromJSON !== "function") {
      return false;
    }
    // This is a feature-shape guard for the pinned, unmodified JSNES 2.1.0
    // vendor core, not an assertion of compatibility with arbitrary NES cores.
    return methodNames.every(function (name) {
      const descriptor = Object.getOwnPropertyDescriptor(cpu, name);
      return typeof cpu[name] === "function" &&
        (!descriptor ? Object.isExtensible(cpu) : descriptor.configurable);
    });
  }

  function unknownBank(core, reason) {
    const mapper = core.rom && Number.isInteger(core.rom.mapperType)
      ? core.rom.mapperType : null;
    return {status: "UNKNOWN", mapper: mapper, physicalBank: null,
      bankOffset: null, prgOffset: null, bankSize: 16384, reason: reason};
  }

  function bankAtInstruction(core, pc) {
    const rom = core.rom;
    if (!rom || rom.mapperType !== 0 || !core.mmap ||
        !core.mmap.constructor || core.mmap.constructor.mapperName !== "NROM") {
      return unknownBank(core, "unsupported_mapper");
    }
    if (rom.romCount !== 1 && rom.romCount !== 2) {
      return unknownBank(core, "unsupported_prg_size");
    }
    if (pc < 0x8000) return unknownBank(core, "pc_outside_prg_rom");
    const bank = rom.romCount === 1 ? 0 : ((pc - 0x8000) >>> 14);
    const offset = pc & 0x3fff;
    return {status: "KNOWN", mapper: 0, physicalBank: bank,
      bankOffset: offset, prgOffset: bank * 16384 + offset,
      bankSize: 16384, reason: null};
  }

  function errorMessage(error) {
    try { return String(error && error.message || error).slice(0, 240); }
    catch (_) { return "unprintable error"; }
  }

  function fault(state, reason, error) {
    if (!state.active) return;
    state.active = false;
    state.reason = reason;
    state.faultMessage = errorMessage(error);
    try {
      if (state.onFault) {
        try { state.onFault({reason: reason, message: state.faultMessage}); }
        catch (_) { /* A diagnostic callback must never become a core fault. */ }
      }
    } finally {
      // A failed trace must leave the ordinary fast CPU methods installed,
      // including when the caller provided no diagnostic callback.
      restore(state);
    }
  }

  function traceStart(cpu, pc) {
    const state = traceStates.get(cpu);
    if (!state || !state.active) return;
    try {
      // Called after IRQ/reset service and immediately before the real opcode
      // fetch. Bank mapping is captured here, before any instruction writes.
      state.context = {writerPC: pc, opcode: null,
        bank: bankAtInstruction(state.core, pc)};
    } catch (error) { fault(state, "trace_fault", error); }
  }

  function traceOpcode(cpu, opcode) {
    const state = traceStates.get(cpu);
    if (state && state.context) state.context.opcode = opcode;
  }

  function traceEndInstruction(cpu) {
    const state = traceStates.get(cpu);
    if (state) state.context = null;
  }

  function writeRam(cpu, logicalAddress, value) {
    const address = logicalAddress & 0x7ff;
    const oldValue = cpu.mem[address];
    // This is the original write. Emission happens only after it succeeds.
    // Reading old/new values here accesses internal RAM, never mapper or I/O.
    cpu.mem[address] = value;
    const state = traceStates.get(cpu);
    if (!state || !state.active || state.delivering) return;
    try {
      const context = state.context && Number.isInteger(state.context.opcode)
        ? state.context : null;
      const newValue = cpu.mem[address];
      const pc = context ? context.writerPC : null;
      const bank = context ? Object.assign({}, context.bank)
        : unknownBank(state.core, "outside_instruction");
      const event = {address: address, logicalAddress: logicalAddress,
        oldValue: oldValue, newValue: newValue, value: newValue,
        writerPC: pc, writerPc: pc, opcode: context ? context.opcode : null,
        origin: context ? "cpu" : "unknown",
        // Only actual JSNES writes emit. This helper makes no claim of a
        // cycle-accurate hardware bus trace or an established bus-cycle phase.
        cycle: null, cycleStatus: "UNKNOWN",
        bank: bank};
      state.delivering = true;
      try { state.onWrite(event); }
      finally { state.delivering = false; }
    } catch (error) { fault(state, "sink_fault", error); }
  }

  function restore(state) {
    if (!state.attached) return;
    // Undo additions in reverse order so engines can recover the prior object
    // shape where possible. Exact descriptor restoration remains the contract.
    methodNames.slice().reverse().forEach(function (name) {
      const descriptor = state.originalDescriptors[name];
      if (descriptor) Object.defineProperty(state.cpu, name, descriptor);
      else delete state.cpu[name];
    });
    state.attached = false;
    state.context = null;
    traceStates.delete(state.cpu);
  }

  function attach(core, options) {
    if (!supports(core)) throw new TypeError("Requires the pinned JSNES 2.1.0 CPU");
    if (!options || typeof options.onWrite !== "function") {
      throw new TypeError("onWrite callback is required");
    }
    const cpu = core.cpu;
    if (traceStates.has(cpu)) throw new Error("CPU write trace is already attached");
    const descriptors = {};
    methodNames.forEach(function (name) {
      descriptors[name] = Object.getOwnPropertyDescriptor(cpu, name);
    });
    const state = {core: core, cpu: cpu, onWrite: options.onWrite,
      onFault: typeof options.onFault === "function" ? options.onFault : null,
      originalDescriptors: descriptors, attached: true, active: true,
      context: null, executing: false, delivering: false, reason: null,
      faultMessage: null};
    traceStates.set(cpu, state);
    const methods = {
      emulate: function () {
        state.context = null;
        state.executing = true;
        try { return InstrumentedCPU.prototype.emulate.apply(this, arguments); }
        catch (error) {
          fault(state, "core_fault", error);
          restore(state);
          throw error;
        } finally {
          state.context = null;
          state.executing = false;
        }
      },
      write: InstrumentedCPU.prototype.write,
      push: InstrumentedCPU.prototype.push
    };
    try {
      methodNames.forEach(function (name) {
        Object.defineProperty(cpu, name, {value: methods[name],
          writable: true, enumerable: descriptors[name] ? descriptors[name].enumerable : false,
          configurable: true});
      });
    } catch (error) { restore(state); throw error; }
    return {
      detach: function () {
        state.active = false;
        if (!state.reason) state.reason = "detached";
        restore(state);
      },
      getStatus: function () {
        return {active: state.active, attached: state.attached,
          reason: state.reason, faultMessage: state.faultMessage};
      }
    };
  }

  global.FlyNesWriteTrace = Object.freeze({attach: attach, supports: supports,
    coreVersion: "jsnes-2.1.0", schemaVersion: 1});
})(typeof globalThis !== "undefined" ? globalThis : this);
'''


def generate(cpu):
    source = cpu.decode("utf-8")
    prefix = 'import { fromJSON, toJSON } from "./utils.js";\n'
    if not source.startswith(prefix) or source.count("\nclass CPU {") != 1:
        raise ValueError("Unexpected upstream CPU module layout")
    constants = source[len(prefix):source.index("\nclass CPU {")]
    emulate = method(source, "emulate")
    direct_writes = re.findall(r"this\.mem\[[^\n]+?\]\s*=", emulate)
    if direct_writes:
        raise ValueError("New uninstrumented direct RAM write in emulate")
    emulate = replace_once(emulate,
        "    let opcode = this.loadFromCartridge(this.REG_PC + 1);\n",
        "    traceStart(this, (this.REG_PC + 1) & 0xffff);\n"
        "    let opcode = this.loadFromCartridge(this.REG_PC + 1);\n"
        "    traceOpcode(this, opcode);\n")
    emulate = replace_once(emulate,
        "    // Fire NMI after the instruction completes.",
        "    traceEndInstruction(this);\n\n"
        "    // Fire NMI after the instruction completes.")
    write = replace_once(method(source, "write", "addr, val"),
        "        this.mem[addr & 0x7ff] = val;",
        "        writeRam(this, addr, val);")
    push = replace_once(method(source, "push", "value"),
        "    this.mem[this.REG_SP | 0x100] = value;",
        "    writeRam(this, this.REG_SP | 0x100, value);")
    header = '''// Generated by tools/build_nes_trace.py; do not edit this artifact.
// Opt-in CPU methods derived from JSNES 2.1.0, licensed Apache-2.0.
// Upstream: https://registry.npmjs.org/jsnes/-/jsnes-2.1.0.tgz
// See nes-write-trace-source.json and nes-write-trace-LICENSE.txt.
// The ordinary jsnes.min.js bundle and its CPU prototype are unchanged.
(function (global) {
  "use strict";
'''
    return (header + constants + "\nclass InstrumentedCPU {\n" + emulate +
            "\n" + write + "\n" + push + "}\n" + INSTALLER).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without writing")
    parser.add_argument("--fetch-source", action="store_true", help="verify pinned npm tarball online")
    parser.add_argument("--upstream-archive", type=Path, help="verify a previously downloaded npm tarball")
    args = parser.parse_args()
    cpu = verified((VENDOR / "cpu.js").read_bytes(), CPU_SHA256, "CPU source")
    license_text = verified((VENDOR / "LICENSE").read_bytes(), LICENSE_SHA256, "license")
    verified((ASSETS / "jsnes.min.js").read_bytes(), NORMAL_CORE_SHA256, "ordinary vendor core")
    if args.fetch_source and args.upstream_archive:
        parser.error("choose --fetch-source or --upstream-archive")
    if args.fetch_source or args.upstream_archive:
        if args.fetch_source:
            request = urllib.request.Request(URL, headers={"User-Agent": "FlyConsole-NES-trace-build"})
            with urllib.request.urlopen(request, timeout=60) as response:
                archive = response.read()
        else:
            archive = args.upstream_archive.read_bytes()
        verified(archive, ARCHIVE_SHA256, "npm archive")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            for name, expected in [("package/src/cpu.js", cpu), ("package/LICENSE", license_text)]:
                member = tar.extractfile(name)
                if not member or member.read() != expected:
                    raise ValueError(f"Vendored bytes differ from pinned archive: {name}")
            verified(tar.extractfile("package/dist/jsnes.min.js").read(), NORMAL_CORE_SHA256, "upstream vendor core")
    bundle = generate(cpu)
    metadata = {
        "package": "jsnes", "version": "2.1.0", "license": "Apache-2.0",
        "upstream_archive_url": URL, "upstream_archive_sha256": ARCHIVE_SHA256,
        "upstream_cpu_path": "package/src/cpu.js", "upstream_cpu_sha256": CPU_SHA256,
        "upstream_license_sha256": LICENSE_SHA256,
        "ordinary_core_sha256": NORMAL_CORE_SHA256,
        "build_script": "tools/build_nes_trace.py",
        "build_script_sha256": sha256(Path(__file__).read_bytes()),
        "generated_bundle_sha256": sha256(bundle),
        "schema_version": 1,
        "transforms": {"opcode_fetch_context": 1, "instruction_end_context": 1,
            "cpu_write_ram_assignment": 1, "stack_push_ram_assignment": 1,
            "emulate_direct_ram_assignments": 0},
        "compatibility": "Pinned unmodified JSNES 2.1.0 only; runtime CPU feature-shape guard",
        "coverage": "Actual core internal-RAM writes from CPU.write and CPU.push; no I/O reads; interrupt/outside-instruction PCs unknown",
        "bank_mapping": "NROM mapper 0 with 16/32 KiB PRG only; all other mappings UNKNOWN",
    }
    artifacts = {
        "nes-write-trace.js": bundle,
        "nes-write-trace-source.json": (json.dumps(metadata, indent=2) + "\n").encode(),
        "nes-write-trace-LICENSE.txt": license_text,
    }
    for name, content in artifacts.items():
        target = ASSETS / name
        if args.check:
            if not target.exists() or target.read_bytes() != content:
                raise ValueError(f"Generated artifact is stale: {target.relative_to(ROOT)}")
        else:
            target.write_bytes(content)
    print(f"NES write trace {'verified' if args.check else 'built'}: {sha256(bundle)}")


if __name__ == "__main__":
    main()
