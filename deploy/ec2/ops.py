#!/usr/bin/env python3
"""Host checks and logical backups. Never include customer records or secrets in alerts."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

CONFIG = Path("/etc/preventapro/ops.json")
STATE = Path("/var/lib/preventapro-ops")
os.umask(0o077)

def config():
    return json.loads(CONFIG.read_text())

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)

def notify(cfg, subject, message):
    print(subject + ": " + message, flush=True)
    if cfg.get("sns_topic_arn"):
        import boto3
        boto3.client("sns", region_name=cfg["region"]).publish(
            TopicArn=cfg["sns_topic_arn"], Subject=subject[:100], Message=message
        )

def call(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def backup(args):
    cfg = config()
    database = args.database or cfg["database"]
    if not re.fullmatch(r"[A-Za-z0-9_]+", database):
        raise ValueError("Invalid database name")
    with open("/run/lock/preventapro-backup.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        destination = Path("/var/backups/preventapro")
        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = destination / f"{database}-{stamp}.dump"
        fd, temporary = tempfile.mkstemp(prefix=".dump-", dir=destination)
        try:
            with os.fdopen(fd, "wb") as out:
                call("runuser", "-u", "postgres", "--", "pg_dump", "--format=custom", "--no-owner", "--no-acl", "--dbname", database, stdout=out, timeout=300)
                out.flush()
                os.fsync(out.fileno())
            call("pg_restore", "--list", temporary, stdout=subprocess.DEVNULL, timeout=60)
            Path(temporary).replace(target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        with target.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        record = {"database": database, "created_at": datetime.now(timezone.utc).isoformat(), "sha256": digest, "bytes": target.stat().st_size, "uploaded": False}
        if not args.local_only:
            if not cfg.get("s3_bucket"):
                raise RuntimeError("Configure the private S3 bucket before enabling backups")
            import boto3
            s3 = boto3.client("s3", region_name=cfg["region"])
            key = cfg["s3_prefix"].rstrip("/") + "/" + target.name
            with target.open("rb") as body:
                s3.put_object(Bucket=cfg["s3_bucket"], Key=key, Body=body, ServerSideEncryption="AES256", Metadata={"sha256": digest})
            remote = s3.head_object(Bucket=cfg["s3_bucket"], Key=key)
            if remote["ContentLength"] != record["bytes"] or remote.get("Metadata", {}).get("sha256") != digest:
                raise RuntimeError("Remote backup metadata mismatch")
            record.update(uploaded=True, bucket=cfg["s3_bucket"], key=key)
            s3.put_object(Bucket=cfg["s3_bucket"], Key=key + ".json", Body=json.dumps(record).encode(), ServerSideEncryption="AES256", ContentType="application/json")
            if database == cfg["database"]:
                save(STATE / "last-backup.json", record)
        save(target.with_suffix(".json"), record)
        # Only rotate copies known to have reached S3 successfully.
        for manifest in destination.glob(database + "-*.json"):
            old = json.loads(manifest.read_text())
            if old.get("uploaded") and datetime.fromisoformat(old["created_at"]).timestamp() < time.time() - 7 * 86400:
                manifest.with_suffix(".dump").unlink(missing_ok=True)
                manifest.unlink()
        print(json.dumps(record))
        print("BACKUP_FILE=" + str(target))

def health():
    cfg = config()
    issues = []
    disk = shutil.disk_usage("/")
    disk_percent = round(100 * disk.used / disk.total, 1)
    if disk_percent >= 80:
        issues.append(f"Disk usage: {disk_percent}%")
    memory = {key: int(value.split()[0]) for key, value in (line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())}
    available_mib = round(memory["MemAvailable"] / 1024)
    if available_mib < 150:
        issues.append(f"Available RAM: {available_mib} MiB")
    for service in ("nginx",):
        if subprocess.run(["systemctl", "is-active", "--quiet", service]).returncode:
            issues.append(service + " is inactive")
    if subprocess.run(["pg_isready", "--quiet", "--host", "127.0.0.1", "--port", "5432"]).returncode:
        issues.append("PostgreSQL is unavailable")
    if Path("/etc/preventapro/backend.env").exists() and Path("/opt/preventapro/backend/dist/index.js").exists():
        try:
            with urllib.request.urlopen("http://127.0.0.1:4000/api/health", timeout=8) as response:
                if response.status != 200:
                    issues.append("Backend health endpoint failed")
        except Exception:
            issues.append("Backend health endpoint is unreachable")
    cert = cfg.get("certificate_path", "")
    if Path(cert).is_file() and subprocess.run(["openssl", "x509", "-checkend", "172800", "-noout", "-in", cert], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        issues.append("HTTPS certificate expires in under 48 hours")
    if Path("/etc/preventapro/backup.enabled").exists():
        last = STATE / "last-backup.json"
        if not last.exists() or datetime.fromisoformat(json.loads(last.read_text())["created_at"]).timestamp() < time.time() - 30 * 3600:
            issues.append("No successful S3 database backup in the last 30 hours")
    path = STATE / "health.json"
    previous = json.loads(path.read_text()) if path.exists() else {}
    state = {"issues": issues, "checked_at": time.time(), "disk_percent": disk_percent, "available_mib": available_mib, "consecutive": previous.get("consecutive", 0) + 1 if issues else 0, "last_notified": previous.get("last_notified", 0), "notified_problem": previous.get("notified_problem", False)}
    if issues and state["consecutive"] >= 2 and time.time() - state["last_notified"] >= 21600:
        notify(cfg, "PreventaPro: revisar servidor", "\n".join(issues))
        if cfg.get("sns_topic_arn"):
            state.update(last_notified=time.time(), notified_problem=True)
    elif not issues and previous.get("notified_problem"):
        notify(cfg, "PreventaPro: servidor recuperado", "All configured checks are healthy again.")
        state["notified_problem"] = False
    save(path, state)
    print(json.dumps(state))

def maintenance():
    lock = Path("/opt/preventapro/backend/package-lock.json")
    if not lock.exists():
        print("Application dependencies will be checked after deployment")
        return
    result = subprocess.run(["runuser", "-u", "preventapro", "--", "env", "NPM_CONFIG_CACHE=/var/cache/preventapro", "npm", "audit", "--omit=dev", "--json"], cwd=lock.parent, capture_output=True, text=True, timeout=180)
    report = json.loads(result.stdout)
    counts = report.get("metadata", {}).get("vulnerabilities")
    if counts is None:
        raise RuntimeError("Dependency audit did not return vulnerability counts")
    save(STATE / "dependency-audit.json", {"checked_at": time.time(), "counts": counts})
    if counts.get("high", 0) or counts.get("critical", 0):
        notify(config(), "PreventaPro: actualizar dependencias", json.dumps(counts))
    print(json.dumps(counts))

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=("backup", "health", "maintenance", "notify-test"))
parser.add_argument("--database")
parser.add_argument("--local-only", action="store_true")
args = parser.parse_args()
try:
    if args.action == "backup": backup(args)
    elif args.action == "health": health()
    elif args.action == "maintenance": maintenance()
    else: notify(config(), "PreventaPro: prueba de alertas", "Notifications from the EC2 instance are configured. No customer information is included.")
except Exception as error:
    message = f"{args.action} failed: {type(error).__name__}: {error}"
    print(message, file=sys.stderr)
    try: notify(config(), "PreventaPro: fallo de mantenimiento", message)
    except Exception as notification_error: print(type(notification_error).__name__, file=sys.stderr)
    sys.exit(1)
