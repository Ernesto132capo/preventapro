#!/usr/bin/env python3
"""Exercise the real backend against a fresh, explicitly synthetic database."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
database = "preventapro_simulation_" + stamp
root = Path("/var/lib/preventapro-validation") / stamp
backend = root / "backend"
backend.mkdir(parents=True, exist_ok=False)
source = Path("/opt/preventapro/backend")
for name in ("src", "scripts"):
    shutil.copytree(source / name, backend / name)
for name in ("package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts"):
    shutil.copy2(source / name, backend / name)
(backend / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
(backend / ".env.simulation").write_text("SIMULATION_CONFIRM=BASE_DE_PRUEBAS_VACIA\nSIMULATION_DATABASE_URL=postgresql://preventapro@localhost:5432/" + database + "?host=%2Fvar%2Frun%2Fpostgresql&sslmode=disable\n")
run("chown", "-R", "preventapro:preventapro", str(root))
run("chmod", "750", str(root))
run("runuser", "-u", "postgres", "--", "createdb", "--owner=preventapro", database)
env = {key: value for key, value in os.environ.items() if key not in ("DATABASE_URL", "AUTH_TOKEN_SECRET")}
run("runuser", "-u", "preventapro", "--", "node", "scripts/simulate-day.mjs", "--run", "--minutes", "0.1", "--orders", "100", "--products", "100", "--clients", "200", cwd=backend, env=env)
summaries = list((backend / ".simulation").glob("*/summary.json"))
if len(summaries) != 1:
    raise RuntimeError("Expected one isolated workload summary")
result = json.loads(summaries[0].read_text())
if result.get("completed") is not True:
    raise RuntimeError("Synthetic workday did not complete")
Path("/var/lib/preventapro-ops/workday-validation.json").write_text(json.dumps(result, indent=2) + "\n")
print("WORKDAY_VALIDATION_OK=" + str(summaries[0]))
print("ISOLATED_DATABASE=" + database)
