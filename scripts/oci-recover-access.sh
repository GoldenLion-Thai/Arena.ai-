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
INSTANCE_OCID="${INSTANCE_OCID:-}"
BOOT_VOLUME_OCID="${BOOT_VOLUME_OCID:-}"

# Read ~/.kami-recovery/env line by line. Malformed or leftover placeholder
# values are ignored with a warning instead of breaking the whole script
# (a line like  BOOT_VOLUME_OCID=<paste here>  must never cause a syntax error).
load_env_file() {
  [[ -f "$ENV_FILE" ]] || return 0
  local k v
  while IFS='=' read -r k v || [[ -n "$k" ]]; do
    k="${k#"${k%%[![:space:]]*}"}"; k="${k%%[[:space:]]*}"
    v="${v%$'\r'}"
    v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    [[ -z "$k" || "$k" == \#* ]] && continue
    if [[ -z "$v" || "$v" == *"<"* || "$v" == *">"* ]]; then
      warn "ignoring unusable value for $k in $ENV_FILE (placeholder or empty)"
      continue
    fi
    case "$k" in
      INSTANCE_OCID|BOOT_VOLUME_OCID|TENANCY_OCID|HELPER_ID|HELPER_IMAGE_OCID|HELPER_NAME|HELPER_SHAPE|HELPER_USER|SSH_KEY|PUBKEY_FILE)
        printf -v "$k" '%s' "$v" ;;
      *) warn "ignoring unknown setting $k in $ENV_FILE" ;;
    esac
  done < "$ENV_FILE"
  return 0
}

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

# identifiers from ~/.kami-recovery/env (if present)
load_env_file

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
  # ---- auto-resolve the instance if no OCID was supplied ----
  # The tenancy is ONLY needed for the name lookup below. When INSTANCE_OCID is
  # known we derive the compartment straight from the instance, so a missing
  # OCI_CLI_TENANCY must never block the recovery.
  if [[ -z "$INSTANCE_OCID" && "${CTX_MODE:-instance}" == "instance" ]]; then
    local ten="${OCI_CLI_TENANCY:-${TENANCY_OCID:-}}"
    [[ -n "$ten" ]] || die "no INSTANCE_OCID and no tenancy to look one up by name.
       Add the instance OCID to $ENV_FILE - it is all this script needs:
           echo 'INSTANCE_OCID=ocid1.instance.oc1...' > $ENV_FILE
       (Console > Compute > Instances > kami-VPS-1 > OCID)
       Optionally add TENANCY_OCID=ocid1.tenancy... as well."
    local cand
    for cand in "${INSTANCE_NAME:-}" "kami-VPS-1" "KAMi-VPS-1" "kami-vps-1" "KAMI-VPS-1"; do
      [[ -n "$cand" ]] || continue
      INSTANCE_OCID="$(oq 'data[0].id' compute instance list --compartment-id "$ten" \
                          --display-name "$cand" --all 2>/dev/null || true)"
      [[ -n "$INSTANCE_OCID" && "$INSTANCE_OCID" != "None" ]] && { ok "found instance by name: $cand"; break; }
      INSTANCE_OCID=""
    done
    [[ -n "$INSTANCE_OCID" ]] || die "could not find an instance called kami-VPS-1.
       Put its OCID in $ENV_FILE as  INSTANCE_OCID=ocid1.instance.oc1... "
  fi
  [[ -f "$SSH_KEY" ]]     || die "private key not found: $SSH_KEY"
  [[ -f "$PUBKEY_FILE" ]] || die "public key not found: $PUBKEY_FILE"
  chmod 600 "$SSH_KEY" 2>/dev/null || true

  if [[ "${CTX_MODE:-instance}" == "volume" ]]; then
    # The instance is gone (terminated). Derive everything from the surviving
    # boot volume instead: compartment, AD and size all live on the volume.
    COMPARTMENT="$(oq 'data."compartment-id"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID")"
    AD="$(oq 'data."availability-domain"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID")"
    VOL_STATE="$(oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID")"
    VOL_SIZE="$(oq 'data."size-in-gbs"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID")"
    DISPLAY_NAME="(rebuilding - no instance yet)"
    LIFECYCLE="TERMINATED"
    TARGET_IP=""
    [[ -n "$COMPARTMENT" && "$COMPARTMENT" != "None" ]] || die "cannot read boot volume $BOOT_VOLUME_OCID"
    ok "context      : volume-only (instance terminated)"
    ok "volume       : ${VOL_SIZE} GB, state $VOL_STATE"
    ok "compartment  : $COMPARTMENT"
    ok "AD           : $AD"
    preflight_tail
    return
  fi

  COMPARTMENT="$(oq 'data."compartment-id"' compute instance get --instance-id "$INSTANCE_OCID")"
  AD="$(oq 'data."availability-domain"'    compute instance get --instance-id "$INSTANCE_OCID")"
  DISPLAY_NAME="$(oq 'data."display-name"' compute instance get --instance-id "$INSTANCE_OCID")"
  LIFECYCLE="$(oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID")"
  [[ -n "$COMPARTMENT" && "$COMPARTMENT" != "None" ]] || die "cannot read instance $INSTANCE_OCID (OCID wrong, or wrong region?)"

  # ---- auto-resolve the boot volume if none was supplied ----
  if [[ -z "$BOOT_VOLUME_OCID" ]]; then
    BOOT_VOLUME_OCID="$(oq 'data[0]."boot-volume-id"' compute boot-volume-attachment list \
                          --compartment-id "$COMPARTMENT" --availability-domain "$AD" \
                          --instance-id "$INSTANCE_OCID" 2>/dev/null || true)"
    [[ -n "$BOOT_VOLUME_OCID" && "$BOOT_VOLUME_OCID" != "None" ]] \
      || die "could not find the boot volume attached to this instance. Add
       BOOT_VOLUME_OCID=ocid1.bootvolume.oc1... to $ENV_FILE"
    ok "boot volume auto-detected from the instance"
  fi

  TARGET_IP="$(oq 'data[0]."public-ip"' compute instance list-vnics --instance-id "$INSTANCE_OCID")"
  SUBNET_ID="$(oq 'data[0]."subnet-id"' compute instance list-vnics --instance-id "$INSTANCE_OCID")"

  ok "instance      : $DISPLAY_NAME ($LIFECYCLE)"
  ok "compartment   : $COMPARTMENT"
  ok "AD            : $AD"
  ok "public IP     : $TARGET_IP"
  ok "subnet        : $SUBNET_ID"
  ok "boot volume   : $BOOT_VOLUME_OCID  [$(
        oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID")]"

  preflight_tail
}

preflight_tail() {
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

launch_helper() {
  log "Launching helper VM $HELPER_NAME"
  if [[ -f "$STATE_DIR/helper-id" ]]; then
    HELPER_ID="$(cat "$STATE_DIR/helper-id")"
    ok "helper already recorded: $HELPER_ID (reusing)"
  elif [[ -n "${HELPER_ID:-}" ]]; then
    ok "helper supplied in the environment: $HELPER_ID (reusing)"
    echo "$HELPER_ID" > "$STATE_DIR/helper-id"
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

# ========================== GRANULAR, CONFIRMED STEPS =======================
# Each mutating step is separate, idempotent where possible, and refuses to run
# until you type "yes". Run them one at a time and read the output between each.
# ---------------------------------------------------------------------------
gate() {   # gate "what this step will do"
  echo
  printf '    \033[1;33mNEXT STEP:\033[0m %s\n' "$1"
  if [[ "${ASSUME_YES:-0}" == "1" ]]; then
    warn "AUTO-CONFIRMED (ASSUME_YES=1)"
    return
  fi
  read -r -p "    Type 'yes' to do this step, anything else aborts: " REPLY
  [[ "$REPLY" == "yes" ]] || { echo "    Aborted. Nothing was changed."; exit 0; }
}

load_state() {
  # NOTE: each line must tolerate a missing file without tripping `set -e`.
  if [[ -f "$STATE_DIR/helper-id" ]];          then HELPER_ID="$(cat "$STATE_DIR/helper-id")";          fi
  if [[ -f "$STATE_DIR/helper-ip" ]];          then HELPER_IP="$(cat "$STATE_DIR/helper-ip")";          fi
  if [[ -f "$STATE_DIR/data-attachment-id" ]]; then DATA_ATTACH_ID="$(cat "$STATE_DIR/data-attachment-id")"; fi
  return 0
}

ensure_backup() {
  if [[ -f "$STATE_DIR/last-backup-id" ]]; then
    ok "backup present: $(cat "$STATE_DIR/last-backup-id")"
    return
  fi
  # look for any recent pre-recovery backup that already exists
  local existing
  existing="$(oq 'data[0].id' bv boot-volume-backup list \
                --compartment-id "$COMPARTMENT" --boot-volume-id "$BOOT_VOLUME_OCID" 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "None" ]]; then
    echo "$existing" > "$STATE_DIR/last-backup-id"
    ok "adopted existing backup: $existing"
    return
  fi
  warn "No backup recorded."
  gate "create a boot-volume backup first (strongly recommended)"
  phase_backup
}

ensure_helper() {
  load_state
  if [[ -n "${HELPER_ID:-}" ]]; then
    ok "helper recorded: $HELPER_ID"
  else
    # IMPORTANT: if a VM called $HELPER_NAME already exists (e.g. you created it
    # by hand), adopt it instead of launching a second one.
    local found
    found="$(oq 'data[0].id' compute instance list --compartment-id "$COMPARTMENT" \
               --display-name "$HELPER_NAME" --lifecycle-state RUNNING 2>/dev/null || true)"
    if [[ -n "$found" && "$found" != "None" ]]; then
      HELPER_ID="$found"
      echo "$HELPER_ID" > "$STATE_DIR/helper-id"
      ok "adopted existing helper VM named $HELPER_NAME (no second VM created)"
    else
      gate "launch helper VM $HELPER_NAME in $AD (adds a ~50 GB boot disk)"
      launch_helper
    fi
  fi
  HELPER_IP="$(oq 'data[0]."public-ip"' compute instance list-vnics --instance-id "$HELPER_ID")"
  echo "$HELPER_IP" > "$STATE_DIR/helper-ip"
  ok "helper public IP: $HELPER_IP"
  write_helper_script
}

step_stop() {
  preflight
  ensure_backup
  ensure_helper
  LIFECYCLE="$(oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID")"
  if [[ "$LIFECYCLE" == "STOPPED" ]]; then ok "$DISPLAY_NAME already STOPPED"; return; fi
  gate "STOP $DISPLAY_NAME (STOP, never terminate) — offline ~15-30 min"
  log "Stopping $DISPLAY_NAME"
  oci compute instance action --instance-id "$INSTANCE_OCID" --action SOFTSTOP \
      --wait-for-state STOPPED >/dev/null 2>&1 || true
  wait_until "instance state" STOPPED 1200 \
    oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID"
  ok "instance is STOPPED. Boot volume still exists and is intact."
}

step_detach() {
  preflight
  local bv_attach_id
  bv_attach_id="$(oq 'data[0].id' compute boot-volume-attachment list \
                    --compartment-id "$COMPARTMENT" --availability-domain "$AD" \
                    --instance-id "$INSTANCE_OCID" 2>/dev/null || true)"
  [[ -n "$bv_attach_id" && "$bv_attach_id" != "None" ]] || { ok "no boot volume attached - already detached"; return; }
  gate "detach boot volume $BOOT_VOLUME_OCID from $DISPLAY_NAME"
  log "Detaching boot volume"
  oci compute boot-volume-attachment detach --boot-volume-attachment-id "$bv_attach_id" --force >/dev/null
  wait_until "boot volume state" AVAILABLE 900 \
    oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID"
  ok "boot volume detached and AVAILABLE (data untouched)."
}

step_attach() {
  preflight; load_state
  [[ -n "${HELPER_ID:-}" ]] || die "no helper recorded - run: bash $0 helper"
  if [[ -n "${DATA_ATTACH_ID:-}" ]]; then
    local st
    st="$(oq 'data."lifecycle-state"' compute volume-attachment get \
             --volume-attachment-id "$DATA_ATTACH_ID" 2>/dev/null || true)"
    [[ "$st" == "ATTACHED" ]] && { ok "volume already attached to helper"; return; }
  fi
  gate "attach the KAMi boot volume to $HELPER_NAME as a Read/Write data volume"
  DATA_ATTACH_ID="$(oq 'data.id' compute volume-attachment attach-paravirtualized-volume \
                     --instance-id "$HELPER_ID" --volume-id "$BOOT_VOLUME_OCID" \
                     --display-name "kami-root-for-repair" --is-read-only false)"
  echo "$DATA_ATTACH_ID" > "$STATE_DIR/data-attachment-id"
  wait_until "data attachment" ATTACHED 900 \
    oq 'data."lifecycle-state"' compute volume-attachment get --volume-attachment-id "$DATA_ATTACH_ID"
  ok "attached. On the helper it will appear as a new disk (lsblk)."
}

step_fix() {
  preflight; load_state
  [[ -n "${HELPER_IP:-}" ]] || die "no helper IP recorded - run: bash $0 helper"
  write_helper_script
  gate "append your public key to /home/ubuntu/.ssh/authorized_keys on the attached volume"
  log "Copying the fix script to the helper and running it"
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -q \
      "$STATE_DIR/add_kami_key.sh" "$HELPER_USER@$HELPER_IP:/tmp/add_kami_key.sh"
  local out
  out="$(ssh_helper 'sudo bash /tmp/add_kami_key.sh')"
  echo "$out"
  echo "$out" | grep -q "kami-vps-key (RSA)" \
    || die "the key fingerprint line was not found in the output above - investigate before continuing"
  ok "key written and verified on the volume"
  log "Unmounting"
  ssh_helper "sudo sync; sudo umount $MOUNT_POINT; lsblk -o NAME,FSTYPE,MOUNTPOINTS"
}

step_unattach() {
  preflight; load_state
  [[ -n "${DATA_ATTACH_ID:-}" ]] || die "no data attachment recorded - run: bash $0 attach"
  gate "detach the volume from $HELPER_NAME"
  oci compute volume-attachment detach --volume-attachment-id "$DATA_ATTACH_ID" --force >/dev/null
  wait_until "boot volume state" AVAILABLE 900 \
    oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID"
  rm -f "$STATE_DIR/data-attachment-id"
  ok "detached from helper."
}

step_reattach() {
  preflight
  local cur
  cur="$(oq 'data[0]."boot-volume-id"' compute boot-volume-attachment list \
           --compartment-id "$COMPARTMENT" --availability-domain "$AD" \
           --instance-id "$INSTANCE_OCID" 2>/dev/null || true)"
  if [[ -n "$cur" && "$cur" != "None" ]]; then ok "boot volume already attached to $DISPLAY_NAME"; return; fi
  gate "reattach $BOOT_VOLUME_OCID as the BOOT volume of $DISPLAY_NAME"
  local new_bv_attach
  new_bv_attach="$(oq 'data.id' compute boot-volume-attachment attach \
                    --boot-volume-id "$BOOT_VOLUME_OCID" --instance-id "$INSTANCE_OCID")"
  wait_until "boot attachment" ATTACHED 900 \
    oq 'data."lifecycle-state"' compute boot-volume-attachment get \
       --boot-volume-attachment-id "$new_bv_attach"
  ok "reattached as boot volume."
}

step_start() {
  preflight
  LIFECYCLE="$(oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID")"
  if [[ "$LIFECYCLE" == "RUNNING" ]]; then ok "$DISPLAY_NAME already RUNNING"; else
    gate "START $DISPLAY_NAME"
    oci compute instance action --instance-id "$INSTANCE_OCID" --action START >/dev/null
    wait_until "instance state" RUNNING 900 \
      oq 'data."lifecycle-state"' compute instance get --instance-id "$INSTANCE_OCID"
  fi
  log "Waiting for sshd to accept your key"
  local tries=0
  until ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=10 "ubuntu@$TARGET_IP" 'echo READY' 2>/dev/null | grep -q READY; do
    tries=$((tries+1)); (( tries > 20 )) && die "instance is RUNNING but not accepting your key - check the output above"
    sleep 15
  done
  log "SUCCESS - running the first read-only checks on $DISPLAY_NAME"
  ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "ubuntu@$TARGET_IP" \
    'echo "HOST=$(hostname)"; echo "USER=$(id -un)"; grep PRETTY_NAME /etc/os-release;
     echo; docker ps --format "table {{.Names}}\t{{.Status}}" 2>/dev/null || echo "(docker unavailable)";
     echo; df -h /'
  cat <<EOF

  ------------------------------------------------------------------
  Access restored.
     ssh -i $SSH_KEY ubuntu@$TARGET_IP
  Clean up the helper VM when you are happy (it costs storage until it is gone):
     bash $0 cleanup
  ------------------------------------------------------------------
EOF
}

# ------------------------------- phase: helper ------------------------------
phase_helper() {
  preflight
  ensure_helper
  cat <<EOF

  Helper is ready.
     ssh -i $SSH_KEY -o IdentitiesOnly=yes $HELPER_USER@$HELPER_IP
  Expect the prompt:  $HELPER_USER@$HELPER_NAME:~\$
EOF
}

# ------------------------------- phase: status ------------------------------
phase_status() {
  preflight; load_state
  log "Recovery state"
  ok "instance     : $DISPLAY_NAME ($LIFECYCLE) at $TARGET_IP"
  ok "boot volume  : $BOOT_VOLUME_OCID"
  ok "backup       : $( [[ -f "$STATE_DIR/last-backup-id" ]] && cat "$STATE_DIR/last-backup-id" || echo 'none recorded' )"
  ok "helper       : ${HELPER_ID:-none recorded}"
  ok "helper IP    : ${HELPER_IP:-none recorded}"
  ok "data attach  : ${DATA_ATTACH_ID:-none recorded}"
  echo
  echo "    Next step suggestions:"
  [[ "$LIFECYCLE" == "RUNNING" && -z "${DATA_ATTACH_ID:-}" ]] && echo "      bash $0 stop     (after the helper SSH test passes)"
  [[ "$LIFECYCLE" == "STOPPED" && -z "${DATA_ATTACH_ID:-}" ]] && echo "      bash $0 attach"
  [[ -n "${DATA_ATTACH_ID:-}" ]]                              && echo "      bash $0 fix, then unattach, reattach, start"
}

# --------------------------------- phase: full ------------------------------
phase_full() {
  cat <<'EOF'

  This runs every step below, in order, asking you to confirm each one.
  If you would rather do them one at a time (recommended), press Ctrl+C and run:
      helper -> stop -> detach -> attach -> fix -> unattach -> reattach -> start
EOF
  preflight; ensure_backup; ensure_helper
  step_stop; step_detach; step_attach; step_fix; step_unattach; step_reattach; step_start
}


# ========================= PHASE: REBUILD (volume-only) =====================
# Use this when the instance has already been TERMINATED but its boot volume
# survived. It attaches the orphaned volume to the helper, injects your key,
# detaches it, and launches a fresh instance that boots from that same volume.
#
# Two things you must know before running it:
#   * The new instance gets a NEW public IP. Update any DNS A records after.
#   * The volume holds an aarch64 Ubuntu, so the new instance MUST be an
#     Ampere A1.Flex shape. If uk-london-1 AD-1 has no A1 capacity this
#     retries - it never falls back to x86, which cannot boot this disk.
# ---------------------------------------------------------------------------
phase_rebuild() {
  CTX_MODE=volume
  preflight

  log "Boot volume $BOOT_VOLUME_OCID"
  [[ "$VOL_STATE" == "AVAILABLE" ]] || die "boot volume is $VOL_STATE, expected AVAILABLE"

  # ---- safety net: make sure a backup of this volume exists ----
  local existing_backup
  existing_backup="$(oq 'data[0].id' bv boot-volume-backup list \
                      --compartment-id "$COMPARTMENT" --boot-volume-id "$BOOT_VOLUME_OCID" 2>/dev/null || true)"
  if [[ -n "$existing_backup" && "$existing_backup" != "None" ]]; then
    ok "existing backup: $existing_backup"
    echo "$existing_backup" > "$STATE_DIR/last-backup-id"
  else
    warn "no backup of this volume exists yet"
    gate "create a backup of the ${VOL_SIZE} GB boot volume first"
    local bid
    bid="$(oq 'data.id' bv boot-volume-backup create --boot-volume-id "$BOOT_VOLUME_OCID" \
            --display-name "kami-orphan-volume-$(date +%Y%m%d-%H%M%S)" --type INCREMENTAL)"
    echo "$bid" > "$STATE_DIR/last-backup-id"
    wait_until "backup state" AVAILABLE 2400 \
      oq 'data."lifecycle-state"' bv boot-volume-backup get --boot-volume-backup-id "$bid"
  fi

  ensure_helper

  # ---- attach the orphaned volume to the helper ----
  load_state
  if [[ -z "${DATA_ATTACH_ID:-}" ]]; then
    gate "attach the ${VOL_SIZE} GB volume to $HELPER_NAME as Read/Write data volume"
    DATA_ATTACH_ID="$(oq 'data.id' compute volume-attachment attach-paravirtualized-volume \
                       --instance-id "$HELPER_ID" --volume-id "$BOOT_VOLUME_OCID" \
                       --display-name "kami-root-for-repair" --is-read-only false)"
    echo "$DATA_ATTACH_ID" > "$STATE_DIR/data-attachment-id"
  fi
  wait_until "data attachment" ATTACHED 900 \
    oq 'data."lifecycle-state"' compute volume-attachment get --volume-attachment-id "$DATA_ATTACH_ID"

  # ---- inject the key ----
  step_fix

  # ---- detach from the helper ----
  gate "detach the volume from $HELPER_NAME"
  oci compute volume-attachment detach --volume-attachment-id "$DATA_ATTACH_ID" --force >/dev/null
  wait_until "boot volume state" AVAILABLE 900 \
    oq 'data."lifecycle-state"' bv boot-volume get --boot-volume-id "$BOOT_VOLUME_OCID"
  rm -f "$STATE_DIR/data-attachment-id"
  ok "volume detached and ready to boot"

  # ---- resolve networking for the new instance ----
  if [[ -z "${SUBNET_ID:-}" ]]; then
    local vcn_id
    vcn_id="$(oq 'data[0].id' network vcn list --compartment-id "$COMPARTMENT" 2>/dev/null || true)"
    [[ -n "$vcn_id" && "$vcn_id" != "None" ]] || die "could not find a VCN; set SUBNET_ID=... in $ENV_FILE"
    SUBNET_ID="$(oq 'data[0].id' network subnet list --compartment-id "$COMPARTMENT" --vcn-id "$vcn_id" 2>/dev/null || true)"
    [[ -n "$SUBNET_ID" && "$SUBNET_ID" != "None" ]] || die "could not find a subnet; set SUBNET_ID=... in $ENV_FILE"
    ok "subnet auto-selected: $SUBNET_ID"
  fi

  # ---- launch the replacement instance from that boot volume ----
  local new_shape="${NEW_SHAPE:-VM.Standard.A1.Flex}"
  local new_ocpus="${NEW_OCPUS:-4}"
  local new_mem="${NEW_MEMORY:-24}"
  local new_name="${NEW_NAME:-kami-VPS-1}"
  cat <<EOF

  About to create a replacement instance:
      name   : $new_name
      shape  : $new_shape ($new_ocpus OCPU / ${new_mem} GB)
      AD     : $AD
      subnet : $SUBNET_ID
      boots  : the existing ${VOL_SIZE} GB volume (data preserved)
      key    : $PUBKEY_FILE

  Note: it will get a NEW public IP. DNS A records for the old IP must be updated.
EOF
  gate "create the replacement instance from the existing boot volume"

  local attempt=0 max="${CAPACITY_RETRIES:-20}" new_id="" out=""
  while (( attempt < max )); do
    attempt=$((attempt+1))
    out="$(oci compute instance launch \
            --compartment-id "$COMPARTMENT" \
            --availability-domain "$AD" \
            --display-name "$new_name" \
            --shape "$new_shape" \
            --shape-config "{\"ocpus\":$new_ocpus,\"memoryInGBs\":$new_mem}" \
            --subnet-id "$SUBNET_ID" \
            --assign-public-ip true \
            --ssh-authorized-keys-file "$PUBKEY_FILE" \
            --source-details "{\"type\":\"bootVolume\",\"bootVolumeId\":\"$BOOT_VOLUME_OCID\"}" 2>&1)" \
      && { new_id="$(printf '%s' "$out" | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -1)"; break; }
    if printf '%s' "$out" | grep -qiE 'out of (host )?capacity|capacity|insufficient'; then
      warn "attempt $attempt/$max: no $new_shape capacity in $AD right now."
      warn "Your data is safe - the volume is untouched. Retrying in 60s."
      sleep 60
      continue
    fi
    echo "$out" >&2
    die "instance launch failed (see error above). The boot volume is untouched."
  done
  [[ -n "$new_id" ]] || die "still no $new_shape capacity after $max attempts. Nothing was lost -
       the ${VOL_SIZE} GB volume is safe. Re-run 'bash $0 rebuild' later or try another AD."

  echo "$new_id" > "$STATE_DIR/new-instance-id"
  ok "instance created: $new_id"

  wait_until "instance state" RUNNING 1200 \
    oq 'data."lifecycle-state"' compute instance get --instance-id "$new_id"

  local new_ip
  new_ip="$(oq 'data[0]."public-ip"' compute instance list-vnics --instance-id "$new_id")"
  echo "$new_ip" > "$STATE_DIR/new-instance-ip"
  ok "NEW PUBLIC IP: $new_ip   (the old IP is gone - update DNS)"

  # ---- prove the key works ----
  log "Waiting for sshd to accept your key"
  local tries=0
  until ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=10 "ubuntu@$new_ip" 'echo READY' 2>/dev/null | grep -q READY; do
    tries=$((tries+1)); (( tries > 20 )) && die "instance is RUNNING but not accepting your key - check the output above"
    sleep 15
  done

  log "SUCCESS - first read-only checks on the rebuilt server"
  ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "ubuntu@$new_ip" \
    'echo "HOST=$(hostname)"; echo "USER=$(id -un)"; grep PRETTY_NAME /etc/os-release;
     echo; docker ps --format "table {{.Names}}\t{{.Status}}" 2>/dev/null || echo "(docker unavailable)";
     echo; df -h /'

  cat <<EOF

  ------------------------------------------------------------------
  Access restored on the NEW instance.
     ssh -i $SSH_KEY ubuntu@$new_ip
  Update any DNS A records that pointed at the old IP.
  Then clean up the helper VM:   bash $0 cleanup
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

usage() {
  cat <<EOF
KAMi-VPS-1 SSH access recovery — one step at a time.

  bash $0 plan       read-only report of what would happen
  bash $0 status     read-only snapshot of current recovery state
  bash $0 backup     create a boot-volume backup (safety net; instance stays up)
  bash $0 helper     create OR adopt the helper VM, print its public IP

  --- the state-changing steps, in order, each confirmed separately ---
  bash $0 stop       STOP the instance (never terminate)
  bash $0 detach     detach its boot volume
  bash $0 attach     attach it to the helper as a Read/Write data volume
  bash $0 fix        append your public key, verify, unmount
  bash $0 unattach   detach it from the helper
  bash $0 reattach   reattach it as the instance's boot volume
  bash $0 start      start the instance, wait for sshd, run first checks

  bash $0 full       run all of the above with a confirmation at each step
  bash $0 cleanup    terminate the helper VM (do this once access is proven)
  bash $0 rebuild    instance already TERMINATED: boot a fresh instance from
                     the surviving boot volume, injecting your key on the way

Every mutating step prints what it is about to do and waits for you to type
"yes". Nothing runs on autopilot unless you set ASSUME_YES=1.
EOF
}

# ================================== MAIN ====================================
PHASE="${1:-plan}"
case "$PHASE" in
  plan)      phase_plan ;;
  status)    phase_status ;;
  backup)    phase_backup ;;
  helper)    phase_helper ;;
  stop)      step_stop ;;
  detach)    step_detach ;;
  attach)    step_attach ;;
  fix)       step_fix ;;
  unattach)  step_unattach ;;
  reattach)  step_reattach ;;
  start)     step_start ;;
  rebuild)   phase_rebuild ;;
  full)      phase_full ;;
  cleanup)   phase_cleanup ;;
  -h|--help|help) usage ;;
  *)         usage ; exit 1 ;;
esac
