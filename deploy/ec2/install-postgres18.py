#!/usr/bin/env python3
"""Install PostgreSQL 18 from its official repository and use the empty host port."""
from pathlib import Path
import subprocess
import urllib.request

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def sql(version, statement):
    return run("runuser", "-u", "postgres", "--", "psql", "--cluster", f"{version}/main", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", statement, capture_output=True, text=True).stdout.strip()

key = Path("/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc")
key.parent.mkdir(parents=True, exist_ok=True)
with urllib.request.urlopen("https://www.postgresql.org/media/keys/ACCC4CF8.asc", timeout=30) as response:
    key.write_bytes(response.read())
fingerprints = run("gpg", "--show-keys", "--with-colons", str(key), capture_output=True, text=True).stdout
if "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8" not in fingerprints:
    raise RuntimeError("PostgreSQL repository key fingerprint differs from official documentation")
Path("/etc/apt/sources.list.d/pgdg.sources").write_text("Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nArchitectures: amd64\nComponents: main\nSigned-By: " + str(key) + "\n")
run("apt-get", "update", "-qq")
run("apt-get", "install", "-y", "postgresql-18", "postgresql-client-18", env={**__import__("os").environ, "DEBIAN_FRONTEND": "noninteractive"})
# Keep major-version changes deliberate while still accepting PostgreSQL 18 patches.
run("apt-mark", "hold", "postgresql")
if not Path("/etc/postgresql/18/main/postgresql.conf").exists():
    run("pg_createcluster", "18", "main", "--start")
run("pg_conftool", "18", "main", "set", "listen_addresses", "localhost")
port = run("pg_conftool", "18", "main", "show", "port", capture_output=True, text=True).stdout.strip()
if not port.endswith("5432"):
    # Never take the old cluster's port if it contains any application database.
    if sql("16", "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate") != "postgres":
        raise RuntimeError("PostgreSQL 16 contains application databases; preserve and migrate them explicitly")
    if sql("16", "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')") != "0":
        raise RuntimeError("The PostgreSQL 16 maintenance database contains user tables")
    run("pg_ctlcluster", "18", "main", "stop")
    run("pg_ctlcluster", "16", "main", "stop")
    Path("/etc/postgresql/16/main/start.conf").write_text("manual\n")
    run("pg_conftool", "18", "main", "set", "port", "5432")
    run("systemctl", "daemon-reload")
    run("pg_ctlcluster", "18", "main", "start")
else:
    run("pg_ctlcluster", "18", "main", "restart")
Path("/etc/apt/apt.conf.d/53preventapro-postgresql").write_text('Unattended-Upgrade::Origins-Pattern { "site=apt.postgresql.org"; };\n')
run("pg_lsclusters")
print("POSTGRES18_READY=" + sql("18", "SHOW server_version"))
