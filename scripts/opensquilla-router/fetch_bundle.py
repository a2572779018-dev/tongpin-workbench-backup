"""Materialize OpenSquilla's V4.2 Phase 3 router bundle at the pinned commit.

The binary router artifacts are Git LFS objects. This copies the bundle
directory out of an OpenSquilla checkout and replaces every LFS pointer with
the real object, downloaded from GitHub's LFS media endpoint for the pinned
commit when `git lfs pull` is not available, and verified against both the
pointer's oid/size and OpenSquilla's own artifact_manifest.json.

Usage: python fetch_bundle.py --clone <opensquilla checkout> --out <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

COMMIT = "d27ba0e7ac452392b7c8e38f2f7f43cd5d6912c6"
REPO = "TokenRhythm/opensquilla"
BUNDLE = "src/opensquilla/squilla_router/models/v4.2_phase3_inference"
POINTER = b"version https://git-lfs.github.com/spec/v1"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clone", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    head = subprocess.run(["git", "-C", str(args.clone), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    if head != COMMIT:
        raise SystemExit(f"OpenSquilla checkout is at {head}, expected {COMMIT}")
    source = args.clone / BUNDLE
    if args.out.exists():
        shutil.rmtree(args.out)
    shutil.copytree(source, args.out)

    manifest = json.loads((args.out / "artifact_manifest.json").read_text(encoding="utf-8"))
    expected = {entry["path"]: entry for entry in manifest["files"]}
    for path in sorted(p for p in args.out.rglob("*") if p.is_file()):
        data = path.read_bytes()
        if not data.startswith(POINTER):
            continue
        fields = dict(line.split(" ", 1) for line in data.decode("ascii").strip().splitlines())
        oid, size = fields["oid"].removeprefix("sha256:"), int(fields["size"])
        rel = path.relative_to(args.out).as_posix()
        url = f"https://media.githubusercontent.com/media/{REPO}/{COMMIT}/{BUNDLE}/{rel}"
        with urllib.request.urlopen(url, timeout=300) as response:
            blob = response.read()
        if len(blob) != size or sha256(blob) != oid:
            raise SystemExit(f"{rel}: downloaded object does not match its LFS pointer")
        path.write_bytes(blob)
        print(f"fetched {rel} ({size} bytes)")
    for rel, entry in expected.items():
        blob = (args.out / rel).read_bytes()
        if len(blob) != entry["size_bytes"] or sha256(blob) != entry["sha256"]:
            raise SystemExit(f"{rel}: does not match OpenSquilla's artifact_manifest.json")
    print(f"verified {len(expected)} files against artifact_manifest.json")


if __name__ == "__main__":
    main()
