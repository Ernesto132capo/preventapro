#!/usr/bin/env python3
"""Prepare the Ubuntu host; the application and its database are deployed separately."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

IP = "18.227.163.204"
ROOT = Path(__file__).resolve().parent

def run(*args):
    subprocess.run(args, check=True)

def write(path, content, mode=0o644):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not target.with_suffix(target.suffix + ".before-preventapro").exists():
        shutil.copy2(target, target.with_suffix(target.suffix + ".before-preventapro"))
    target.write_text(content)
    target.chmod(mode)

if os.geteuid() != 0:
    sys.exit("Run with sudo")

if subprocess.run(["id", "preventapro"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
    run("useradd", "--system", "--user-group", "--home-dir", "/var/lib/preventapro", "--shell", "/usr/sbin/nologin", "preventapro")
for folder in ("/opt/preventapro/backend/reports", "/var/lib/preventapro", "/var/cache/preventapro"):
    run("install", "-d", "-o", "preventapro", "-g", "preventapro", "-m", "0750", folder)
for folder in ("/etc/preventapro", "/var/backups/preventapro", "/var/lib/preventapro-ops"):
    run("install", "-d", "-m", "0700", folder)
run("install", "-d", "-m", "0755", "/var/www/letsencrypt/.well-known/acme-challenge")
run("install", "-d", "-m", "0755", "/usr/local/lib/preventapro-ops")
run("install", "-m", "0755", str(ROOT / "ops.py"), "/usr/local/lib/preventapro-ops/ops.py")

# One GiB of emergency swap, with a persistent entry. Existing swap is preserved.
if not Path("/swapfile").exists():
    run("fallocate", "-l", "1G", "/swapfile")
    Path("/swapfile").chmod(0o600)
    run("mkswap", "/swapfile")
if "/swapfile" not in Path("/proc/swaps").read_text():
    run("swapon", "/swapfile")
fstab = Path("/etc/fstab")
if not any(line.split()[:1] == ["/swapfile"] for line in fstab.read_text().splitlines()):
    with fstab.open("a") as out:
        out.write("\n/swapfile none swap sw 0 0\n")
write("/etc/sysctl.d/60-preventapro-memory.conf", "vm.swappiness=10\n")
run("sysctl", "-w", "vm.swappiness=10")

write("/etc/systemd/journald.conf.d/preventapro.conf", "[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=25M\nRuntimeMaxUse=50M\nMaxRetentionSec=14day\n")
write("/etc/apt/apt.conf.d/52unattended-upgrades-nodesource", 'Unattended-Upgrade::Origins-Pattern { "site=deb.nodesource.com"; };\nUnattended-Upgrade::Automatic-Reboot "false";\n')

write("/etc/systemd/system/preventapro.service", """[Unit]
Description=PreventaPro backend
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service
ConditionPathExists=/opt/preventapro/backend/dist/index.js
ConditionPathExists=/etc/preventapro/backend.env
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=exec
User=preventapro
Group=preventapro
WorkingDirectory=/opt/preventapro/backend
Environment=NODE_ENV=production
Environment=PORT=4000
Environment=NPM_CONFIG_CACHE=/var/cache/preventapro
EnvironmentFile=/etc/preventapro/backend.env
ExecStart=/usr/bin/node /opt/preventapro/backend/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
ReadWritePaths=/opt/preventapro/backend/reports /var/lib/preventapro /var/cache/preventapro
SyslogIdentifier=preventapro

[Install]
WantedBy=multi-user.target
""")

for name, description, command, condition in (
    ("health", "PreventaPro host health", "health", ""),
    ("backup", "PreventaPro PostgreSQL backup", "backup", "ConditionPathExists=/etc/preventapro/backup.enabled\n"),
    ("maintenance", "PreventaPro dependency report", "maintenance", "ConditionPathExists=/opt/preventapro/backend/package-lock.json\n"),
):
    write(f"/etc/systemd/system/preventapro-{name}.service", f"""[Unit]
Description={description}
After=network-online.target postgresql.service
{condition}
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/preventapro-ops/ops.py {command}
UMask=0077
TimeoutStartSec=600
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
SyslogIdentifier=preventapro-{name}
""")
    schedule = {
        "health": "OnBootSec=3min\nOnUnitActiveSec=5min\n",
        "backup": "OnCalendar=*-*-* 06:00:00 UTC\nPersistent=true\nRandomizedDelaySec=5min\n",
        "maintenance": "OnCalendar=Sun *-*-* 07:00:00 UTC\nPersistent=true\nRandomizedDelaySec=10min\n",
    }[name]
    write(f"/etc/systemd/system/preventapro-{name}.timer", f"[Unit]\nDescription={description} schedule\n\n[Timer]\n{schedule}Unit=preventapro-{name}.service\n\n[Install]\nWantedBy=timers.target\n")

config = Path("/etc/preventapro/ops.json")
if not config.exists():
    write(config, '{"region":"us-east-2","database":"preventapro","s3_bucket":"","s3_prefix":"postgresql/preventapro","sns_topic_arn":"","certificate_path":"/etc/letsencrypt/live/' + IP + '/fullchain.pem"}\n', 0o600)

write("/etc/nginx/conf.d/preventapro-security.conf", "server_tokens off;\nlog_format preventapro_safe '$remote_addr [$time_local] \"$request_method $uri $server_protocol\" $status $body_bytes_sent $request_time';\n")
if not Path(f"/etc/letsencrypt/live/{IP}/fullchain.pem").exists():
    write("/etc/nginx/sites-available/preventapro", f"""server {{
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name {IP};
    access_log /var/log/nginx/preventapro-access.log preventapro_safe;
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/letsencrypt; default_type text/plain; }}
    location = /healthz {{ default_type application/json; return 200 '{{"status":"host-ready"}}'; }}
    location / {{ default_type text/plain; return 503 'PreventaPro: preparacion en curso.\n'; }}
}}
""")
default = Path("/etc/nginx/sites-enabled/default")
if default.is_symlink():
    default.unlink()
enabled = Path("/etc/nginx/sites-enabled/preventapro")
if not enabled.exists():
    enabled.symlink_to("/etc/nginx/sites-available/preventapro")

run("nginx", "-t")
run("systemctl", "daemon-reload")
run("systemctl", "restart", "systemd-journald")
run("systemctl", "enable", "--now", "nginx", "postgresql", "apt-daily.timer", "apt-daily-upgrade.timer", "preventapro-health.timer", "preventapro-backup.timer", "preventapro-maintenance.timer")
run("systemctl", "enable", "preventapro.service")
run("systemctl", "reload", "nginx")
if Path(f"/etc/letsencrypt/live/{IP}/fullchain.pem").exists():
    run(sys.executable, str(ROOT / "enable-https.py"))
print("HOST_PREPARED: nginx, conditional app service, backup/health timers, swap, logs and NodeSource updates")
