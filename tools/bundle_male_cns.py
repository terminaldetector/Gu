#!/usr/bin/env python3
"""Download immutable public Male CNS exports, verify, and package offline FLY1."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request

from convert_male_cns import convert


MANIFEST = Path(__file__).with_name("male_cns_sources.json")


def verify(path, item):
    md5 = hashlib.md5()
    sha = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as stream:
        while block := stream.read(1024*1024):
            size += len(block)
            md5.update(block)
            sha.update(block)
    if size != item["bytes"] or base64.b64encode(md5.digest()).decode() != item["md5_base64"]:
        raise ValueError("Source fingerprint mismatch: " + item["name"])
    if "sha256" in item and sha.hexdigest() != item["sha256"]:
        raise ValueError("Source SHA256 mismatch: " + item["name"])
    return sha.hexdigest()


def prepare(directory, manifest):
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for role, item in manifest["files"].items():
        path = directory/item["name"]
        if not path.exists():
            partial = path.with_suffix(path.suffix+".partial")
            url = manifest["base_url"]+item["name"]+"?generation="+item["generation"]
            print("Downloading", role, item["bytes"], "bytes", flush=True)
            received = 0
            with urllib.request.urlopen(url, timeout=120) as source, partial.open("wb") as destination:
                while block := source.read(1024*1024):
                    received += len(block)
                    if received > item["bytes"]:
                        raise ValueError("Source exceeds pinned byte length: " + item["name"])
                    destination.write(block)
            verify(partial, item)
            partial.replace(path)
        verify(path, item)
        paths[role] = path
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, help="Optional reusable verified source cache")
    parser.add_argument("--output", type=Path, default=Path("app/src/main/assets/male-cns.fly.gz"))
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    with tempfile.TemporaryDirectory(prefix="male-cns-source-") as temporary:
        paths = prepare(args.cache or Path(temporary), manifest)
        result = convert(paths["connectivity"], paths["annotations"], paths["neurotransmitters"],
                         args.output, MANIFEST)
    # v1.0's complete Traced universe is not the 166,700 paper figure, and it
    # must never silently become a small-region graph under the same model ID.
    if result["neurons"] != 165122 or result["edges"] != 25563197 or result["synapse_count"] != 124025046 or result["excluded_non_traced_edges"]:
        raise ValueError("Official Traced graph universe changed")
    print(json.dumps({key: result[key] for key in ("model_id", "neurons", "edges", "gzip_bytes",
          "runtime_array_budget_bytes", "graph_sha256", "gzip_sha256")}, indent=2))


if __name__ == "__main__":
    main()
