#!/usr/bin/env bash
# ===========================================================================
#  KAMi-VPS-1 — READ-ONLY disk audit (run ON THE SERVER, after SSH access)
#
#  Purpose: decide whether the 200 GB boot volume can safely be replaced with a
#  smaller one. OCI boot volumes can be grown but NOT shrunk in place, so the
#  only way down is a rebuild + migration — and you need real numbers first.
#
#  Safety: reads only. No installs, no deletes, no docker prune, no restarts,
#          no .env or secret contents, no log contents.
#
#  USAGE:  sudo bash kami-disk-audit.sh
# ===========================================================================
set -uo pipefail
umask 077

OUT="$HOME/kami-disk-audit-$(date +%Y%m%d-%H%M%S).txt"

{
echo "=== KAMi-VPS-1 DISK AUDIT (read-only) ==="
echo "Generated: $(date -Is)"
echo "Host: $(uname -n)   User: $(id -un)"
echo

echo "=== 1. FILESYSTEM USE ==="
df -hT -x tmpfs -x devtmpfs 2>/dev/null
echo
echo "--- inodes ---"
df -ih -x tmpfs -x devtmpfs 2>/dev/null
echo

echo "=== 2. TOP-LEVEL DIRECTORY SIZES (/) ==="
du -xh --max-depth=1 / 2>/dev/null | sort -hr | head -n 25
echo

echo "=== 3. DOCKER FOOTPRINT ==="
if command -v docker >/dev/null 2>&1; then
  docker system df 2>/dev/null || echo "(docker not accessible for this user — try sudo)"
  echo
  echo "--- images (size, name) ---"
  docker images --format '{{.Size}}\t{{.Repository}}:{{.Tag}}' 2>/dev/null | sort -hr | head -n 25
  echo
  echo "--- volumes (size, name, mount) ---"
  for v in $(docker volume ls --format '{{.Name}}' 2>/dev/null); do
    mnt="$(docker volume inspect "$v" --format '{{.Mountpoint}}' 2>/dev/null || true)"
    if [ -n "$mnt" ] && [ -d "$mnt" ]; then
      printf '%s\t%s\n' "$(du -sh "$mnt" 2>/dev/null | cut -f1)" "$v"
    else
      printf '?\t%s\n' "$v"
    fi
  done | sort -hr | head -n 30
  echo
  echo "--- container count / states ---"
  docker ps -a --format '{{.State}}' 2>/dev/null | sort | uniq -c
else
  echo "Docker not installed or not on PATH."
fi
echo

echo "=== 4. LARGEST SINGLE FILES (names + sizes, no contents) ==="
find / -xdev -type f -size +200M -printf '%s\t%p\n' 2>/dev/null \
  | sort -rn | head -n 30 \
  | awk '{printf "%.1f GB\t%s\n", $1/1073741824, $2}'
echo

echo "=== 5. RECLAIMABLE-WITHOUT-DATA-LOSS CANDIDATES (sizes only; nothing deleted) ==="
for p in /var/lib/docker/tmp /var/cache/apt /var/log/journal /var/tmp /tmp /root/.cache /home/ubuntu/.cache; do
  [ -e "$p" ] && printf '%s\t%s\n' "$(du -sh "$p" 2>/dev/null | cut -f1)" "$p"
done
echo
echo "journald disk use (if any):"
journalctl --disk-usage 2>/dev/null || echo "(journalctl unavailable)"
echo

echo "=== 6. KAMi / PLATFORM TREES (names + sizes only) ==="
for d in /opt/kami-vps-1 /opt/aire-os /opt/coolify /srv /data /mnt; do
  if [ -d "$d" ]; then
    echo "--- $d : $(du -sh "$d" 2>/dev/null | cut -f1) ---"
    find "$d" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort | head -n 40
  fi
done
echo

echo "=== 7. SNAPSHOTS / BACKUPS ON DISK (names + sizes) ==="
find /opt /srv /home /var/backups -maxdepth 4 -type d \
  \( -iname '*backup*' -o -iname '*snapshot*' -o -iname '*archive*' \) \
  -printf '%p\n' 2>/dev/null | head -n 30
echo

echo "=== 8. DECISION INPUT ==="
ROOT_USED="$(df -P / 2>/dev/null | awk 'NR==2 {print $3}')"
if [ -n "${ROOT_USED:-}" ]; then
  echo "Root filesystem used: $(( ROOT_USED / 1024 / 1024 )) GB (of 200 GB provisioned)"
  echo
  echo "Rule of thumb for choosing a target size:"
  echo "  < 30 GB used  → a 50-75 GB volume is comfortable"
  echo "  30-60 GB used → 100 GB volume (back inside the free allowance with headroom)"
  echo "  > 70 GB used  → do not shrink; consider a separate 100 GB data volume instead"
  echo "                  (free allowance is 200 GB TOTAL across boot + data volumes)"
fi
echo
echo "END — nothing was modified, deleted, pruned or restarted."
} > "$OUT" 2>&1

echo
echo "READ-ONLY DISK AUDIT COMPLETE"
echo "Report: $OUT"
echo "View it with: less \"$OUT\""
echo
echo "Share the report, or just sections 1-4. It contains file paths and container"
echo "names but no file contents, secrets or .env values."
