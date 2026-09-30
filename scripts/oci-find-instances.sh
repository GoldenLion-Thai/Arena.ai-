#!/usr/bin/env bash
# Find every compute instance in an OCI tenancy — across ALL subscribed regions
# and ALL compartments.
#
# Why this exists: the OCI console shows one region and one compartment at a time.
# An Always Free instance created months ago in another region is invisible there,
# which is exactly how servers go missing from an inventory.
#
# Read-only. Lists and reports; changes nothing.
#
# Run from OCI Cloud Shell (the oci CLI is pre-authenticated there).
#   bash oci-find-instances.sh
#   TENANCY_OCID=ocid1.tenancy.oc1..aaaa... bash oci-find-instances.sh
#   INCLUDE_VOLUMES=1 bash oci-find-instances.sh   # also sweep boot volumes

set -uo pipefail

TENANCY="${TENANCY_OCID:-${OCI_TENANCY_ID:-}}"
INCLUDE_VOLUMES="${INCLUDE_VOLUMES:-0}"

if [ -z "$TENANCY" ] && [ -f "$HOME/.kami-recovery/env" ]; then
  TENANCY="$(sed -n 's/^TENANCY_OCID=//p' "$HOME/.kami-recovery/env" 2>/dev/null | tail -1)"
fi
if [ -z "$TENANCY" ]; then
  TENANCY="$(oci iam tenancy get --query 'data.id' --raw-output 2>/dev/null || true)"
fi
[ -n "$TENANCY" ] || { echo "Could not determine the tenancy OCID."; echo "Set it with: TENANCY_OCID=ocid1.tenancy.oc1..aaaa... bash $0"; exit 1; }
command -v oci >/dev/null 2>&1 || { echo "The oci CLI is not available. Run this in OCI Cloud Shell."; exit 1; }

printf 'Sweeping tenancy %s…\n' "${TENANCY:0:28}"
printf 'This lists only. Nothing is changed.\n\n'

# ------------------------------------------------------------------ regions
mapfile -t REGIONS < <(oci iam region-subscription list \
  --query 'data[]."region-name"' --raw-output 2>/dev/null | sort)
[ "${#REGIONS[@]}" -gt 0 ] || { echo "Could not list subscribed regions."; exit 1; }
printf 'Subscribed regions (%s): %s\n\n' "${#REGIONS[@]}" "${REGIONS[*]}"

# ------------------------------------------------------------- compartments
# The tenancy root itself, then every ACTIVE compartment beneath it.
# Explicit list projection, so field order is guaranteed rather than dependent
# on how JMESPath happens to serialise a hash.
mapfile -t COMPARTMENTS < <(
  printf '%s|%s\n' "$TENANCY" "(root)"
  oci iam compartment list --compartment-id "$TENANCY" --all \
    --query 'data[?"lifecycle-state"==`ACTIVE`].[id,name]' --raw-output 2>/dev/null \
    | awk 'NF>=2 && $1 != "'"$TENANCY"'" {print $1 "|" $2}'
)
printf 'Compartments to search: %s\n\n' "${#COMPARTMENTS[@]}"

sep() { printf -- '--------------------------------------------------------------------------------\n'; }

printf 'Instances found:\n'
sep
printf '%-16s %-11s %-22s %-16s %-24s %-18s %s\n' \
  "REGION" "STATE" "SHAPE" "PUBLIC IP" "NAME" "AD" "CREATED"
sep

FOUND=0
declare -A SEEN
for region in "${REGIONS[@]}"; do
  for entry in "${COMPARTMENTS[@]}"; do
    comp="${entry%%|*}"
    compname="${entry##*|}"
    rows="$(oci compute instance list --region "$region" --compartment-id "$comp" --all \
      --query 'data[].["display-name","lifecycle-state",shape,id,"availability-domain","time-created"]' \
      --raw-output 2>/dev/null)" || continue
    [ -z "$rows" ] && continue
    while read -r name state shape id ad created; do
      [ -n "${id:-}" ] || continue
      [ "${SEEN[$id]:-0}" = "1" ] && continue
      SEEN[$id]=1
      FOUND=$((FOUND+1))
      ip="-"
      if [ "$state" != "TERMINATED" ]; then
        v="$(oci compute instance list-vnics --region "$region" --instance-id "$id" \
          --query 'data[0]."public-ip"' --raw-output 2>/dev/null)"
        case "$v" in ""|None|null) ip="-" ;; *) ip="$v" ;; esac
      fi
      printf '%-16s %-11s %-22s %-16s %-24s %-18s %s\n' \
        "$region" "$state" "$shape" "$ip" "$name" "${ad##*:}" "${created%%T*}"
    done <<< "$rows"
  done
done
[ "$FOUND" -eq 0 ] && printf '(none found)\n'
sep
printf 'Total instances: %s\n\n' "$FOUND"

# ------------------------------------------------------------- boot volumes
if [ "$INCLUDE_VOLUMES" = "1" ]; then
  printf 'Boot volumes:\n'
  sep
  printf '%-16s %-9s %-11s %s\n' "REGION" "SIZE GB" "STATE" "NAME"
  sep
  VTOTAL=0
  declare -A VSEEN
  for region in "${REGIONS[@]}"; do
    for entry in "${COMPARTMENTS[@]}"; do
      comp="${entry%%|*}"
      rows="$(oci bv boot-volume list --region "$region" --compartment-id "$comp" --all \
        --query 'data[].["display-name","size-in-gbs","lifecycle-state",id]' \
        --raw-output 2>/dev/null)" || continue
      [ -z "$rows" ] && continue
      # field order follows the query: name size state id
      while read -r n g s id; do
        [ -n "${id:-}" ] || continue
        [ "${VSEEN[$id]:-0}" = "1" ] && continue
        VSEEN[$id]=1
        case "$g" in ''|*[!0-9]*) g=0 ;; esac
        VTOTAL=$((VTOTAL + g))
        printf '%-16s %-9s %-11s %s\n' "$region" "$g" "$s" "$n"
      done <<< "$rows"
    done
  done
  sep
  printf 'Total allocated boot volume storage: %s GB\n' "$VTOTAL"
  if [ "$VTOTAL" -gt 200 ]; then
    printf '⚠️  That is %s GB ABOVE the 200 GB Always Free allowance - this is what the\n' "$((VTOTAL-200))"
    printf '    monthly storage charge is. Unattached volumes are the usual cause.\n\n'
  else
    printf 'Within the 200 GB Always Free allowance.\n\n'
  fi
fi

cat <<'NOTE'
Notes
  - Lifecycle states: RUNNING, STOPPED, TERMINATED. A STOPPED instance still
    holds its boot volume and still counts against storage.
  - A "-" for public IP means STOPPED, or no public IP assigned, or reachable
    only on its private IP. Start the instance to get an IP.
  - Always Free shapes: VM.Standard.E2.1.Micro (up to 2 per tenancy) and
    VM.Standard.A1.Flex (4 OCPU / 24 GB total).
  - If a host you expect is not listed here, it is in a DIFFERENT OCI tenancy
    and you will need to sign in with that account's credentials.
  - Storage is billed per tenancy across all regions, not per region.
NOTE
