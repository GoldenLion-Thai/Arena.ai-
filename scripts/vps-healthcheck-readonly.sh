#!/usr/bin/env bash
# Multi-VPS Read-Only Health & Inventory Audit
#
# Works on OCI (Ampere A1 / E2), Hostinger KVM, Hetzner, DigitalOcean,
# bare metal, or anything else running Linux with systemd or plain SysV.
#
# SAFETY: read-only. No installs, updates, restarts, uploads, deletes,
#         firewall changes, Docker changes, .env reads, or secret output.
#
# Usage:
#   ./vps-healthcheck-readonly.sh
#   AUDIT_LABEL="asci-vps-1" ./vps-healthcheck-readonly.sh
#   AUDIT_PROVIDER="Hostinger KVM 4" AUDIT_DIRS="/opt /srv" ./vps-healthcheck-readonly.sh
#
# Optional environment:
#   AUDIT_LABEL     name to print in the report header      (default: hostname)
#   AUDIT_PROVIDER  provider/plan, recorded in the header   (default: auto-detect)
#   AUDIT_DIRS      spaces of dirs to inventory             (default: /opt /srv /root /home)
#   AUDIT_URLS      local health endpoints to probe         (default: common panel ports)

set -u
set -o pipefail
umask 077

LABEL="${AUDIT_LABEL:-$(hostname 2>/dev/null || echo unknown)}"
DIRS="${AUDIT_DIRS:-/opt /srv /root /home}"
TS="$(date '+%Y-%m-%d_%H%M%S')"
SAFE_LABEL="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '_')"
REPORT="${HOME}/vps-audit-${SAFE_LABEL}-${TS}.txt"

have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""
if [ "$(id -u)" -eq 0 ]; then SUDO=""; elif have sudo && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi

# ---------------------------------------------------------------- provider
detect_provider() {
  [ -n "${AUDIT_PROVIDER:-}" ] && { printf '%s' "$AUDIT_PROVIDER"; return; }
  local tag="" prod="" virt=""
  [ -r /sys/class/dmi/id/chassis_asset_tag ] && tag="$(cat /sys/class/dmi/id/chassis_asset_tag 2>/dev/null)"
  [ -r /sys/class/dmi/id/product_name ] && prod="$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
  have systemd-detect-virt && virt="$(systemd-detect-virt 2>/dev/null)"
  case "$tag$prod" in
    *ocid1.instance*)        printf 'Oracle Cloud Infrastructure (instance id in DMI)' ;;
    *) case "$virt" in
         kvm)   printf 'KVM virtual machine (provider not identifiable from inside the guest)' ;;
         oracle|xen) printf '%s virtualisation' "$virt" ;;
         lxc|openvz|container-other) printf 'container (%s) - not a full VM' "$virt" ;;
         none)  printf 'bare metal / no virtualisation detected' ;;
         *)     printf '%s (unknown provider)' "${virt:-unknown}" ;;
       esac ;;
  esac
}

# ------------------------------------------------------------- packaging
pkg_pending() {
  local all sec
  if have apt-get; then
    # -s = simulate only. Refreshes nothing, installs nothing.
    all="$($SUDO apt-get -s dist-upgrade 2>/dev/null | grep -c '^Inst' || true)"
    sec="$($SUDO apt-get -s dist-upgrade 2>/dev/null | grep -ci '^Inst.*security' || true)"
    echo "  Pending upgrades (simulated, nothing installed): ${all:-0}"
    echo "  Of which classified as security:                 ${sec:-0}"
    [ "${all:-0}" = "0" ] && echo "  (package lists may be stale if 'apt update' has not run recently)"
  elif have dnf; then
    all="$(dnf check-update --quiet 2>/dev/null | grep -c '^[a-zA-Z0-9]' || true)"
    echo "  Pending upgrades: ${all:-0}"
  elif have yum; then
    all="$(yum check-update --quiet 2>/dev/null | grep -c '^[a-zA-Z0-9]' || true)"
    echo "  Pending upgrades: ${all:-0}"
  elif have apk; then
    all="$(apk version 2>/dev/null | grep -c '<' || true)"
    echo "  Packages with a newer version available: ${all:-0}"
  else
    echo "  No supported package manager found."
  fi
}

run() {
  local title="$1"; shift
  {
    echo
    echo "=============================================================================="
    echo "## ${title}"
    echo "------------------------------------------------------------------------------"
    "$@"
  } >> "$REPORT" 2>&1 || echo "[section failed or command unavailable]" >> "$REPORT"
}

{
  echo "VPS READ-ONLY HEALTH & INVENTORY AUDIT"
  echo "Label:     ${LABEL}"
  echo "Provider:  $(detect_provider)"
  echo "Generated: $(date -Is)"
  echo "Hostname:  $(hostname 2>/dev/null || echo unknown)"
  echo "Run by:    $(id -un 2>/dev/null || echo unknown) (uid $(id -u 2>/dev/null || echo '?'))"
  echo
  echo "SAFETY DECLARATION - THIS SCRIPT CHANGED NOTHING"
  echo "- No services restarted.      - No packages installed or upgraded."
  echo "- No files created outside the report, moved, or deleted."
  echo "- No .env files, credentials, tokens, passwords, or private keys read."
  echo "- No firewall, DNS, Docker, database, or network settings changed."
  echo
  echo "REPORTING LIMITS"
  echo "- Container names/statuses included; environment variables excluded."
  echo "- Listening ports included; traffic contents excluded."
  echo "- Directory names and disk usage included; file contents excluded."
  echo "- Log summaries are counts and titles only, never message bodies."
} > "$REPORT"

run "1. System identity" bash -c '
echo "Date:      $(date -Is)"
echo "Hostname:  $(hostnamectl --static 2>/dev/null || hostname)"
echo "Kernel:    $(uname -srmo)"
echo "OS:"
grep -E "^(PRETTY_NAME|NAME|VERSION)=" /etc/os-release 2>/dev/null || cat /etc/os-release 2>/dev/null || true
echo "Init:      $(ps -p 1 -o comm= 2>/dev/null || echo unknown)"
echo "Timezone:  $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"
echo "Uptime:    $(uptime)"
echo "Current user:"; id
'

run "2. CPU, memory, load and swap" bash -c '
echo "CPU:"
lscpu 2>/dev/null | grep -E "Architecture|Model name|CPU\(s\)|Thread|Core|Socket|Vendor" \
  || grep -E "^(processor|model name|cpu cores)" /proc/cpuinfo 2>/dev/null | head -n 8
echo
echo "Memory:"; free -h
echo "Swap:"; swapon --show 2>/dev/null || echo "No swap configured."
echo
echo "Load average:"; cat /proc/loadavg 2>/dev/null || true
echo
echo "Top 10 processes by RSS:"
ps -eo pid,user,comm,%cpu,%mem,rss --sort=-rss 2>/dev/null | head -n 11
'

run "3. Disk, mounts, inodes and largest consumers" bash -c '
echo "Disk usage:"; df -hT -x tmpfs -x devtmpfs
echo
echo "Inode usage:"; df -ih -x tmpfs -x devtmpfs
echo
echo "Block devices:"; lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS 2>/dev/null || true
echo
echo "Largest immediate subdirectories (top 25, metadata only):"
for d in / /var /opt /srv /home /root; do
  [ -d "$d" ] || continue
  echo "-- $d"
  du -h --max-depth=1 -x "$d" 2>/dev/null | sort -hr | head -n 25
done
'

{
  echo
  echo "=============================================================================="
  echo "## 4. Package manager state and pending updates (counts only, nothing installed)"
  echo "------------------------------------------------------------------------------"
  echo "Package manager: $(if command -v apt-get >/dev/null; then echo apt; elif command -v dnf >/dev/null; then echo dnf; elif command -v yum >/dev/null; then echo yum; elif command -v apk >/dev/null; then echo apk; else echo none; fi)"
  pkg_pending
} >> "$REPORT" 2>&1

run "5. Core service availability" bash -c '
for svc in ssh sshd docker fail2ban ufw firewalld nftables tailscaled nginx caddy postgresql redis-server cron crond; do
  printf "%-14s " "$svc"
  if systemctl is-active --quiet "$svc" 2>/dev/null; then echo "active"
  elif systemctl list-unit-files 2>/dev/null | grep -q "^${svc}"; then echo "installed but not active"
  else echo "not-found"; fi
done
'

run "6. Firewall state (rules read only)" bash -c '
echo "NOTE: with a VPS provider there are usually TWO firewall layers - the one inside"
echo "this machine (below) and a provider-level firewall in the hosting panel. The audit"
echo "cannot see the provider-level one. Check it in the hosting control panel."
echo
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q .; then
  echo "### UFW"; $SUDO ufw status verbose 2>/dev/null || ufw status 2>/dev/null
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  echo "### firewalld"; $SUDO firewall-cmd --list-all 2>/dev/null
elif command -v nft >/dev/null 2>&1 && $SUDO nft list ruleset >/dev/null 2>&1; then
  echo "### nftables"; $SUDO nft list ruleset 2>/dev/null | head -n 60
elif command -v iptables >/dev/null 2>&1; then
  echo "### iptables"; $SUDO iptables -L -n -v 2>/dev/null | head -n 60 || echo "iptables present but not readable."
else
  echo "No host firewall tooling found."
fi
'

run "7. Docker engine" bash -c '
if command -v docker >/dev/null 2>&1; then
  docker --version 2>/dev/null || true
  docker compose version 2>/dev/null || docker-compose --version 2>/dev/null || true
  echo
  echo "Docker resource use:"; docker system df 2>/dev/null || echo "(needs permission)"
  echo
  echo "Running containers:"; docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "(needs permission)"
  echo
  echo "All containers incl. stopped:"; docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}" 2>/dev/null || true
  echo
  echo "Unhealthy / restarting / exited:"; docker ps -a --format "{{.Names}}\t{{.Status}}" 2>/dev/null | grep -Ei "restarting|exited|unhealthy" || echo "None."
  echo
  echo "Networks:"; docker network ls 2>/dev/null || true
  echo "Volumes:"; docker volume ls 2>/dev/null || true
else
  echo "Docker not installed."
fi
'

run "8. Listening TCP/UDP ports (process detail redacted)" bash -c '
if command -v ss >/dev/null 2>&1; then
  ss -tulpn 2>/dev/null | sed -E "s/users:\(\([^)]*\)\)/[process redacted]/g" || echo "(needs permission)"
else
  echo "ss unavailable."
fi
'

run "9. Platform indicators (Coolify / Traefik / Portainer / panels)" bash -c '
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null \
    | grep -Ei "coolify|traefik|portainer|realtime|sentinel|vaultwarden|postgres|redis|mysql|mariadb|nginx|caddy" \
    || echo "No matching container names found."
fi
echo
echo "Systemd units matching platform names:"
systemctl list-units --type=service --all --no-pager 2>/dev/null \
  | grep -Ei "coolify|traefik|portainer|docker|vaultwarden" || true
'

run "10. Directory inventory (names and sizes only, never contents)" bash -c '
for d in '"$DIRS"'; do
  [ -d "$d" ] || { echo "Directory: $d (absent)"; echo; continue; }
  echo "Directory: $d"
  du -sh "$d" 2>/dev/null || true
  echo "Top-level entries:"
  find "$d" -mindepth 1 -maxdepth 1 -printf "%f\n" 2>/dev/null | sort | head -n 60
  echo
  echo "Compose / project files found (names, dates, sizes only):"
  find "$d" -maxdepth 4 -type f \
    \( -name "docker-compose*.yml" -o -name "compose*.yml" -o -name "compose*.yaml" \
       -o -name ".env.example" -o -name "README*.md" -o -name "package.json" \) \
    -printf "%p\t%TY-%Tm-%Td %TH:%TM\t%k KB\n" 2>/dev/null | sort | head -n 60
  echo
done
'

run "11. Backup indicators" bash -c '
echo "Host-level backup tooling:"
systemctl list-timers --all --no-pager 2>/dev/null | grep -Ei "backup|restic|borg|rclone|pg_dump|snapshot" || echo "No backup-related timers."
echo
echo "Cron entries mentioning backup (command bodies redacted):"
crontab -l 2>/dev/null | grep -Ei "backup|restic|borg|rclone|pg_dump" | sed -E "s/.*/[backup-related cron entry present]/" || echo "None in user crontab."
$SUDO grep -rEl "restic|borg|pg_dump|rclone" /etc/cron.d /etc/cron.daily /etc/cron.weekly 2>/dev/null | head || true
echo
echo "Backup directories present:"
for d in '"$DIRS"'; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 4 -type d \( -iname "*backup*" -o -iname "*archive*" -o -iname "*snapshot*" \) -printf "%p\n" 2>/dev/null | head -n 40
done
echo
echo "NOTE: provider-level snapshots (Hostinger hPanel, OCI volume backups) are NOT visible"
echo "from inside the machine. Verify them in the hosting control panel."
'

run "12. SSH hardening posture (configuration values only)" bash -c '
echo "sshd effective configuration (key settings):"
if command -v sshd >/dev/null 2>&1; then
  $SUDO sshd -T 2>/dev/null | grep -Ei "^(passwordauthentication|permitrootlogin|pubkeyauthentication|challengeresponseauthentication|usepam|port|permitemptypasswords|maxauthtries)" \
    || echo "(needs root; re-run with sudo to read sshd -T)"
else
  echo "sshd binary not found."
fi
echo
echo "Static config grep (fallback if sshd -T was unavailable):"
static="$($SUDO grep -rEi "^\s*(PasswordAuthentication|PermitRootLogin|PubkeyAuthentication|Port)" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null || true)"
[ -n "$static" ] && printf '%s\n' "$static" || echo "  (no explicit settings found in static config - defaults apply)"
echo
echo "Authorised key COUNT per user (never the keys themselves):"
found=0
for h in /root /home/*; do
  f="${h}/.ssh/authorized_keys"
  if [ -f "$f" ]; then
    printf "  %-28s %s key(s)\n" "$h" "$(grep -c '^ssh-' "$f" 2>/dev/null || echo 0)"
    found=1
  fi
done
[ "$found" = "0" ] && echo "  (none readable for the current user)"
echo
echo "Recent failed SSH logins (count only):"
$SUDO lastb 2>/dev/null | head -n 1 || true
$SUDO journalctl -u ssh -u sshd --since "7 days ago" --no-pager 2>/dev/null | grep -ci "failed password" || echo "no journal access"
'

run "13. Error and instability signals" bash -c '
echo "Failed systemd units:"; systemctl --failed --no-pager 2>/dev/null || true
echo
echo "OOM kills in the current boot:"; $SUDO journalctl -k --no-pager 2>/dev/null | grep -ci "out of memory" || echo "no journal access"
echo
echo "Disk filesystems above 85%:"; df -hP -x tmpfs -x devtmpfs | awk "\$5+0 >= 85 {print}"
echo
echo "Zombie processes:"; ps -eo stat= 2>/dev/null | grep -c Z || echo 0
'

run "14. Local HTTP health checks (loopback only, no external traffic)" bash -c '
urls="${AUDIT_URLS:-http://127.0.0.1:8000/api/v1/version http://127.0.0.1:3000/health http://127.0.0.1:3001/health http://127.0.0.1:8080/health http://127.0.0.1/health}"
for url in $urls; do
  printf "%-45s " "$url"
  if command -v curl >/dev/null 2>&1; then
    curl --max-time 5 --silent --show-error --output /dev/null --write-out "HTTP %{http_code}\n" "$url" 2>/dev/null || echo "no response"
  else
    echo "curl unavailable"
  fi
done
'

{
  echo
  echo "=============================================================================="
  echo "## 15. Provider-specific checklist (verify in the control panel)"
  echo "------------------------------------------------------------------------------"
  echo "This audit runs INSIDE the machine, so the following can only be checked at the"
  echo "provider: tick them off manually for each server."
  echo
  echo "Oracle Cloud Infrastructure (kami-VPS-1):"
  echo "  [ ] Instance is STOPPED never TERMINATED - termination releases Always Free capacity"
  echo "  [ ] Boot volume is the intended 200 GB and is the only volume in the tenancy"
  echo "  [ ] No orphaned boot volumes left by terminated helper instances"
  echo "  [ ] Budget is alert-only, with no automatic stop/terminate action"
  echo
  echo "Hostinger KVM (asci-vps-1):"
  echo "  [ ] hPanel firewall rules reviewed (separate from the in-guest firewall)"
  echo "  [ ] Automated backups/snapshots are ON and a recent restore point exists"
  echo "  [ ] Plan confirmed as KVM 4 (4 vCPU / 16 GB / 200 GB NVMe)"
  echo "  [ ] Renewal price and date noted - intro pricing is not the renewal price"
  echo "  [ ] Browser terminal in hPanel tested - it is the key-independent recovery path"
  echo
  echo "Any provider:"
  echo "  [ ] DNS A records point at the CURRENT public IP (it changed on rebuild)"
  echo "  [ ] An offline copy of the SSH private key exists in a password manager"
  echo "  [ ] Network password SSH is disabled; key-only is enforced"
  echo
  echo "=============================================================================="
  echo "## END OF AUDIT"
  echo "Generated: $(date -Is)"
  echo "Report:    ${REPORT}"
  echo "Next step: review only. Change nothing until the results are assessed."
} >> "$REPORT" 2>&1

echo
echo "READ-ONLY AUDIT COMPLETE"
echo "Label:  ${LABEL}"
echo "Report: ${REPORT}"
echo "View:   less \"$REPORT\""
