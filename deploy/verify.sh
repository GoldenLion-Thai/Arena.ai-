#!/usr/bin/env bash
# =============================================================================
# GRiD-OS-SOVEREIGN — deployment verification
#
#   bash deploy/verify.sh                                     # local app tier
#   bash deploy/verify.sh --url https://llm.example.com --auth admin:pw \
#                         --expect-models --public-host 1.2.3.4
#   bash deploy/verify.sh --ssh ubuntu@1.2.3.4                # host-level checks too
#   bash deploy/verify.sh --json                              # machine-readable
#
# Proves the things that actually matter on a private-model host:
#   reachability · gateway discovery · token streaming is incremental ·
#   model port is not public · TLS and security headers · auth is enforced ·
#   services are active · resources are adequate
#
# Exit code: 0 = every check passed, 1 = at least one FAIL.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

URL="http://127.0.0.1:8080"
AUTH=""
SSH_HOST=""
PUBLIC_HOST=""
EXPECT_MODELS=0
EXPECT_TLS=0
JSON=0
TIMEOUT=25
MODEL=""
PREFIX="/gateway/"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)          URL="${2%/}"; shift 2 ;;
    --auth)         AUTH="${2:-}"; shift 2 ;;
    --ssh)          SSH_HOST="${2:-}"; shift 2 ;;
    --public-host)  PUBLIC_HOST="${2:-}"; shift 2 ;;
    --expect-models) EXPECT_MODELS=1; shift ;;
    --expect-tls)   EXPECT_TLS=1; shift ;;
    --model)        MODEL="${2:-}"; shift 2 ;;
    --prefix)       PREFIX="${2:-}"; shift 2 ;;
    --timeout)      TIMEOUT="${2:-}"; shift 2 ;;
    --json)         JSON=1; shift ;;
    -h|--help)      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
RESULTS=()
CURL=(curl -sS --max-time "$TIMEOUT")
[[ -n $AUTH ]] && CURL+=(-u "$AUTH")

record() { RESULTS+=("$1|$2|$3"); }   # status|name|detail

# escapes must be built before printf sees them, or they print literally
if [[ -t 1 && $JSON -eq 0 ]]; then
  E_OK=$'\033[32m'; E_BAD=$'\033[31m'; E_WARN=$'\033[33m'; E_ACC=$'\033[38;5;190m'
  E_DIM=$'\033[2m'; E_OFF=$'\033[0m'
else
  E_OK=""; E_BAD=""; E_WARN=""; E_ACC=""; E_DIM=""; E_OFF=""
fi
detail() { [[ -n ${1:-} ]] && printf '%s' "  ${E_DIM}${1}${E_OFF}"; }
ok()   { PASS=$((PASS+1)); record PASS "$1" "${2:-}"; [[ $JSON -eq 1 ]] || printf '  %s✓%s %s%s\n' "$E_OK" "$E_OFF" "$1" "$(detail "${2:-}")"; }
bad()  { FAIL=$((FAIL+1)); record FAIL "$1" "${2:-}"; [[ $JSON -eq 1 ]] || printf '  %s✗%s %s%s\n' "$E_BAD" "$E_OFF" "$1" "$(detail "${2:-}")"; }
meh()  { WARN=$((WARN+1)); record WARN "$1" "${2:-}"; [[ $JSON -eq 1 ]] || printf '  %s!%s %s%s\n' "$E_WARN" "$E_OFF" "$1" "$(detail "${2:-}")"; }
sect() { [[ $JSON -eq 1 ]] || printf '\n%s%s%s\n' "$E_ACC" "$*" "$E_OFF"; }

TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT

[[ $JSON -eq 1 ]] || printf '\n%sGRiD-OS-SOVEREIGN — verify%s  %s\n' "$E_ACC" "$E_OFF" "$URL"

# ------------------------------------------------------------------ 1 · reachability
sect "reachability"

CODE=$(curl -sS -o "$TMPD/root" -w '%{http_code}' --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL/" 2>"$TMPD/err" || true); CODE="${CODE:-000}"
if [[ $CODE == 200 ]]; then ok "landing page responds" "HTTP 200, $(wc -c < "$TMPD/root" | tr -d ' ') bytes"
elif [[ $CODE == 401 ]]; then meh "landing page requires credentials" "HTTP 401 — re-run with --auth user:pass"
else bad "landing page responds" "HTTP $CODE ($(head -c 120 "$TMPD/err" 2>/dev/null | tr '\n' ' '))"; fi

for page in app.html lab.html; do
  C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL/$page" 2>/dev/null || true); C="${C:-000}"
  [[ $C == 200 || $C == 401 ]] && ok "$page served" "HTTP $C" || bad "$page served" "HTTP $C"
done

for asset in assets/css/grid-os.css assets/js/brand.js assets/js/gateway.js assets/js/app.js; do
  C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL/$asset" 2>/dev/null || true); C="${C:-000}"
  [[ $C == 200 || $C == 401 ]] && ok "asset $asset" "HTTP $C" || bad "asset $asset" "HTTP $C"
done

HZ=$(curl -sS --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL/healthz" 2>/dev/null || echo "")
if printf '%s' "$HZ" | grep -q '"ok":true'; then
  ok "/healthz reports ok" "$(printf '%s' "$HZ" | head -c 140)"
else
  bad "/healthz reports ok" "${HZ:0:120}"
fi

# ------------------------------------------------------------------ 2 · gateway
sect "model gateway (${PREFIX})"

TAGS=$(curl -sS --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL${PREFIX}api/tags" 2>/dev/null || echo "")
if printf '%s' "$TAGS" | grep -q '"models"'; then
  FOUND=$(printf '%s' "$TAGS" | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | head -6 | tr '\n' ' ')
  N=$(printf '%s' "$TAGS" | grep -o '"name":"[^"]*"' | wc -l | tr -d ' ')
  ok "discovery through the same-origin proxy" "$N model(s): ${FOUND:-none}"
  if [[ $EXPECT_MODELS -eq 1 ]]; then
    [[ ${N:-0} -ge 1 ]] && ok "at least one model is available" "$N" \
      || bad "at least one model is available" "host reachable but no models pulled — run: ollama pull <model>"
  fi
  if [[ -n $MODEL ]]; then
    printf '%s' "$TAGS" | grep -q "\"$MODEL\"" && ok "requested model present" "$MODEL" \
      || bad "requested model present" "$MODEL not on the host"
  fi
  [[ -z $MODEL ]] && MODEL=$(printf '%s' "$TAGS" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
else
  C=$(curl -sS -o "$TMPD/gwerr" -w '%{http_code}' --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL${PREFIX}api/tags" 2>/dev/null || true); C="${C:-000}"
  bad "discovery through the same-origin proxy" "HTTP $C — $(head -c 160 "$TMPD/gwerr" | tr '\n' ' ')"
  meh "gateway target" "is the model host running? is OLLAMA_URL correct in the app env?"
fi

# ------------------------------------------------------------------ 3 · streaming
sect "token streaming"

if [[ -n $MODEL ]]; then
  BODY="$TMPD/stream.ndjson"
  PAYLOAD="{\"model\":\"$MODEL\",\"stream\":true,\"options\":{},\"messages\":[{\"role\":\"user\",\"content\":\"Count to five.\"}]}"
  T=$(curl -N -sS -o "$BODY" -w '%{http_code} %{time_starttransfer} %{time_total}' \
        --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} \
        -X POST "$URL${PREFIX}api/chat" -H 'Content-Type: application/json' -d "$PAYLOAD" 2>/dev/null || echo "000 0 0")
  SCODE=$(awk '{print $1}' <<<"$T"); TTFB=$(awk '{print $2}' <<<"$T"); TOTAL=$(awk '{print $3}' <<<"$T")
  CHUNKS=$(grep -c '^{' "$BODY" 2>/dev/null || echo 0)

  if [[ $SCODE == 200 ]]; then
    ok "chat completion accepted" "HTTP 200 via $MODEL"
    awk -v t="$TTFB" 'BEGIN{exit !(t+0 < 3.0)}' && ok "time to first token" "${TTFB}s (budget: < 3s incl. cold load)" \
      || meh "time to first token" "${TTFB}s — cold model load or CPU inference; warm it with keep-alive"
    [[ ${CHUNKS:-0} -ge 2 ]] && ok "response arrives in multiple chunks" "$CHUNKS ndjson frames" \
      || bad "response arrives in multiple chunks" "$CHUNKS frame(s) — the proxy is buffering; check proxy_buffering off"
    awk -v a="$TTFB" -v b="$TOTAL" 'BEGIN{exit !(b+0 > a+0)}' && ok "streaming is incremental, not one shot" "ttfb ${TTFB}s < total ${TOTAL}s" \
      || bad "streaming is incremental, not one shot" "whole body arrived at once (ttfb ${TTFB}s, total ${TOTAL}s)"
    grep -q '"done":true' "$BODY" 2>/dev/null && ok "stream terminates cleanly" '"done":true' || meh "stream terminates cleanly" 'no done frame — generation may have been cut off'
    EVAL=$(grep -o '"eval_count":[0-9]*' "$BODY" 2>/dev/null | tail -1 | cut -d: -f2)
    [[ -n ${EVAL:-} ]] && ok "runtime token accounting present" "eval_count=$EVAL (the UI uses this, not estimates)" \
      || meh "runtime token accounting present" "no eval_count — the UI will fall back to estimates"
  else
    bad "chat completion accepted" "HTTP $SCODE ($MODEL)"
  fi
else
  meh "streaming not tested" "no model name discovered — pass --model"
fi

# ------------------------------------------------------------------ 4 · transport security
sect "transport security"

HOSTPART="${URL#*://}"; HOSTPART="${HOSTPART%%/*}"; HOSTONLY="${HOSTPART%%:*}"
IS_HTTPS=0; [[ $URL == https://* ]] && IS_HTTPS=1

if [[ $IS_HTTPS -eq 1 || $EXPECT_TLS -eq 1 ]]; then
  if [[ $IS_HTTPS -eq 0 ]]; then bad "TLS expected" "URL is not https:// (pass --url https://…)"; fi
  H=$(curl -sSI --max-time "$TIMEOUT" ${AUTH:+-u "$AUTH"} "$URL/" 2>/dev/null || echo "")
  printf '%s' "$H" | grep -qi '^strict-transport-security:' && ok "HSTS header" "$(printf '%s' "$H" | grep -i '^strict-transport-security:' | tr -d '\r' | head -c 90)" \
    || meh "HSTS header" "absent — add it once TLS is stable"
  printf '%s' "$H" | grep -qi '^x-content-type-options: *nosniff' && ok "X-Content-Type-Options" "nosniff" || meh "X-Content-Type-Options" "absent"
  printf '%s' "$H" | grep -qi '^content-security-policy:' && ok "Content-Security-Policy present" "$(printf '%s' "$H" | grep -i '^content-security-policy:' | wc -c | tr -d ' ') bytes" || meh "Content-Security-Policy present" "absent"
  if command -v openssl >/dev/null 2>&1; then
    PORTPART="${HOSTPART##*:}"; [[ "$PORTPART" == "$HOSTPART" ]] && PORTPART=443
    ENDDATE=$(echo | openssl s_client -servername "$HOSTONLY" -connect "${HOSTONLY}:${PORTPART}" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    ISSUER=$(echo | openssl s_client -servername "$HOSTONLY" -connect "${HOSTONLY}:${PORTPART}" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null | sed 's/.*O *= *//;s/,.*//')
    if [[ -n $ENDDATE ]]; then
      DAYS=$(( ( $(date -d "$ENDDATE" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
      [[ $DAYS -gt 7 ]] && ok "certificate validity" "${DAYS}d left (issuer: ${ISSUER:-unknown})" \
        || bad "certificate validity" "expires in ${DAYS}d (issuer: ${ISSUER:-unknown})"
      printf '%s' "$ISSUER" | grep -qi "let's encrypt\|letsencrypt" && ok "certificate is publicly trusted" "$ISSUER" \
        || meh "certificate is publicly trusted" "issuer: ${ISSUER:-unknown} (self-signed?)"
    else
      meh "certificate inspection" "openssl could not read the certificate"
    fi
  else
    meh "certificate inspection" "openssl not installed"
  fi
  PLAIN=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "http://${HOSTONLY}/" 2>/dev/null || true); PLAIN="${PLAIN:-000}"
  [[ $PLAIN == 301 || $PLAIN == 308 ]] && ok "plain HTTP redirects to HTTPS" "HTTP $PLAIN" || meh "plain HTTP redirects to HTTPS" "HTTP $PLAIN"
else
  meh "TLS not checked" "URL is http:// — fine for localhost, not for a public host"
fi

# ------------------------------------------------------------------ 5 · authentication
sect "authentication"

if [[ -n $AUTH ]]; then
  NAKE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL/" 2>/dev/null || true); NAKE="${NAKE:-000}"
  [[ $NAKE == 401 || $NAKE == 403 ]] && ok "unauthenticated requests are refused" "HTTP $NAKE without credentials" \
    || bad "unauthenticated requests are refused" "HTTP $NAKE — auth is configured but not enforced"
  AUTHED=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" -u "$AUTH" "$URL/" 2>/dev/null || true); AUTHED="${AUTHED:-000}"
  [[ $AUTHED == 200 ]] && ok "credentials are accepted" "HTTP 200 for ${AUTH%%:*}" || bad "credentials are accepted" "HTTP $AUTHED"
  NAKED_GW=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL${PREFIX}api/tags" 2>/dev/null || true); NAKED_GW="${NAKED_GW:-000}"
  [[ $NAKED_GW == 401 || $NAKED_GW == 403 ]] && ok "the model gateway is behind auth too" "HTTP $NAKED_GW" \
    || bad "the model gateway is behind auth too" "HTTP $NAKED_GW — inference is reachable without credentials"
else
  C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL/" 2>/dev/null || true); C="${C:-000}"
  if [[ $C == 401 || $C == 403 ]]; then
    meh "site is credential-gated" "HTTP $C — pass --auth user:pass to verify it"
  else
    [[ $URL == http://127.* || $URL == http://localhost* ]] \
      && meh "no authentication" "acceptable on loopback; required before this is reachable by anyone else" \
      || bad "no authentication" "a public host is serving an unauthenticated private-model UI"
  fi
fi

# ------------------------------------------------------------------ 6 · exposure
sect "network exposure"

PROBE_HOST="${PUBLIC_HOST:-$HOSTONLY}"
case "$PROBE_HOST" in 127.*|localhost|::1|"")
  meh "public port exposure not tested" "target is loopback — pass --public-host <ip> to test from outside"
  ;;
  *)
  for P in 11434 8080; do
    if timeout 6 bash -c "exec 3<>/dev/tcp/${PROBE_HOST}/${P}" 2>/dev/null; then
      bad "port ${P} is not reachable from outside" "OPEN — the model host or app tier is public. Close it (NSG/ufw) now."
      exec 3<&- 2>/dev/null || true
    else
      ok "port ${P} is not reachable from outside" "closed/filtered on ${PROBE_HOST}"
    fi
  done
  for P in 443 22; do
    if timeout 6 bash -c "exec 3<>/dev/tcp/${PROBE_HOST}/${P}" 2>/dev/null; then
      ok "port ${P} is reachable" "expected for ${P}"
      exec 3<&- 2>/dev/null || true
    else
      [[ $P == 443 ]] && meh "port 443 reachable" "closed — TLS site may not be live yet" || meh "port 22 reachable" "closed (good if you use a bastion)"
    fi
  done
  ;;
esac

# ------------------------------------------------------------------ 7 · host (ssh)
if [[ -n $SSH_HOST ]]; then
  sect "host state (ssh ${SSH_HOST})"
  rsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "$@" 2>/dev/null; }
  for svc in grid-os-sovereign ollama nginx; do
    ST=$(rsh "systemctl is-active $svc" || echo "unknown")
    [[ $ST == active ]] && ok "service $svc" "active" || bad "service $svc" "$ST"
  done
  BIND=$(rsh "ss -ltnH 'sport = :11434'" || true)
  if [[ -n $BIND ]]; then
    printf '%s' "$BIND" | grep -q '127.0.0.1\|\[::1\]' && ok "ollama is bound to loopback" "$(printf '%s' "$BIND" | awk '{print $4}' | head -1)" \
      || bad "ollama is bound to loopback" "$(printf '%s' "$BIND" | awk '{print $4}' | head -1) — set OLLAMA_HOST=127.0.0.1:11434"
  else
    meh "ollama bind address" "nothing listening on 11434 (model host down?)"
  fi
  PERM=$(rsh "stat -c '%a' /etc/grid-os-sovereign.env" || echo "")
  [[ $PERM == 640 || $PERM == 600 ]] && ok "app env file permissions" "$PERM" || meh "app env file permissions" "${PERM:-missing}"
  DISK=$(rsh "df -BG --output=avail /var/lib/ollama 2>/dev/null | tail -1 | tr -dc '0-9'" || echo "")
  [[ -n $DISK ]] && { [[ $DISK -ge 20 ]] && ok "disk for model weights" "${DISK}GB free" || meh "disk for model weights" "${DISK}GB free — a 14B q4 model needs ~10GB"; }
  RAM=$(rsh "awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo" || echo "")
  [[ -n $RAM ]] && { [[ $RAM -ge 8000 ]] && ok "host memory" "${RAM}MB" || meh "host memory" "${RAM}MB — stick to ≤7B quantised models"; }
  NODEV=$(rsh "node -v" || echo "missing")
  [[ $NODEV != missing ]] && ok "node runtime" "$NODEV" || bad "node runtime" "not installed"
  GPUQ=$(rsh "nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null | head -1" || true)
  [[ -n $GPUQ ]] && ok "GPU visible to the host" "$GPUQ" || meh "GPU visible to the host" "none — CPU inference"
fi

# ------------------------------------------------------------------ summary
if [[ $JSON -eq 1 ]]; then
  printf '{\n  "url": "%s",\n  "pass": %d,\n  "fail": %d,\n  "warn": %d,\n  "checks": [\n' "$URL" "$PASS" "$FAIL" "$WARN"
  first=1
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r st nm dt <<<"$r"
    [[ $first -eq 0 ]] && printf ',\n'
    first=0
    printf '    {"status":"%s","name":"%s","detail":"%s"}' "$st" "$nm" "$(printf '%s' "$dt" | tr -d '"' | tr '\n' ' ')"
  done
  printf '\n  ]\n}\n'
else
  printf '\n────────────────────────────────────────────\n'
  printf '  %s%d passed%s · %s%d failed%s · %s%d warnings%s\n' "$E_OK" "$PASS" "$E_OFF" "$E_BAD" "$FAIL" "$E_OFF" "$E_WARN" "$WARN" "$E_OFF"
  [[ $FAIL -eq 0 ]] && printf '  host verified: %s\n' "${URL}" || printf '  %sfix the failures above before pointing real work at this host%s\n' "$E_BAD" "$E_OFF"
  printf '────────────────────────────────────────────\n\n'
fi

[[ $FAIL -eq 0 ]]
