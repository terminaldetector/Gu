#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("diagnostics", pathlib.Path(__file__).with_name("inspect_diagnostics.py"))
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


def fixture(path, tamper=False, unsafe=False, partial=False):
    events = []
    for sequence, (name, data) in enumerate([
        ("game.save.begin", {"operationId": "save"}),
        ("game.save.end", {"operationId": "save", "ok": True}),
        ("game.load.begin", {"operationId": "load"}),
        ("game.load.end", {"operationId": "load", "ok": False, "message": "Повреждено… <тест>"}),
        ("performance.window", {"emulatorFrames": 300, "intervalMs": 5000, "actualFps": 60, "coreExecutionMs": {"p95": 1e-8}}),
    ], 1):
        event = {"runId": "fixture-run", "sequence": sequence, "name": name, "level": "error" if data.get("ok") is False else "info", "at": sequence, "elapsedMs": sequence, "component": "web", "context": {}, "data": {"clientId": "fixture-page", "details": data, "clientContext": {"system": "nes", "romHash": "a" * 64, "playing": True}}}
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        events.append(json.dumps({"version": 1, "payload": payload, "sha256": hashlib.sha256(payload.encode()).hexdigest()}))
    raw = ("\n".join(events) + "\n" + ("{partial" if partial else "")).encode()
    filename = "events/events-000000000001.jsonl"
    manifest = {"type": "gu-device-diagnostics", "version": 1, "metadata": {"sourceId": "fixture", "recorder": {"droppedEvents": 0}}, "invalidRows": int(partial), "files": [{"path": filename, "bytes": len(raw), "sha256": "0" * 64 if tamper else hashlib.sha256(raw).hexdigest()}]}
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr(filename, raw)
        if unsafe:
            archive.writestr("../escape", "never extracted")


with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / "report.zip"
    fixture(path)
    report = diagnostics.inspect(path)
    assert report["integrity"]["ok"] and report["integrity"]["validEvents"] == 5
    assert report["observed"]["gameSaveOutcomes"] == {"ok": 1, "failed": 0}
    assert report["observed"]["gameLoadOutcomes"] == {"ok": 0, "failed": 1}
    assert report["failuresAndWarnings"][0]["details"]["message"] == "Повреждено… <тест>"
    assert report["observed"]["systemsWithFrameMetrics"] == ["nes"]
    assert report["notVerifiedByThisTool"] and "not certify" in report["conclusion"]
    fixture(path, tamper=True)
    assert not diagnostics.inspect(path)["integrity"]["ok"]
    fixture(path, partial=True)
    assert not diagnostics.inspect(path)["integrity"]["ok"]
    fixture(path, unsafe=True)
    try:
        diagnostics.inspect(path)
        raise AssertionError("unsafe ZIP accepted")
    except ValueError:
        pass
print("PASS: portable Unicode/numeric payload checksums, raw ZIP hashes, correlated successful/failed saves, actual metric scope, partial-tail/corruption/traversal rejection and explicit acceptance limits")
