#!/usr/bin/env bash
# ===========================================================================
#  KAMi-VPS-1 — scripted SSH access recovery via the OCI CLI
#  Run this FROM OCI CLOUD SHELL (the oci CLI is pre-installed and already
#  authenticated there). It drives the whole Oracle-documented boot-volume
#  recovery: backup -> helper VM -> stop -> detach -> mount+append key ->
#  reattach -> start -> verify.
#
#  It NEVER terminates anything except the helper VM, and only when you
#  explicitly run the "cleanup" phase.
#
#  USAGE
#    bash oci-recover-access.sh plan       # resolve everything, change nothing
#    bash oci-recover-access.sh backup     # create the boot-volume backup only
#    bash oci-recover-access.sh full       # the whole recovery (prompts before stop)
#    bash oci-recover-access.sh cleanup    # delete the helper VM afterwards
#
#  Re-runnable: each phase checks current state and skips work already done.
# ===========================================================================
set -euo pipefail

# ------------------------------- config ------------------------------------
# No infrastructure identifiers are stored in this repo. Provide them via the
# environment, or once by creating  ~/.kami-recovery/env  (outside the repo):
#   echo 'INSTANCE_OCID=ocid1.instance.oc1...'   >  ~/.kami-recovery/env
#   echo 'BOOT_VOLUME_OCID=ocid1.bootvolume...'  >> ~/.kami-recovery/env
ENV_FILE="${ENV_FILE:-$HOME/.kami-recovery/env}"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
INSTANCE_OCID="${INSTANCE_OCID:-}"
BOOT_VOLUME_OCID="${BOOT_VOLUME_OCID:-}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/kami_vps}"
PUBKEY_FILE="${PUBKEY_FILE:-${SSH_KEY}.pub}"

HELPER_NAME="${HELPER_NAME:-kami-helper}"
HELPER_SHAPE="${HELPER_SHAPE:-VM.Standard.E2.1.Micro}"   # x86, always-free-eligible, no A1 capacity errors
HELPER_IMAGE_OCID="${HELPER_IMAGE_OCID:-}"               # leave blank to auto-resolve latest Ubuntu 24.04 for that shape
HELPER_USER="${HELPER_USER:-ubuntu}"

MOUNT_POINT="/mnt/kami_root"
STATE_DIR="$HOME/.kami-recovery"
# ---------------------------------------------------------------------------

mkdir -p "$STATE_DIR"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {   # confirm "question"  -> aborts unless y
  read -r -p "$1 [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Aborted by user."; exit 0; }
}

# oci query helper:  oq <jmespath> <oci args...>   (prints raw value)
oq() { local q="$1"; shift; oci "$@" --query "$q" --raw-output; }

# wait_until <description> <desired-state> <timeout-secs> <command...>
wait_until() {
  local desc="$1" want="$2" timeout="$3"; shift 3
  local waited=0 state=""
  while (( waited < timeout )); do
    state="$("$@" 2>/dev/null || echo '<error>')"
    [[ "$state" == "$want" ]] && { ok "$desc: $state"; return 0; }
    sleep 15; waited=$((waited+15))
    printf '    ...%s is "%s" (waiting for %s, %ss)\n' "$desc" "$state" "$want" "$waited"
  done
  die "Timed out waiting for $desc to become $want (last seen: $state)"
}

ssh_helper() {   # ssh_helper <command>   -> runs on helper, non-interactive
  ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$HOME/.ssh/known_hosts" -o ConnectTimeout=15 \
      "$HELPER_USER@$HELPER_IP" "$1"
}

# ================================ PREFLIGHT =================================
preflight() {
  log "Preflight"
  command -v oci >/dev/null || die "oci CLI not found. Run this from OCI Cloud Shell."
  if [[ -z "$INSTANCE_OCID" ]]; then
    cat >&2 <<EOM
No instance OCID supplied. Create $ENV_FILE (outside the repo) containing:
    INSTANCE_OCID=ocid1.instance.oc1.<region>.<unique>
    BOOT_VOLUME_OCID=ocid1.bootvolume.oc1.<region>.<unique>
or export them before running this script.
EOM
    exit 1
  fi
  [[ -f "$SSH_KEY" ]]     || die "private key not found: $SSH_KEY"
  [[ -f "$PUBKEY_FILE" ]] || die "public key not found: $PUBKEY_FILE"
  chmod 600 "$SSH_KEY" 2>/dev/null || true

  COMPARTMENT="$(oq 'data."compartment-id"' compute instance get --instance-id "$INSTANCE_OCID")"
  AD="$(oq 'data."availability-domain"'    compute instance get --instance-id "$INSTANCE_OCID")"
  DISPLAY_NAME="$(oq 'data."display-name"' compute instance get --instance-id "$INSTANCE_OCID")"
  LIFECYCLE="$(oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID")"
  [[ -n "$COMPARTMENT" && "$COMPARTMENT" != "None" ]] || die "cannot read instance $INSTANCE_OCID (OCID wrong, or wrong region?)"

  TARGET_IP="$(oq 'data[0]."public-ip"' compute instance list-vnics --instance-id "$INSTANCE_OCID")"
  SUBNET_ID="$(oq 'data[0]."subnet-id"' compute instance list-vnics --instance-id "$INSTANCE_OCID")"

  ok "instance      : $DISPLAY_NAME ($LIFECYCLE)"
  ok "compartment   : $COMPARTMENT"
  ok "AD            : $AD"
  ok "public IP     : $TARGET_IP"
  ok "subnet        : $SUBNET_ID"
  ok "boot volume   : $BOOT_VOLUME_OCID  [$(
        oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID")]"

  # does the instance actually hold the boot volume we think it does?
  local attached_bv
  attached_bv="$(oq 'data[0]."boot-volume-id"' compute boot-volume-attachment list \
                  --compartment-id "$COMPARTMENT" --availability-domain "$AD" \
                  --instance-id "$INSTANCE_OCID" 2>/dev/null || true)"
  if [[ -n "$attached_bv" && "$attached_bv" != "None" && "$attached_bv" != "$BOOT_VOLUME_OCID" ]]; then
    warn "instance currently has boot volume $attached_bv, not the configured one."
    BOOT_VOLUME_OCID="$attached_bv"
    warn "using the actually-attached volume instead: $BOOT_VOLUME_OCID"
  fi

  # helper image
  if [[ -z "$HELPER_IMAGE_OCID" ]]; then
    HELPER_IMAGE_OCID="$(oq 'data[0].id' compute image list \
        --compartment-id "$COMPARTMENT" --operating-system "Canonical Ubuntu" \
        --operating-system-version "24.04" --shape "$HELPER_SHAPE" \
        --sort-by TIMECREATED --sort-order DESC --all 2>/dev/null || true)"
  fi
  [[ -n "$HELPER_IMAGE_OCID" && "$HELPER_IMAGE_OCID" != "None" ]] \
    || die "could not auto-resolve an Ubuntu 24.04 image for shape $HELPER_SHAPE.
       Find one in Console > Compute > Custom Images / platform images, then re-run with:
       HELPER_IMAGE_OCID=ocid1.image.oc1.uk-london-1.aaaa... bash $0 $PHASE"
  ok "helper image  : $HELPER_IMAGE_OCID"
}

# ================================ PHASE: PLAN ===============================
phase_plan() {
  preflight
  log "Plan (nothing will be changed)"
  cat <<EOF
   1. Back up boot volume $BOOT_VOLUME_OCID   (safety net, instance stays RUNNING)
   2. Launch helper VM "$HELPER_NAME" in $AD, shape $HELPER_SHAPE,
      subnet $SUBNET_ID, authorised with $PUBKEY_FILE
   3. STOP (never terminate) $DISPLAY_NAME
   4. Detach its boot volume
   5. Attach it to $HELPER_NAME as a paravirtualised Read/Write data volume
   6. On the helper: mount the root partition read-only to probe, then read-write,
      back up authorized_keys, append your key, fix owner/perms, verify fingerprint
   7. Unmount, detach from helper
   8. Reattach the volume as the boot volume of the ORIGINAL instance
   9. Start $DISPLAY_NAME, wait for RUNNING, then test:
        ssh -i $SSH_KEY ubuntu@$TARGET_IP
  10. bash $0 cleanup   deletes the helper VM when you are happy

   Expected downtime: 15-30 min. Public IP $TARGET_IP is kept.
EOF
}

# =============================== PHASE: BACKUP ==============================
phase_backup() {
  preflight
  log "Boot volume backup (safety net)"
  local stamp name
  stamp="$(date +%Y%m%d-%H%M%S)"
  name="kami-vps1-pre-recovery-$stamp"

  local backup_id
  backup_id="$(oq 'data.id' bv boot-volume-backup create \
                 --boot-volume-id "$BOOT_VOLUME_OCID" \
                 --display-name "$name" --type INCREMENTAL)"
  echo "$backup_id" > "$STATE_DIR/last-backup-id"
  ok "backup requested: $backup_id ($name)"

  wait_until "backup state" AVAILABLE 1800 \
    oq 'data."lifecycle-state"' bv boot-volume-backup get --boot-volume-backup-id "$backup_id"
  ok "Backup AVAILABLE — you now have a rollback point."
}

# ================================ PHASE: FULL ===============================
launch_helper() {
  log "Launching helper VM $HELPER_NAME"
  if [[ -f "$STATE_DIR/helper-id" ]]; then
    HELPER_ID="$(cat "$STATE_DIR/helper-id")"
    ok "helper already recorded: $HELPER_ID (reusing)"
  else
    HELPER_ID="$(oq 'data.id' compute instance launch \
        --compartment-id "$COMPARTMENT" \
        --availability-domain "$AD" \
        --display-name "$HELPER_NAME" \
        --shape "$HELPER_SHAPE" \
        --image-id "$HELPER_IMAGE_OCID" \
        --subnet-id "$SUBNET_ID" \
        --assign-public-ip true \
        --ssh-authorized-keys-file "$PUBKEY_FILE")"
    echo "$HELPER_ID" > "$STATE_DIR/helper-id"
    ok "launched: $HELPER_ID"
  fi

  wait_until "helper state" RUNNING 900 \
    oq 'data."lifecycle-state"' compute instance get --instance-id "$HELPER_ID"

  HELPER_IP="$(oq 'data[0]."public-ip"' compute instance list-vnics --instance-id "$HELPER_ID")"
  echo "$HELPER_IP" > "$STATE_DIR/helper-ip"
  ok "helper public IP: $HELPER_IP"

  # wait for sshd
  local tries=0
  until ssh_helper 'echo ready' 2>/dev/null | grep -q ready; do
    tries=$((tries+1)); (( tries > 20 )) && die "helper never became reachable over SSH at $HELPER_IP"
    sleep 15
  done
  ok "helper reachable over SSH as $HELPER_USER@$HELPER_IP"
}

write_helper_script() {
  # generate the in-guest fix script, injecting the public key from your key file
  local pubkey
  pubkey="$(cat "$PUBKEY_FILE")"
  cat > "$STATE_DIR/add_kami_key.sh" <<HELPER_EOF
#!/usr/bin/env bash
# Appends your public key to /home/ubuntu/.ssh/authorized_keys on the attached
# KAMi-VPS-1 boot volume. Writes only inside $MOUNT_POINT.
set -euo pipefail
TARGET_USER=ubuntu
MOUNT=$MOUNT_POINT
PUBKEY='$pubkey'

[ "\$(id -u)" = 0 ] || { echo "Re-run with: sudo bash \$0"; exit 1; }

echo "=== 1. Block devices ==="
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINTS

mkdir -p "\$MOUNT"
echo
echo "=== 2. Probing partitions for the KAMi root filesystem ==="
ROOT_DEV=""
while read -r dev fstype mountpoint; do
  [ -n "\$fstype" ] || continue
  case "\$fstype" in vfat|swap|LVM2_member|iso9660) continue ;; esac
  [ -z "\$mountpoint" ] || continue
  mount -o ro "\$dev" "\$MOUNT" 2>/dev/null || continue
  if [ -d "\$MOUNT/home/\$TARGET_USER" ] && [ -f "\$MOUNT/etc/os-release" ]; then
    ROOT_DEV="\$dev"; umount "\$MOUNT"; echo "FOUND root filesystem: \$dev (\$fstype)"; break
  fi
  umount "\$MOUNT" 2>/dev/null || true
done < <(lsblk -lnpo NAME,FSTYPE,MOUNTPOINTS)

[ -n "\$ROOT_DEV" ] || { echo "No root filesystem found. Try: sudo vgchange -ay && sudo lvs; or lsblk -f"; exit 1; }

mount "\$ROOT_DEV" "\$MOUNT"
echo "Mounted \$ROOT_DEV at \$MOUNT"
grep -E '^PRETTY_NAME' "\$MOUNT/etc/os-release" || true

UID_=\$(awk -F: -v u="\$TARGET_USER" '\$1==u{print \$3}' "\$MOUNT/etc/passwd")
GID_=\$(awk -F: -v u="\$TARGET_USER" '\$1==u{print \$4}' "\$MOUNT/etc/passwd")
[ -n "\${UID_:-}" ] || { echo "user \$TARGET_USER missing on the volume"; exit 1; }

SSHDIR="\$MOUNT/home/\$TARGET_USER/.ssh"
AK="\$SSHDIR/authorized_keys"
mkdir -p "\$SSHDIR"
[ -f "\$AK" ] || : > "\$AK"
cp -a "\$AK" "\$AK.bak.\$(date +%Y%m%d%H%M%S)"

KEY_BLOB=\$(printf '%s' "\$PUBKEY" | awk '{print \$1" "\$2}')
if grep -qF "\$KEY_BLOB" "\$AK"; then
  echo "Key already present — nothing appended."
else
  printf '\n%s\n' "\$PUBKEY" >> "\$AK"
  echo "Key appended."
fi

chown -R "\$UID_:\$GID_" "\$SSHDIR"
chmod 700 "\$SSHDIR"
chmod 600 "\$AK"

echo
echo "=== 3. Verification ==="
ls -l "\$SSHDIR"
printf '%s\n' "\$PUBKEY" > /tmp/kami_added.pub
ssh-keygen -l -f /tmp/kami_added.pub
rm -f /tmp/kami_added.pub
echo "All authorised keys now on the volume:"
ssh-keygen -l -f "\$AK"
echo
echo "DONE — leave the volume mounted; the driver script unmounts it."
HELPER_EOF
  ok "generated in-guest fix script"
}

phase_full() {
  preflight

  if [[ ! -f "$STATE_DIR/last-backup-id" ]]; then
    warn "No backup recorded in this session."
    confirm "Create a boot-volume backup first? (strongly recommended)"
    phase_backup
  else
    ok "backup present from this session: $(cat "$STATE_DIR/last-backup-id")"
  fi

  launch_helper
  write_helper_script

  # ---------------- stop the real instance ----------------
  log "Stopping $DISPLAY_NAME (STOP — never terminate)"
  [[ "$LIFECYCLE" == "STOPPED" ]] || confirm "This takes KAMi-VPS-1 offline for ~15-30 min. Continue?"
  if [[ "$LIFECYCLE" != "STOPPED" ]]; then
    oci compute instance action --instance-id "$INSTANCE_OCID" --action SOFTSTOP --wait-for-state STOPPED \
      >/dev/null 2>&1 || true
  fi
  wait_until "instance state" STOPPED 1200 \
    oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID"

  # ---------------- detach boot volume ----------------
  log "Detaching boot volume from $DISPLAY_NAME"
  local bv_attach_id
  bv_attach_id="$(oq 'data[0].id' compute boot-volume-attachment list \
                    --compartment-id "$COMPARTMENT" --availability-domain "$AD" \
                    --instance-id "$INSTANCE_OCID")"
  [[ -n "$bv_attach_id" && "$bv_attach_id" != "None" ]] || die "no boot volume attachment found"
  oci compute boot-volume-attachment detach --boot-volume-attachment-id "$bv_attach_id" --force >/dev/null
  wait_until "boot volume state" AVAILABLE 900 \
    oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID"

  # ---------------- attach to helper as data volume ----------------
  log "Attaching boot volume to $HELPER_NAME as a paravirtualised data volume"
  local data_attach_id
  data_attach_id="$(oq 'data.id' compute volume-attachment attach-paravirtualized-volume \
                     --instance-id "$HELPER_ID" --volume-id "$BOOT_VOLUME_OCID" \
                     --display-name "kami-root-for-repair" --is-read-only false)"
  echo "$data_attach_id" > "$STATE_DIR/data-attachment-id"
  wait_until "data attachment" ATTACHED 900 \
    oq 'data."lifecycle-state"' compute volume-attachment get --volume-attachment-id "$data_attach_id"

  # ---------------- fix authorized_keys ----------------
  log "Appending your key on the helper VM"
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -q \
      "$STATE_DIR/add_kami_key.sh" "$HELPER_USER@$HELPER_IP:/tmp/add_kami_key.sh"
  local out
  out="$(ssh_helper 'sudo bash /tmp/add_kami_key.sh')"
  echo "$out"
  echo "$out" | grep -q "kami-vps-key (RSA)" \
    || die "the key fingerprint line was not found in the output above — investigate before continuing"
  ok "key written and verified on the volume"

  log "Unmounting"
  ssh_helper "sudo sync; sudo umount $MOUNT_POINT; lsblk -o NAME,FSTYPE,MOUNTPOINTS"

  # ---------------- detach from helper ----------------
  log "Detaching the volume from $HELPER_NAME"
  oci compute volume-attachment detach --volume-attachment-id "$data_attach_id" --force >/dev/null
  wait_until "boot volume state" AVAILABLE 900 \
    oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID"

  # ---------------- reattach as boot volume ----------------
  log "Reattaching the volume as the boot volume of $DISPLAY_NAME"
  local new_bv_attach
  new_bv_attach="$(oq 'data.id' compute boot-volume-attachment attach \
                    --boot-volume-id "$BOOT_VOLUME_OCID" --instance-id "$INSTANCE_OCID")"
  wait_until "boot attachment" ATTACHED 900 \
    oq 'data."lifecycle-state"' compute boot-volume-attachment get \
       --boot-volume-attachment-id "$new_bv_attach"

  # ---------------- start and verify ----------------
  log "Starting $DISPLAY_NAME"
  oci compute instance action --instance-id "$INSTANCE_OCID" --action START >/dev/null
  wait_until "instance state" RUNNING 900 \
    oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID"

  log "Waiting for sshd"
  local tries=0
  until ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=10 "ubuntu@$TARGET_IP" 'echo READY' 2>/dev/null | grep -q READY; do
    tries=$((tries+1)); (( tries > 20 )) && die "instance is RUNNING but not accepting your key — check the output above"
    sleep 15
  done

  log "SUCCESS — running the first read-only checks on KAMi-VPS-1"
  ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "ubuntu@$TARGET_IP" \
    'echo "HOST=$(hostname)"; echo "USER=$(id -un)"; grep PRETTY_NAME /etc/os-release;
     echo; docker ps --format "table {{.Names}}\t{{.Status}}" 2>/dev/null || echo "(docker unavailable)";
     echo; df -h /'

  cat <<EOF

  ------------------------------------------------------------------
  Access restored.
     ssh -i $SSH_KEY ubuntu@$TARGET_IP
  Clean up the helper VM when you are happy:
     bash $0 cleanup
  ------------------------------------------------------------------
EOF
}

# ============================== PHASE: CLEANUP ==============================
phase_cleanup() {
  preflight
  [[ -f "$STATE_DIR/helper-id" ]] || die "no helper recorded; nothing to clean up"
  HELPER_ID="$(cat "$STATE_DIR/helper-id")"
  log "Terminating helper VM $HELPER_ID"
  warn "This deletes ONLY the helper VM and its own 50 GB boot disk."
  confirm "Delete the helper VM now?"
  oci compute instance terminate --instance-id "$HELPER_ID" --force \
      --preserve-boot-volume false >/dev/null
  rm -f "$STATE_DIR/helper-id" "$STATE_DIR/helper-ip" "$STATE_DIR/data-attachment-id"
  ok "helper deleted. Your backup is untouched (see $STATE_DIR/last-backup-id)."
}

# ================================== MAIN ====================================
PHASE="${1:-plan}"
case "$PHASE" in
  plan)    phase_plan ;;
  backup)  phase_backup ;;
  full)    phase_full ;;
  cleanup) phase_cleanup ;;
  *)       echo "usage: $0 {plan|backup|full|cleanup}" ; exit 1 ;;
esac
