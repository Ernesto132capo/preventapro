#!/usr/bin/env python3
"""Build a staged release as an unprivileged user, then install without secrets."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

bundle = Path("/tmp/preventapro-backend.tgz")
release = Path("/opt/preventapro/releases") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
release.mkdir(parents=True, exist_ok=False)
with tarfile.open(bundle) as archive:
    for member in archive.getmembers():
        if member.name.startswith("/") or ".." in Path(member.name).parts or not member.isfile() or Path(member.name).name.startswith(".env"):
            raise RuntimeError("Unsafe bundle entry")
    archive.extractall(release, filter="data")
backend = release / "backend"
run("chown", "-R", "ubuntu:ubuntu", str(release))
for command in (("npm", "ci", "--no-fund", "--no-audit"), ("npm", "run", "build"), ("npm", "test", "--", "--maxWorkers=2", "--minWorkers=1"), ("npm", "run", "test:simulation")):
    run("runuser", "-u", "ubuntu", "--", *command, cwd=backend)
destination = Path("/opt/preventapro/backend")
if (destination / "package.json").exists() or (destination / "dist/index.js").exists():
    raise RuntimeError("A backend is already installed; keep the staged release and switch it explicitly")
for name in ("package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "src", "scripts", "dist", "node_modules"):
    shutil.move(str(backend / name), str(destination / name))
run("chown", "-R", "root:preventapro", str(destination))
run("chmod", "-R", "g+rX,o-rwx", str(destination))
run("chown", "preventapro:preventapro", str(destination / "reports"))
run("chmod", "750", str(destination / "reports"))
manifest = {"installed_at": datetime.now(timezone.utc).isoformat(), "bundle_sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(), "node": run("node", "--version", capture_output=True, text=True).stdout.strip(), "tests": "backend and simulation passed"}
Path("/var/lib/preventapro-ops/release.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("BACKEND_INSTALLED=" + json.dumps(manifest))
