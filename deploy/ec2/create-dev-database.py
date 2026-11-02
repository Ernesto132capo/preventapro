#!/usr/bin/env python3
"""Create an isolated development database; read its password only from stdin."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

password = json.load(sys.stdin)["password"]
if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", password):
    raise ValueError("Invalid development password format")

def sql(statement):
    result = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-d", "postgres"], input=statement, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Development database setup failed; no credentials are printed")
    return result.stdout.strip()

if sql("SELECT count(*) FROM pg_database WHERE datname='preventapro_dev'") != "0" or sql("SELECT count(*) FROM pg_roles WHERE rolname='preventapro_dev'") != "0":
    raise RuntimeError("Development role/database already exists; refusing to replace it")

sql("CREATE ROLE preventapro_dev LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 10 PASSWORD '" + password + "';\nCREATE DATABASE preventapro_dev OWNER preventapro_dev;")

# SSH forwarding terminates at IPv4 localhost. Only this database accepts the new role.
hba = Path(sql("SHOW hba_file"))
original = hba.read_text()
backup = hba.with_name("pg_hba.conf.before-preventapro-dev")
if not backup.exists():
    shutil.copy2(hba, backup)
    backup.chmod(0o600)
rules = "# PreventaPro isolated development role\nhost preventapro_dev preventapro_dev 127.0.0.1/32 scram-sha-256\nhost all preventapro_dev 0.0.0.0/0 reject\nhost all preventapro_dev ::/0 reject\nlocal all preventapro_dev reject\n"
temporary = hba.with_name("pg_hba.conf.preparing")
temporary.write_text(rules + original)
stat = hba.stat()
os.chown(temporary, stat.st_uid, stat.st_gid)
temporary.chmod(stat.st_mode & 0o777)
temporary.replace(hba)
subprocess.run(["pg_ctlcluster", "18", "main", "reload"], check=True)
print("ISOLATED_DEVELOPMENT_DATABASE_CREATED")
