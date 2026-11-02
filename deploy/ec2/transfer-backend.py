#!/usr/bin/env python3
"""Bundle only backend source/configuration and transfer via verified SSH."""
import argparse
import hashlib
import io
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("--identity", required=True)
parser.add_argument("--known-hosts", required=True)
parser.add_argument("--host", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
backend = root / "backend"
files = [backend / name for name in ("package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts")]
files += [p for dirname in ("src", "scripts") for p in (backend / dirname).rglob("*") if p.is_file() and p.suffix in (".ts", ".mjs", ".cjs", ".json")]
payload = io.BytesIO()
with tarfile.open(fileobj=payload, mode="w:gz") as archive:
    for path in sorted(files):
        archive.add(path, arcname="backend/" + path.relative_to(backend).as_posix(), recursive=False)
data = payload.getvalue()
digest = hashlib.sha256(data).hexdigest()
ssh = ["ssh", "-F", "NUL", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + args.known_hosts, "-o", "ConnectTimeout=10", "-i", args.identity, "ubuntu@" + args.host]
subprocess.run(ssh + ["umask 077; cat > /tmp/preventapro-backend.tgz"], input=data, check=True)
remote = subprocess.run(ssh + ["sha256sum /tmp/preventapro-backend.tgz"], capture_output=True, text=True, check=True).stdout.split()[0]
if remote != digest:
    raise RuntimeError("Transferred bundle differs from local source")
print(f"BACKEND_BUNDLE_VERIFIED files={len(files)} bytes={len(data)} sha256={digest}")
