#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# KAMi-VPS-1 :: restore SSH access by appending your public key to the
#               ubuntu user on the instance's boot volume.
#
# WHERE TO RUN: on the HELPER instance (kami-helper), after attaching the
#               KAMi-VPS-1 boot volume to it as a Read/Write data volume.
#               NOT in Cloud Shell (no sudo, no disks) and NOT on KAMi itself.
#
# WHAT IT DOES: probes attached partitions read-only to find the KAMi root
#               filesystem, mounts it, backs up authorized_keys, appends the
#               key if missing, fixes ownership/permissions, verifies.
#               It never writes outside /mnt/kami_root.
#
# USAGE:        sudo bash add_kami_key.sh
#               then:  sudo umount /mnt/kami_root
# ---------------------------------------------------------------------------
set -euo pipefail
TARGET_USER=ubuntu
MOUNT=/mnt/kami_root
# The public key is NEVER embedded in this script. Supply it one of these ways:
#   1. export PUBKEY='ssh-rsa AAAA... comment'
#   2. export PUBKEY_FILE=/path/to/kami_vps.pub
#   3. copy the .pub onto this helper:  scp -i ~/.ssh/kami_vps ~/.ssh/kami_vps.pub ubuntu@<helper>:/tmp/
#      (searched automatically below)
if [ -z "${PUBKEY:-}" ]; then
  if [ -n "${PUBKEY_FILE:-}" ] && [ -f "$PUBKEY_FILE" ]; then
    PUBKEY="$(cat "$PUBKEY_FILE")"
  else
    for cand in "$HOME/.ssh/kami_vps.pub" /home/ubuntu/.ssh/kami_vps.pub /tmp/kami_vps.pub /tmp/*.pub; do
      [ -f "$cand" ] && { PUBKEY="$(cat "$cand")"; PUBKEY_FILE="$cand"; break; }
    done
  fi
fi
if [ -z "${PUBKEY:-}" ]; then
  cat <<'EOM'
No public key found. Do one of these, then re-run:
  export PUBKEY='ssh-rsa AAAA... comment'
  export PUBKEY_FILE=/path/to/kami_vps.pub
  scp -i ~/.ssh/kami_vps ~/.ssh/kami_vps.pub ubuntu@<helper-ip>:/tmp/kami_vps.pub
EOM
  exit 1
fi
[ "$(printf '%s' "$PUBKEY" | awk '{print $1}')" = "ssh-rsa" ] || [ "$(printf '%s' "$PUBKEY" | awk '{print $1}')" = "ssh-ed25519" ] \
  || { echo "That does not look like an OpenSSH public key (must start ssh-rsa or ssh-ed25519)."; exit 1; }
echo "Using public key: ${PUBKEY_FILE:-from \$PUBKEY} -> $(printf '%s' "$PUBKEY" | ssh-keygen -l -f /dev/stdin 2>/dev/null || echo 'fingerprint unavailable')"


[ "$(id -u)" = 0 ] || { echo "Re-run with: sudo bash $0"; exit 1; }

echo "=== 1. Block devices ==="
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINTS

mkdir -p "$MOUNT"
echo
echo "=== 2. Probing partitions for the KAMi root filesystem ==="
ROOT_DEV=""
while read -r dev fstype mountpoint; do
  [ -n "$fstype" ] || continue
  case "$fstype" in vfat|swap|LVM2_member|iso9660) continue ;; esac
  [ -z "$mountpoint" ] || continue
  mount -o ro "$dev" "$MOUNT" 2>/dev/null || continue
  if [ -d "$MOUNT/home/$TARGET_USER" ] && [ -f "$MOUNT/etc/os-release" ]; then
    ROOT_DEV="$dev"; umount "$MOUNT"; echo "FOUND root filesystem: $dev ($fstype)"; break
  fi
  umount "$MOUNT" 2>/dev/null || true
done < <(lsblk -lnpo NAME,FSTYPE,MOUNTPOINTS)

if [ -z "$ROOT_DEV" ]; then
  echo "No root filesystem found automatically."
  echo "If the volume uses LVM: sudo vgchange -ay && sudo lvs, then re-run with the LV path."
  echo "Otherwise run: lsblk -f  and mount the largest ext4 partition manually."
  exit 1
fi

mount "$ROOT_DEV" "$MOUNT"
echo "Mounted $ROOT_DEV at $MOUNT"
grep -E '^PRETTY_NAME' "$MOUNT/etc/os-release" || true

UID_=$(awk -F: -v u="$TARGET_USER" '$1==u{print $3}' "$MOUNT/etc/passwd")
GID_=$(awk -F: -v u="$TARGET_USER" '$1==u{print $4}' "$MOUNT/etc/passwd")
[ -n "${UID_:-}" ] || { echo "user $TARGET_USER not found on the volume"; exit 1; }

SSHDIR="$MOUNT/home/$TARGET_USER/.ssh"
AK="$SSHDIR/authorized_keys"
mkdir -p "$SSHDIR"
[ -f "$AK" ] || : > "$AK"
cp -a "$AK" "$AK.bak.$(date +%Y%m%d%H%M%S)"

KEY_BLOB=$(printf '%s' "$PUBKEY" | awk '{print $1" "$2}')
if grep -qF "$KEY_BLOB" "$AK"; then
  echo "Key already present — nothing appended."
else
  printf '\n%s\n' "$PUBKEY" >> "$AK"
  echo "Key appended."
fi

chown -R "$UID_:$GID_" "$SSHDIR"
chmod 700 "$SSHDIR"
chmod 600 "$AK"

echo
echo "=== 3. Verification ==="
ls -l "$SSHDIR"
printf '%s\n' "$PUBKEY" > /tmp/kami_added.pub
echo "Fingerprint of the key we just wrote — must be EXACTLY:"
echo "    4096 SHA256:MMFsTUBgix+BoPICvpiySeA++HKCkm/DZhaKuNKgW0o kami-vps-key (RSA)"
ssh-keygen -l -f /tmp/kami_added.pub
rm -f /tmp/kami_added.pub
echo
echo "All keys now authorised on the volume (yours must appear in this list):"
ssh-keygen -l -f "$AK"
echo
echo "DONE. Now run:  sudo umount $MOUNT"
