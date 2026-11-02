#!/usr/bin/env python3
from pathlib import Path
import subprocess

IP = "18.227.163.204"
certificate = Path(f"/etc/letsencrypt/live/{IP}/fullchain.pem")
if not certificate.exists():
    raise SystemExit("Issue the public certificate before enabling HTTPS")
Path("/etc/nginx/sites-available/preventapro").write_text(f"""server {{
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name {IP};
    access_log /var/log/nginx/preventapro-access.log preventapro_safe;
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/letsencrypt; default_type text/plain; }}
    location / {{ return 308 https://{IP}$request_uri; }}
}}
server {{
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name {IP};
    ssl_certificate /etc/letsencrypt/live/{IP}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{IP}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:PreventaProTLS:10m;
    client_max_body_size 10m;
    access_log /var/log/nginx/preventapro-access.log preventapro_safe;
    error_log /var/log/nginx/preventapro-error.log;
    location = /healthz {{ default_type application/json; return 200 '{{"status":"host-ready"}}'; }}
    location /api/ {{
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 5s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }}
    location / {{ return 404; }}
}}
""")
hook = Path("/etc/letsencrypt/renewal-hooks/deploy/preventapro-nginx")
hook.parent.mkdir(parents=True, exist_ok=True)
hook.write_text("#!/bin/sh\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n")
hook.chmod(0o755)
subprocess.run(["nginx", "-t"], check=True)
subprocess.run(["systemctl", "reload", "nginx"], check=True)
print("HTTPS_ENABLED=" + IP)
