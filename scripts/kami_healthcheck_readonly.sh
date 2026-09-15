#!/usr/bin/env bash
# KAMi-VPS-1 Read-Only Health & Inventory Check
#
# Purpose: verify current server state before any deployment or change.
#
# Safety: read-only. No installs, updates, restarts, uploads, deletes,
#         firewall changes, Docker changes, .env reads, or secret output.
#
# Run it ON the server:  chmod 700 kami_healthcheck_readonly.sh && ./kami_healthcheck_readonly.sh

set -u
set -o pipefail
umask 077

TS="$(date '+%Y-%m-%d_%H%M%S')"
REPORT="${HOME}/kami-vps1-healthcheck-${TS}.txt"
HOST="$(hostname 2>/dev/null || echo unknown)"

run() {
  local title="$1"; shift
  {
    echo
    echo "=============================================================================="
    echo "## ${title}"
    echo "------------------------------------------------------------------------------"
    "$@"
  } >> "$REPORT" 2>&1 || echo "[Command unavailable/failed: $*]" >> "$REPORT"
}

{
  echo "KAMi-VPS-1 READ-ONLY HEALTH & INVENTORY REPORT"
  echo "Generated: $(date -Is)"
  echo "Host: ${HOST}"
  echo "Run by: $(id -un 2>/dev/null || echo unknown)"
  echo
  echo "SAFETY DECLARATION"
  echo "- No services were restarted."
  echo "- No packages were installed or upgraded."
  echo "- No files were uploaded, copied, moved, or deleted."
  echo "- No .env files, credentials, tokens, passwords, or private keys were read."
  echo "- No firewall, DNS, Docker, Coolify, database, or network settings were changed."
  echo
  echo "REPORTING LIMITS"
  echo "- Container names/statuses are included; environment variables are excluded."
  echo "- Listening ports are included; traffic contents are excluded."
  echo "- Directory names and disk usage are included; file contents are excluded."
  echo "- Tailscale peer names are redacted to hostnames/status only where possible."
} > "$REPORT"

run "1. System identity" bash -c '
echo "Date: $(date -Is)"
echo "Hostname: $(hostnamectl --static 2>/dev/null || hostname)"
echo "Kernel: $(uname -srmo)"
echo "OS:"
grep -E "^(PRETTY_NAME|NAME|VERSION)=" /etc/os-release 2>/dev/null || true
echo "Uptime:"
uptime
echo "Current user:"
id
'

run "2. CPU, memory and load" bash -c '
echo "CPU:"
lscpu 2>/dev/null | grep -E "Architecture|Model name|CPU\(s\)|Thread|Core|Socket" || true
echo
echo "Memory:"
free -h
echo
echo "Load:"
cat /proc/loadavg 2>/dev/null || true
'

run "3. Disk, mounts and inode capacity" bash -c '
echo "Disk usage:"
df -hT -x tmpfs -x devtmpfs
echo
echo "Inode usage:"
df -ih -x tmpfs -x devtmpfs
echo
echo "Block devices:"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS 2>/dev/null || true
'

run "4. Core service availability" bash -c '
for svc in ssh sshd docker fail2ban ufw tailscaled; do
  printf "%-12s " "$svc"
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    echo "active"
  elif systemctl list-unit-files 2>/dev/null | grep -q "^${svc}"; then
    echo "inactive/failed"
  else
    echo "not-found"
  fi
done
'

run "5. Firewall state (rules only)" bash -c '
if command -v ufw >/dev/null 2>&1; then
  ufw status verbose
else
  echo "UFW not installed or unavailable."
fi
echo
echo "Note: no firewall settings were changed."
'

run "6. Docker engine and Compose" bash -c '
docker --version 2>/dev/null || true
docker compose version 2>/dev/null || true
echo
echo "Docker system summary:"
docker system df 2>/dev/null || true
'

run "7. Running containers (no environment/config inspection)" bash -c '
if command -v docker >/dev/null 2>&1; then
  docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
  echo
  echo "All container state summary:"
  docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}"
else
  echo "Docker unavailable."
fi
'

run "8. Docker networks and volumes (names only)" bash -c '
if command -v docker >/dev/null 2>&1; then
  echo "Networks:"
  docker network ls
  echo
  echo "Volumes:"
  docker volume ls
else
  echo "Docker unavailable."
fi
'

run "9. Coolify/Traefik/Portainer indicators" bash -c '
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" \
    | grep -Ei "coolify|traefik|portainer|realtime|sentinel" \
    || echo "No matching container names found."
fi
echo
echo "System services matching platform names:"
systemctl list-units --type=service --all --no-pager 2>/dev/null \
  | grep -Ei "coolify|traefik|portainer|docker" || true
'

run "10. Listening TCP/UDP ports (process names only)" bash -c '
if command -v ss >/dev/null 2>&1; then
  ss -tulpn 2>/dev/null | sed -E "s/users:\(\([^)]*\)\)/[process redacted]/g"
else
  echo "ss unavailable."
fi
'

run "11. Tailscale status (sanitised)" bash -c '
if command -v tailscale >/dev/null 2>&1; then
  echo "Local Tailscale IPv4:"
  tailscale ip -4 2>/dev/null || true
  echo
  echo "Status (hostnames/state only):"
  tailscale status --json 2>/dev/null \
    | grep -E "\"HostName\"|\"OS\"|\"Online\"|\"Active\"|\"TailscaleIPs\"" \
    | sed -E "s/\"TailscaleIPs\": \[[^]]*\]/\"TailscaleIPs\": [REDACTED]/" \
    || tailscale status 2>/dev/null | awk "{print \$2, \$4, \$5}" || true
else
  echo "Tailscale unavailable."
fi
'

run "12. KAMi directory presence and capacity (metadata only)" bash -c '
for d in /opt/kami-vps-1 /opt/aire-os /srv/kami /srv; do
  if [ -d "$d" ]; then
    echo
    echo "Directory: $d"
    du -sh "$d" 2>/dev/null || true
    echo "Top-level entries:"
    find "$d" -mindepth 1 -maxdepth 1 -printf "%f\n" 2>/dev/null | sort | head -n 80
  fi
done
'

run "13. Compose/project file presence (names only; no file contents)" bash -c '
for d in /opt/kami-vps-1 /opt/aire-os /srv; do
  [ -d "$d" ] || continue
  echo "Search root: $d"
  find "$d" -maxdepth 4 -type f \
    \( -name "docker-compose*.yml" -o -name "compose*.yml" -o -name ".env.example" \
       -o -name "README*.md" -o -name "README*.txt" \) \
    -printf "%p\t%TY-%Tm-%Td %TH:%TM\t%k KB\n" 2>/dev/null | sort
  echo
done
'

run "14. Backup indicators (names/status only)" bash -c '
echo "Systemd timers containing backup:"
systemctl list-timers --all --no-pager 2>/dev/null | grep -Ei "backup|restic|borg|rclone|pg_dump" || true
echo
echo "Cron references containing backup names (command content redacted):"
crontab -l 2>/dev/null | grep -Ei "backup|restic|borg|rclone|pg_dump" \
  | sed -E "s/(.*)/[backup-related cron entry present]/" || true
echo
echo "Backup directories present:"
find /opt /srv -maxdepth 4 -type d \
  \( -iname "*backup*" -o -iname "*archive*" -o -iname "*snapshot*" \) \
  -printf "%p\n" 2>/dev/null | head -n 80
'

run "15. Recent platform errors (titles only; no application logs)" bash -c '
echo "Failed systemd units:"
systemctl --failed --no-pager 2>/dev/null || true
echo
echo "Docker containers with restart count > 0:"
docker ps -a --format "{{.Names}}\t{{.Status}}" 2>/dev/null \
  | grep -Ei "Restarting|Exited|unhealthy" || echo "No obvious failed/restarting containers."
'

run "16. Local HTTP health checks only" bash -c '
for url in \
  "http://127.0.0.1:8000/api/v1/version" \
  "http://127.0.0.1:3000/health" \
  "http://127.0.0.1:3001/health" \
  "http://127.0.0.1:8080/health"; do
  echo
  echo "Checking $url"
  if command -v curl >/dev/null 2>&1; then
    curl --max-time 5 --silent --show-error --output /dev/null \
      --write-out "HTTP %{http_code}\n" "$url" 2>&1 || true
  else
    echo "curl unavailable."
  fi
done
'

{
  echo
  echo "=============================================================================="
  echo "## END OF REPORT"
  echo "------------------------------------------------------------------------------"
  echo "Generated: $(date -Is)"
  echo "Report path: ${REPORT}"
  echo "Next step: review only. Do not change services or configuration until results are assessed."
} >> "$REPORT"

echo
echo "READ-ONLY CHECK COMPLETE"
echo "Report saved to: $REPORT"
echo "View it with: less \"$REPORT\""
