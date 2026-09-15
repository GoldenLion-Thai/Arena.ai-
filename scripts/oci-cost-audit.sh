#!/usr/bin/env bash
# ===========================================================================
#  KAMi-VPS-1 — READ-ONLY cost + capacity audit (run from OCI Cloud Shell)
#
#  Answers three questions without changing anything:
#    1. What is my total allocated block storage, and what is each volume?
#       (Always Free allowance is 200 GB TOTAL across boot + data volumes,
#        not 100 GB. If you are being charged for storage, an orphaned volume
#        is the usual cause.)
#    2. Is any compute running that I forgot about (incl. stopped instances)?
#    3. How many volume backups exist? (5 free; excess is billed.)
#
#  USAGE:  bash oci-cost-audit.sh            # uses the KAMi instance's compartment
#          COMPARTMENT_OCID=ocid1... bash oci-cost-audit.sh
# ===========================================================================
ENV_FILE="${ENV_FILE:-$HOME/.kami-recovery/env}"   # OCIDs kept outside the repo
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
set -euo pipefail

INSTANCE_OCID="${INSTANCE_OCID:-}"
COMPARTMENT_OCID="${COMPARTMENT_OCID:-}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }
warn() { printf '    \033[1;33m%s\033[0m\n' "$*"; }

command -v oci >/dev/null || { echo "Run this from OCI Cloud Shell."; exit 1; }

oq() { local q="$1"; shift; oci "$@" --query "$q" --raw-output; }

# resolve compartment from the instance if not supplied
if [[ -z "$COMPARTMENT_OCID" ]]; then
  COMPARTMENT_OCID="$(oq 'data."compartment-id"' compute instance get --instance-id "$INSTANCE_OCID")"
fi
[[ -n "$COMPARTMENT_OCID" && "$COMPARTMENT_OCID" != "None" ]] || { echo "cannot resolve compartment"; exit 1; }

log "Compartment: $COMPARTMENT_OCID"

# ---------------------------------------------------------------- instances
log "Compute instances (all states)"
oci compute instance list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{"name":"display-name","state":"lifecycle-state","shape":shape,"ad":"availability-domain"}' \
  --output table 2>/dev/null || warn "instance list failed (permissions?)"

echo
log "Shape config (OCPU / memory actually allocated)"
oci compute instance list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{"name":"display-name","state":"lifecycle-state","ocpu":"shape-config.ocpus","ram-gb":"shape-config.memory-in-gbs"}' \
  --output table 2>/dev/null || warn "shape query failed"

# ------------------------------------------------------------ block storage
TOTAL_GB=0

log "Boot volumes"
mapfile -t ADS < <(oq 'data[].name' iam availability-domain list --compartment-id "$COMPARTMENT_OCID")
for ad in "${ADS[@]}"; do
  out="$(oci bv boot-volume list --compartment-id "$COMPARTMENT_OCID" --availability-domain "$ad" \
          --query 'data[].{"name":"display-name","gb":"size-in-gbs","state":"lifecycle-state","attached-to":"attached-instance-id","vpus":"vpus-per-gb"}' \
          --output table 2>/dev/null || true)"
  [[ -n "$out" ]] && { echo "  AD: $ad"; echo "$out"; }
  for gb in $(oq 'data[]."size-in-gbs"' bv boot-volume list --compartment-id "$COMPARTMENT_OCID" --availability-domain "$ad" 2>/dev/null || true); do
    TOTAL_GB=$(( TOTAL_GB + gb ))
  done
done

log "Block (data) volumes"
oci bv volume list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{"name":"display-name","gb":"size-in-gbs","state":"lifecycle-state","vpus":"vpus-per-gb"}' \
  --output table 2>/dev/null || warn "block volume list failed"
for gb in $(oq 'data[]."size-in-gbs"' bv volume list --compartment-id "$COMPARTMENT_OCID" 2>/dev/null || true); do
  TOTAL_GB=$(( TOTAL_GB + gb ))
done

log "Volume backups (5 are free; more are billed)"
oci bv backup list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{"name":"display-name","gb":"size-in-gbs","state":"lifecycle-state","type":type}' \
  --output table 2>/dev/null || true
oci bv boot-volume-backup list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{"name":"display-name","state":"lifecycle-state"}' \
  --output table 2>/dev/null || true

# ------------------------------------------------------------------ verdict
log "Storage verdict"
ok "Total allocated block storage (boot + data): ${TOTAL_GB} GB"
ok "Always Free block-storage allowance:        200 GB total"
if (( TOTAL_GB > 200 )); then
  warn "You are $((TOTAL_GB - 200)) GB OVER the free allowance — that is the storage charge."
  warn "Look for a volume attached to nothing (orphaned after an instance was terminated)."
elif (( TOTAL_GB == 200 )); then
  ok "You are exactly at the allowance. A storage charge here means something else is"
  ok "consuming part of it (another compartment/region, a backup, or a paid performance tier)."
  ok "Check the VPUs column above: 'Balanced' (10 VPU/GB) is the free-tier norm."
else
  ok "You appear to be UNDER the allowance (${TOTAL_GB}/200 GB)."
  ok "If you are still billed for storage, the cause is likely the performance tier"
  ok "(Higher Performance = 20 VPU/GB is chargeable) or a resource outside this compartment."
fi

log "Next"
cat <<EOF
    Cost Analysis (ground truth for what you were actually billed):
      ☰ → Billing & Cost Management → Cost Analysis
      → Last 30 days → Group by: Service → then Group by: Resource

    If a volume is attached to nothing and you are sure you do not need it,
    terminating it is the only part of this that costs money to get wrong —
    verify, then delete deliberately.
EOF
