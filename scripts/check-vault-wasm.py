#!/usr/bin/env python3
"""Check the release size budget and publish a checksum plus build provenance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("wasm", type=Path)
parser.add_argument("--max-bytes", type=int, default=65_536,
                    help="repository budget, kept below Soroban's 128 KiB limit")
args = parser.parse_args()
wasm = args.wasm.resolve()
data = wasm.read_bytes()
if not data.startswith(b"\x00asm\x01\x00\x00\x00") or len(data) <= 8:
    parser.error("not a non-empty WebAssembly v1 module")
if len(data) > args.max_bytes:
    parser.error(f"Wasm size {len(data)} exceeds budget {args.max_bytes} bytes")
root = Path(__file__).resolve().parent.parent
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"],
                                    cwd=root, text=True).strip())
digest = hashlib.sha256(data).hexdigest()
metadata = {"commit": commit, "dirty": dirty, "sha256": digest,
            "size_bytes": len(data), "budget_bytes": args.max_bytes,
            "target": "wasm32v1-none", "profile": "release",
            "rustc": subprocess.check_output(["rustc", "+1.94.1", "--version"], text=True).strip()}
wasm.with_suffix(".wasm.sha256").write_text(f"{digest}  {wasm.name}\n")
wasm.with_suffix(".wasm.json").write_text(json.dumps(metadata, indent=2) + "\n")
summary = (f"### Agent vault Wasm\n\n"
           f"- Commit: `{commit}` (dirty: `{str(dirty).lower()}`)\n"
           f"- Build: `{metadata['rustc']}`, `wasm32v1-none --release --locked`\n"
           f"- Size: **{len(data)} bytes** / {args.max_bytes} byte budget\n"
           f"- SHA-256: `{digest}`\n")
print(summary)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
        output.write(summary)
