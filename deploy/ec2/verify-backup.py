#!/usr/bin/env python3
"""Round-trip synthetic data through the actual backup tool and restore it."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--s3", action="store_true")
args = parser.parse_args()
prefix = "preventapro_check_" + uuid.uuid4().hex[:12]
source, restored = prefix + "_src", prefix + "_dst"
created = []
archive = None

def pg(*command):
    return subprocess.run(["runuser", "-u", "postgres", "--", *command], check=True, capture_output=True, text=True)

try:
    for database in (source, restored):
        pg("createdb", database)
        created.append(database)
    pg("psql", "-X", "--set=ON_ERROR_STOP=1", "--dbname", source, "--command", "CREATE TABLE backup_check(id integer PRIMARY KEY, label text, cents bigint); INSERT INTO backup_check VALUES (1, 'prueba sintética', 12345), (2, 'combo', 0);")
    command = ["python3", "/usr/local/lib/preventapro-ops/ops.py", "backup", "--database", source]
    if not args.s3:
        command.append("--local-only")
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    archive = Path(next(line.split("=", 1)[1] for line in result.stdout.splitlines() if line.startswith("BACKUP_FILE=")))
    if args.s3:
        import boto3
        cfg = json.loads(Path("/etc/preventapro/ops.json").read_text())
        metadata = json.loads(archive.with_suffix(".json").read_text())
        downloaded = archive.with_suffix(".downloaded.dump")
        boto3.client("s3", region_name=cfg["region"]).download_file(metadata["bucket"], metadata["key"], str(downloaded))
        if hashlib.sha256(downloaded.read_bytes()).hexdigest() != metadata["sha256"]:
            raise RuntimeError("Downloaded backup checksum mismatch")
        restore_file = downloaded
    else:
        restore_file = archive
    # Root owns the archive; stream it to pg_restore running as postgres.
    with restore_file.open("rb") as body:
        subprocess.run(["runuser", "-u", "postgres", "--", "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", restored], stdin=body, check=True, capture_output=True)
    value = pg("psql", "-X", "-At", "--dbname", restored, "--command", "SELECT json_agg(row_to_json(t) ORDER BY id) FROM backup_check t;").stdout.strip()
    expected = [{"id": 1, "label": "prueba sintética", "cents": 12345}, {"id": 2, "label": "combo", "cents": 0}]
    if json.loads(value) != expected:
        raise RuntimeError("Restored rows differ from source")
    print("BACKUP_RESTORE_OK=" + ("S3" if args.s3 else "LOCAL"))
    print("Verified two synthetic rows, text and exact integer cents")
finally:
    for database in reversed(created):
        pg("dropdb", database)
    if archive is not None:
        archive.unlink(missing_ok=True)
        archive.with_suffix(".json").unlink(missing_ok=True)
        archive.with_suffix(".downloaded.dump").unlink(missing_ok=True)
