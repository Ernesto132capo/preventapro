#!/usr/bin/env python3
"""Restore an actual application backup downloaded from S3, then enable its timer."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import uuid
import boto3

def pg(database, sql):
    return subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", "SET timezone='UTC'; " + sql], check=True, capture_output=True, text=True).stdout.strip()

def inventory(database):
    tables = json.loads(pg(database, "SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"))
    result = {}
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        query = "SELECT row_to_json(x) FROM (SELECT count(*)::text AS rows, coalesce(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))),md5('')) AS digest FROM public." + quoted + " t) x"
        result[table] = json.loads(pg(database, query))
    return result

before = inventory("preventapro")
backup = subprocess.run(["python3", "/usr/local/lib/preventapro-ops/ops.py", "backup"], check=True, capture_output=True, text=True)
archive = Path(next(line.split("=", 1)[1] for line in backup.stdout.splitlines() if line.startswith("BACKUP_FILE=")))
metadata = json.loads(archive.with_suffix(".json").read_text())
cfg = json.loads(Path("/etc/preventapro/ops.json").read_text())
downloaded = archive.with_suffix(".verification.dump")
database = "preventapro_restorecheck_" + uuid.uuid4().hex[:12]
created = False
try:
    boto3.client("s3", region_name=cfg["region"]).download_file(metadata["bucket"], metadata["key"], str(downloaded))
    downloaded.chmod(0o600)
    if hashlib.sha256(downloaded.read_bytes()).hexdigest() != metadata["sha256"]:
        raise RuntimeError("S3 download checksum mismatch")
    subprocess.run(["runuser", "-u", "postgres", "--", "createdb", "--template=template0", database], check=True)
    created = True
    with downloaded.open("rb") as source:
        subprocess.run(["runuser", "-u", "postgres", "--", "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname=" + database], stdin=source, check=True, capture_output=True)
    if inventory(database) != before:
        raise RuntimeError("Restored application tables differ from the backed-up database")
    result = {"verified_at": datetime.now(timezone.utc).isoformat(), "tables_verified": len(before), "sha256": metadata["sha256"], "bytes": metadata["bytes"], "bucket": metadata["bucket"], "key": metadata["key"]}
    Path("/var/lib/preventapro-ops/backup-verification.json").write_text(json.dumps(result, indent=2) + "\n")
    Path("/etc/preventapro/backup.enabled").touch(mode=0o600, exist_ok=True)
    print("APPLICATION_BACKUP_RESTORE_OK=" + json.dumps(result))
finally:
    if created:
        subprocess.run(["runuser", "-u", "postgres", "--", "dropdb", database], check=True)
    downloaded.unlink(missing_ok=True)
