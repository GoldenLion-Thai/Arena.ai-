#!/usr/bin/env bash
# ===========================================================================
#  KAMi-VPS-1 — create a monthly cost budget + alert rules (OCI Cloud Shell)
#
#  Alert-only. It does NOT stop, resize or terminate anything.
#  An OCI Budget cannot stop an instance on its own, and you should not want
#  it to: stopping the VM would not remove boot-volume charges anyway.
#
#  USAGE
#    bash oci-setup-billing-guard.sh             # alerts go to the default address below
#    AMOUNT=15 bash oci-setup-billing-guard.sh   # different monthly budget
#    ALERT_EMAIL=other@example.com bash oci-setup-billing-guard.sh
# ===========================================================================
ENV_FILE="${ENV_FILE:-$HOME/.kami-recovery/env}"   # OCIDs kept outside the repo
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
set -euo pipefail

INSTANCE_OCID="${INSTANCE_OCID:-}"
BUDGET_NAME="${BUDGET_NAME:-KAMi-VPS-1-Monthly-Cost-Guard}"
AMOUNT="${AMOUNT:-12}"                 # monthly budget in account currency
ALERT_EMAIL="${ALERT_EMAIL:-kamonwansingtothong@gmail.com}"
THRESHOLDS="${THRESHOLDS:-50 80 100}"  # percent of budget

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }

command -v oci >/dev/null || { echo "Run this from OCI Cloud Shell."; exit 1; }
[[ "$ALERT_EMAIL" == *@* ]] || { echo "ALERT_EMAIL does not look like an address: $ALERT_EMAIL"; exit 1; }

oq() { local q="$1"; shift; oci "$@" --query "$q" --raw-output; }

COMPARTMENT_OCID="${COMPARTMENT_OCID:-$(oq 'data."compartment-id"' compute instance get --instance-id "$INSTANCE_OCID")}"
[[ -n "$COMPARTMENT_OCID" && "$COMPARTMENT_OCID" != "None" ]] || { echo "cannot resolve compartment"; exit 1; }

log "Creating budget '$BUDGET_NAME' (${AMOUNT}/month) on compartment $COMPARTMENT_OCID"

BUDGET_ID="$(oq 'data.id' budgets budget create \
  --compartment-id "$COMPARTMENT_OCID" \
  --amount "$AMOUNT" \
  --reset-period MONTHLY \
  --display-name "$BUDGET_NAME" \
  --description "Alert-only monthly guard for KAMi-VPS-1. Does not stop or alter resources." \
  --target-type COMPARTMENT \
  --targets "[\"$COMPARTMENT_OCID\"]")"
ok "budget created: $BUDGET_ID"

for t in $THRESHOLDS; do
  rule="$(oq 'data.id' budgets alert-rule create \
    --budget-id "$BUDGET_ID" \
    --type ACTUAL \
    --threshold "$t" \
    --threshold-type PERCENTAGE \
    --display-name "${BUDGET_NAME}-actual-${t}pct" \
    --recipients "$ALERT_EMAIL")"
  ok "actual-spend alert at ${t}% → $rule"
done

rule="$(oq 'data.id' budgets alert-rule create \
  --budget-id "$BUDGET_ID" \
  --type FORECAST \
  --threshold 100 \
  --threshold-type PERCENTAGE \
  --display-name "${BUDGET_NAME}-forecast-100pct" \
  --recipients "$ALERT_EMAIL")"
ok "forecast alert at 100% → $rule"

log "Verify"
oci budgets budget list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{"name":"display-name","amount":amount,"spent":"actual-spend","forecast":"forecasted-spend","period":"reset-period"}' \
  --output table 2>/dev/null || true

cat <<EOF

    Alerts go to: $ALERT_EMAIL
    Review monthly: ☰ → Billing & Cost Management → Cost Analysis
                    → Last 30 days → Group by: Service → Group by: Resource

    Reminder: this is alert-only by design. Do not wire automatic shutdown to a
    budget — stopping the VM does not stop boot-volume charges, and it would
    interrupt the recovery.
EOF
