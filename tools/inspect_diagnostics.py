#!/usr/bin/env python3
"""Read GU's local ZIP without extraction. Verify evidence; never certify an Android test from events alone."""
import argparse
import collections
import hashlib
import json
import math
import pathlib
import re
import sys
import zipfile

SAFE = re.compile(r"(?:manifest\.json|events/events-\d{12}\.jsonl|episodes/[a-f0-9-]{36}\.(?:open|closed)\.json|evaluations/[a-f0-9-]{36}\.json|comparisons/[a-f0-9-]{36}\.result\.json)\Z")


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def inspect(path):
    errors, warnings, events, proofs = [], [], [], []
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if len(entries) > 300 or len(names) != len(set(names)):
            raise ValueError("duplicate entries or too many files")
        if any(not SAFE.fullmatch(item.filename) or item.file_size > 1024 * 1024 for item in entries):
            raise ValueError("unexpected path or oversized entry")
        if sum(item.file_size for item in entries) > 16 * 1024 * 1024:
            raise ValueError("uncompressed report exceeds 16 MiB")
        manifest = json.loads(archive.read("manifest.json"))
        if not isinstance(manifest, dict) or manifest.get("type") != "gu-device-diagnostics" or manifest.get("version") != 1:
            raise ValueError("unsupported report type/version")
        descriptors = manifest.get("files", [])
        described = [item["path"] for item in descriptors]
        if len(described) != len(set(described)) or set(described) != set(names) - {"manifest.json"}:
            raise ValueError("manifest does not describe exactly the exported files")
        invalid = 0
        for item in descriptors:
            name = item["path"]
            raw = archive.read(name)
            if len(raw) != item.get("bytes") or hashlib.sha256(raw).hexdigest() != item.get("sha256"):
                errors.append({"file": name, "reason": "file checksum/size mismatch"})
                continue
            if name.startswith("events/"):
                for line_number, row in enumerate(raw.splitlines(), 1):
                    if not row:
                        continue
                    try:
                        if len(row) > 16 * 1024:
                            raise ValueError("oversized event")
                        box = json.loads(row)
                        payload = box["payload"]
                        if box.get("version") != 1 or not isinstance(payload, str) or hashlib.sha256(payload.encode()).hexdigest() != box.get("sha256"):
                            raise ValueError("event checksum mismatch")
                        event = json.loads(payload)
                        if not isinstance(event, dict) or not isinstance(event.get("runId"), str) or not isinstance(event.get("sequence"), int) or not isinstance(event.get("data"), dict) or not isinstance(event.get("context"), dict):
                            raise ValueError("invalid event identity")
                        events.append(event)
                    except (ValueError, KeyError, TypeError, UnicodeError) as error:
                        invalid += 1
                        errors.append({"file": name, "line": line_number, "reason": str(error)})
            elif name.startswith("evaluations/"):
                try:
                    proof = json.loads(raw).get("report", {})
                    proofs.append({"id": proof.get("id"), "valid": proof.get("valid"), "completed": proof.get("completed"), "reason": proof.get("reason"), "expectedTrials": proof.get("expectedTrials"), "trials": len(proof.get("trials", [])), "beforeFdb": proof.get("beforeFdb"), "afterFdb": proof.get("afterFdb"), "context": proof.get("context")})
                except (ValueError, TypeError):
                    errors.append({"file": name, "reason": "invalid proof JSON"})
        if invalid != manifest.get("invalidRows", 0):
            errors.append({"reason": "invalid-row count differs from exporter manifest"})
    if manifest.get("skippedAttachments"):
        warnings.append({"reason": "some history/proof attachments omitted by export limits", "count": manifest["skippedAttachments"]})
    metadata = manifest.get("metadata", {})
    recorder = metadata.get("recorder", {})
    for key in ("droppedEvents", "writeErrors"):
        if recorder.get(key):
            warnings.append({"reason": key, "count": recorder[key]})
    counts = collections.Counter()
    severity = collections.Counter()
    runs = collections.defaultdict(list)
    operation_begins, operation_ends = {}, {}
    observations, failures, metrics, devices, lifecycle = [], [], [], [], []
    for event in events:
        run = event["runId"]
        runs[run].append(event["sequence"])
        name, level = event.get("name", "unknown"), event.get("level", "unknown")
        counts[name] += 1
        severity[level] += 1
        data = event.get("data", {})
        if event.get("component") == "web":
            context = data.get("clientContext", {})
            details = data.get("details", {})
            client = data.get("clientId")
        else:
            context, details, client = event.get("context", {}), data, None
        summary = {"runId": run, "clientId": client, "at": event.get("at"), "elapsedMs": event.get("elapsedMs"), "name": name, "context": context, "details": details}
        if level in ("warn", "error", "fatal"):
            failures.append(summary)
        if name == "user.observation":
            observations.append(summary)
        if name == "performance.window":
            metrics.append(summary)
            for key in ("frontendDropped", "acknowledgementsLost", "unconfirmedEvents"):
                if details.get(key):
                    warnings.append({"reason": key, "clientId": client, "count": details[key]})
        if name == "logger.frontend-loss":
            warnings.append({"reason": "frontend queue loss or unconfirmed delivery", "details": details})
        if name == "device.metrics":
            devices.append(summary)
        if name.startswith("lifecycle."):
            lifecycle.append(summary)
        operation = details.get("operationId")
        if operation:
            identity = (run, client, operation)
            if name.endswith(".begin"):
                operation_begins[identity] = summary
            elif name.endswith(".end"):
                operation_ends[identity] = summary
    gaps = []
    for run, values in runs.items():
        ordered = sorted(set(values))
        if len(ordered) != len(values):
            errors.append({"runId": run, "reason": "duplicate native event sequence"})
        for before, after in zip(ordered, ordered[1:]):
            if after != before + 1:
                gaps.append({"runId": run, "after": before, "before": after, "missing": after - before - 1})
    if gaps:
        warnings.append({"reason": "sequence gaps inside retained history", "gaps": gaps})
    incomplete = [value for key, value in operation_begins.items() if key not in operation_ends]
    # Rotation may remove the beginning of an otherwise retained operation. Report it, do not infer failure.
    orphan_ends = [value for key, value in operation_ends.items() if key not in operation_begins]
    sampled_systems = sorted({m["context"].get("system") for m in metrics if m["context"].get("system")})
    return {
        "type": "gu-diagnostics-inspection", "version": 1,
        "integrity": {"ok": not errors, "errors": errors, "validEvents": len(events)},
        "collectionWarnings": warnings,
        "app": metadata,
        "previousProcess": manifest.get("journal", {}).get("previousProcess"),
        "eventCounts": dict(counts), "severityCounts": dict(severity), "runs": len(runs),
        "observed": {"systemsWithFrameMetrics": sampled_systems, "gameSaveOutcomes": {"ok": sum(v["name"] == "game.save.end" and v["details"].get("ok") is True for v in operation_ends.values()), "failed": sum(v["name"] == "game.save.end" and v["details"].get("ok") is False for v in operation_ends.values())}, "gameLoadOutcomes": {"ok": sum(v["name"] == "game.load.end" and v["details"].get("ok") is True for v in operation_ends.values()), "failed": sum(v["name"] == "game.load.end" and v["details"].get("ok") is False for v in operation_ends.values())}, "lifecycleAcknowledgements": counts["lifecycle.saved"], "frozenProofsAttached": len(proofs)},
        "operations": {"beginsWithoutRetainedEnd": incomplete, "endsWithoutRetainedBegin": orphan_ends, "completed": list(operation_ends.values())},
        "failuresAndWarnings": failures, "userObservations": observations,
        "performanceWindows": metrics, "nativeProcessMetrics": devices, "lifecycle": lifecycle, "frozenProofs": proofs,
        "notVerifiedByThisTool": ["audio synchronization", "physical control correctness", "whole-device RAM/CPU/GPU utilization", "calibrated energy use", "absence of memory leaks", "power-loss guarantees", "functional learning of the full connectome"],
        "conclusion": "Observed evidence only. Event presence and valid checksums do not certify the application or prove learning.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path)
    args = parser.parse_args()
    try:
        report = inspect(args.report)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, zipfile.BadZipFile) as error:
        report = {"type": "gu-diagnostics-inspection", "version": 1, "integrity": {"ok": False, "errors": [{"reason": str(error)}]}}
    result = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(result, encoding="utf-8")
    else:
        sys.stdout.write(result)
    return 0 if report["integrity"]["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
