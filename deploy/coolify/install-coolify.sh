#!/usr/bin/env bash
# ============================================================================
# deploy/coolify/install-coolify.sh — put Coolify on a VPS (Kami-VPS), then
# deploy this repository from it.
#
# Coolify is Apache-2.0 open source and free forever on your own hardware. This
# script does not reimplement it and does not fork it: it pre-flights the host,
# fetches the OFFICIAL installer, shows you what it fetched, and runs it
# unattended. Then it prints the URL to open from your laptop and the exact
# clicks to deploy the stack.
#
#   sudo bash deploy/coolify/install-coolify.sh --dry-run        # rehearse
#   sudo bash deploy/coolify/install-coolify.sh \
#        --email you@example.com --username kami                # install
#   sudo bash deploy/coolify/install-coolify.sh --upgrade        # force upgrade
#   sudo bash deploy/coolify/install-coolify.sh --check-only     # host checks
#
# Verified against coollabsio/coolify v4.4.2 (scripts/install.sh,
# scripts/upgrade.sh). Flags used here:
#   ROOT_USERNAME / ROOT_USER_EMAIL / ROOT_USER_PASSWORD  pre-create the admin
#   AUTOUPDATE=false                                      disable auto-updates
#   REGISTRY_URL=<registry>                               private image registry
# Exit codes: 0 ok · 1 host/config problem · 2 user aborted · 3 network blocked
# ============================================================================
set -euo pipefail

CDN="https://cdn.coollabs.io/coolify"
INSTALLER="$CDN/install.sh"
UPGRADE_SH="$CDN/upgrade.sh"
VERSIONS_JSON="$CDN/versions.json"
COOLIFY_SOURCE="/data/coolify/source"
COOLIFY_UI_PORT=8000 # the installer prints http://<ip>:8000 at the end
MIN_RAM_MB=2048 # Coolify's own minimum; our stack needs far more
MIN_DISK_GB=20 # models are large; the platform ceiling is 20 GB live
MIN_DISK_WARN_GB=60 # 50 GB per node is the provisioning figure

EMAIL="${ROOT_USER_EMAIL:-}"
USERNAME="${ROOT_USERNAME:-}"
PASSWORD_FILE=""
REGISTRY=""
MODE="install"
DRY_RUN=0
ASSUME_YES=0
NO_AUTOUPDATE=0

say() { printf '%s\n' "$*" >&2; }
head1() { say ""; say "== $*"; }
ok() { say "  [ok]   $*"; }
warn() { say "  [warn] $*"; }
bad() { say "  [fail] $*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry]  $*"
  else
    say "  [run]  $*"
    eval "$@"
  fi
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help | -h) usage ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --upgrade) MODE="upgrade"; shift ;;
    --check-only) MODE="check"; shift ;;
    --no-autoupdate) NO_AUTOUPDATE=1; shift ;;
    --email) EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --username) USERNAME="${2:?--username needs a value}"; shift 2 ;;
    --password-file) PASSWORD_FILE="${2:?--password-file needs a path}"; shift 2 ;;
    --registry) REGISTRY="${2:?--registry needs a URL}"; shift 2 ;;
    *) bad "unknown argument: $1"; say "  try --help"; exit 1 ;;
  esac
done

FAILURES=0

# ---------------------------------------------------------------- pre-flight
head1 "1/5  Host checks"

if [ "$(id -u)" != "0" ]; then
  if [ "$DRY_RUN" = 1 ] || [ "$MODE" = "check" ]; then
    warn "not root. A dry run / check-only rehearsal is allowed without it, but"
    warn "the real install will refuse: the official installer exits if EUID != 0."
  else
    bad "must run as root (the official installer exits if EUID != 0)."
    bad "Use: sudo bash $0 $*"
    exit 1
  fi
else
  ok "running as root"
fi

OS_ID="$( (. /etc/os-release 2>/dev/null && echo "${ID:-unknown}") || echo unknown)"
case "$OS_ID" in
  debian | ubuntu | centos | rhel | rocky | almalinux | fedora | alpine | opensuse* | sles)
    ok "OS '$OS_ID' is one the official installer handles" ;;
  *) warn "OS '$OS_ID' is not one the installer explicitly handles — it may still work (it installs Docker via get.docker.com)" ;;
esac

if command -v curl >/dev/null 2>&1; then
  ok "curl present: $(curl --version 2>/dev/null | head -n1 | cut -d' ' -f1-2)"
else
  bad "curl is required. Install it first: apt-get install -y curl (or dnf/apk equivalent)."
  FAILURES=$((FAILURES + 1))
fi

RAM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$RAM_MB" -ge "$MIN_RAM_MB" ]; then
  ok "RAM ${RAM_MB} MB (Coolify minimum ${MIN_RAM_MB} MB)"
else
  bad "RAM ${RAM_MB} MB is below Coolify's ${MIN_RAM_MB} MB minimum"
  FAILURES=$((FAILURES + 1))
fi
if [ "$RAM_MB" -lt 16384 ]; then
  warn "this host has ${RAM_MB} MB. Coolify will run, but GRiD-OS + Ollama want a"
  warn "16 GB+ node for a 7B Q4 model, and the platform's capacity plan assumes"
  warn "22 GB for HNSW + heap at the 20 GB live ceiling. See handover/VPS-COOLIFY.md."
fi

DISK_GB="$(df -BG --output=avail / 2>/dev/null | tail -n1 | tr -dc '0-9' || echo 0)"
if [ "${DISK_GB:-0}" -ge "$MIN_DISK_GB" ]; then
  ok "free disk on / : ${DISK_GB} GB"
else
  bad "free disk on / is ${DISK_GB:-unknown} GB — need at least ${MIN_DISK_GB} GB"
  FAILURES=$((FAILURES + 1))
fi
if [ "${DISK_GB:-0}" -lt "$MIN_DISK_WARN_GB" ]; then
  warn "under ${MIN_DISK_WARN_GB} GB free: enough for Coolify, tight for model"
  warn "weights plus a 50 GB-per-node data volume."
fi

PORT_CHECKER=""
command -v ss >/dev/null 2>&1 && PORT_CHECKER="ss -ltn"
[ -z "$PORT_CHECKER" ] && command -v netstat >/dev/null 2>&1 && PORT_CHECKER="netstat -ltn"
if [ -n "$PORT_CHECKER" ]; then
  BUSY=""
  for p in 80 443 "$COOLIFY_UI_PORT"; do
    if $PORT_CHECKER 2>/dev/null | grep -qE "[:.]$p\b"; then BUSY="$BUSY $p"; fi
  done
  if [ -z "$BUSY" ]; then
    ok "ports 80, 443 and $COOLIFY_UI_PORT are free (Coolify's proxy needs 80/443)"
  else
    warn "already listening on:$BUSY — Coolify's proxy wants 80/443. Stop the"
    warn "existing web server or Coolify's Traefik will fail to bind."
  fi
else
  warn "neither ss nor netstat found; could not check ports 80/443/$COOLIFY_UI_PORT"
fi

if command -v docker >/dev/null 2>&1; then
  ok "Docker present: $(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',')"
else
  ok "Docker absent — the official installer will install it (curl get.docker.com)"
fi

# ------------------------------------------------------------ reachability
head1 "2/5  Network reachability (this is what usually fails)"

HTTP_CODE="$(curl -sS -o /tmp/coolify-versions.json -w '%{http_code}' --max-time 15 -L "$VERSIONS_JSON" 2>/dev/null || true)"
HTTP_CODE="${HTTP_CODE: -3}"
[ -z "$HTTP_CODE" ] && HTTP_CODE="000"
if [ "$HTTP_CODE" = "200" ]; then
  V4="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/tmp/coolify-versions.json','utf8')).coolify.v4.version||'unknown')}catch(e){console.log('unknown')}" 2>/dev/null || grep -o '"version"[^,]*' /tmp/coolify-versions.json | head -n1 || echo unknown)"
  ok "$CDN reachable (HTTP 200). Latest Coolify v4: $V4"
  if [ "$MODE" != "check" ]; then
    say "  versions.json kept at /tmp/coolify-versions.json"
  fi
else
  bad "cannot reach $CDN (HTTP $HTTP_CODE). Coolify cannot be installed offline."
  bad "Check outbound 443 from this host, then retry. If this sandbox/agent is"
  bad "running the script, note that it may not have internet egress — run it on"
  bad "the VPS itself over SSH."
  exit 3
fi

if [ "$FAILURES" -ne 0 ]; then
  head1 "Host checks failed"
  bad "$FAILURES check(s) failed. Fix them and re-run; nothing was changed."
  exit 1
fi
ok "all host checks passed"

if [ "$MODE" = "check" ]; then
  head1 "--check-only: stopping here. Nothing was installed or changed."
  exit 0
fi

# ------------------------------------------------------------ confirmation
head1 "3/5  What will happen"
say "  • Download the official Coolify installer from $INSTALLER"
say "  • Show its size, sha256 and first line (so you can see what you run)"
say "  • Run it as root; it installs Docker, Traefik, Postgres, Redis and Coolify"
say "  • Coolify's UI will be at http://<this-host-ip>:$COOLIFY_UI_PORT"
if [ "$MODE" = "upgrade" ]; then
  say "  MODE: upgrade — runs Coolify's own upgrade.sh to the latest image"
fi
if [ "$DRY_RUN" = 1 ]; then say "  MODE: dry run — nothing is executed"; fi
say ""
say "  After that you deploy this repository in the UI (handover/VPS-COOLIFY.md):"
say "    Project → New Resource → Docker Compose → private GitHub repo"
say "    Compose location: deploy/coolify/docker-compose.yml"
say ""

if [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
  printf 'Continue? [y/N] ' >&2
  read -r REPLY </dev/tty || REPLY=""
  case "$REPLY" in
    y | Y | yes | YES) ;;
    *) say "Aborted."; exit 2 ;;
  esac
fi

# ------------------------------------------------------------- install/upgrade
head1 "4/5  $MODE"

if [ "$MODE" = "upgrade" ]; then
  if [ -f "$COOLIFY_SOURCE/upgrade.sh" ]; then
    ok "using the installed upgrader: $COOLIFY_SOURCE/upgrade.sh"
    UPGRADE_TARGET="$COOLIFY_SOURCE/upgrade.sh"
  else
    warn "$COOLIFY_SOURCE/upgrade.sh not found — downloading $UPGRADE_SH"
    run "curl -fsSL --max-time 30 -o /tmp/coolify-upgrade.sh '$UPGRADE_SH'"
    UPGRADE_TARGET="/tmp/coolify-upgrade.sh"
  fi
  # args: image tag, helper version, registry, skip-backup
  run "bash '$UPGRADE_TARGET' latest latest '${REGISTRY:-docker.io}' false"
  ok "upgrade command issued. Coolify logs to $COOLIFY_SOURCE/upgrade-*.log"
else
  TMP_INSTALLER="$(mktemp /tmp/coolify-install.XXXXXX.sh)"
  run "curl -fsSL --max-time 60 -o '$TMP_INSTALLER' '$INSTALLER'"
  if [ "$DRY_RUN" != 1 ]; then
    LINES="$(wc -l <"$TMP_INSTALLER")"
    FIRST="$(head -n1 "$TMP_INSTALLER")"
    SUM="$(sha256sum "$TMP_INSTALLER" | cut -d' ' -f1)"
    say "  fetched $LINES lines · sha256 $SUM"
    say "  first line: $FIRST"
    case "$FIRST" in
      '#!'*) ;;
      *) bad "downloaded installer does not start with a shebang — refusing to run it."; exit 1 ;;
    esac
  fi

  ENV_PREFIX=""
  if [ -n "$EMAIL" ]; then ENV_PREFIX="$ENV_PREFIX ROOT_USER_EMAIL='$EMAIL'"; fi
  if [ -n "$USERNAME" ]; then ENV_PREFIX="$ENV_PREFIX ROOT_USERNAME='$USERNAME'"; fi
  if [ -n "$REGISTRY" ]; then ENV_PREFIX="$ENV_PREFIX REGISTRY_URL='$REGISTRY'"; fi
  if [ "$NO_AUTOUPDATE" = 1 ]; then ENV_PREFIX="$ENV_PREFIX AUTOUPDATE=false"; fi
  if [ -n "$PASSWORD_FILE" ]; then
    if [ -f "$PASSWORD_FILE" ]; then
      # Read the password from a file, never from argv: argv lands in shell
      # history and in /proc/<pid>/cmdline where other users can read it.
      ENV_PREFIX="$ENV_PREFIX ROOT_USER_PASSWORD=\"\$(cat '$PASSWORD_FILE')\""
      ok "admin password will be read from $PASSWORD_FILE (chmod 600 recommended)"
    else
      bad "--password-file '$PASSWORD_FILE' does not exist"
      exit 1
    fi
  else
    warn "no --password-file given. Coolify will ask for admin details in its UI"
    warn "on first login, or prompt during install. That is fine — this script"
    warn "never asks for a password on the command line, because argv is visible"
    warn "to other users on the host."
  fi

  # The official script disables its spinner UI when stdout is not a tty, so
  # redirecting the log still works unattended (CI, cloud-init, SSH -T).
  run "env $ENV_PREFIX bash '$TMP_INSTALLER'"
fi

# ------------------------------------------------------------------- report
head1 "5/5  Where to point your laptop"

IPV4="$(curl -sS --max-time 8 https://api.ipify.org 2>/dev/null || echo '')"
if [ -z "$IPV4" ]; then
  IPV4="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<this-host-ip>')"
fi
say "  Coolify UI    http://$IPV4:$COOLIFY_UI_PORT"
say "  (after you set a domain in Coolify, the UI is also at https://<that-domain>)"
say ""
say "  Next, in the Coolify UI:"
say "   1. Servers → this server is already connected by the installer."
say "   2. Projects → New Project (e.g. 'kinetic')."
say "   3. New Resource → Docker Compose → connect the GitHub repo"
say "      GoldenLion-Thai/Arena.ai- on branch arena/01a0a1c1-arena-ai."
say "   4. Compose location: deploy/coolify/docker-compose.yml"
say "   5. Environment variables: BASIC_AUTH_USER, BASIC_AUTH_PASS, EMBED_MODEL,"
say "      CHAT_MODEL, POSTGRES_PASSWORD (only if the pgvector profile is on)."
say "   6. Deploy. Then open the URL Coolify generated for the grid-os service"
say "      (SERVICE_URL_GRID_8080) from your laptop, or replace it with your own"
say "      domain under Resource → Domains and point an A record at $IPV4."
say ""
say "  Verify from the laptop (see handover/ACCEPTANCE.md):"
say "    curl -s https://<your-domain>/healthz"
say "    curl -s https://<your-domain>/platform/healthz   # proxied, same origin"
say ""
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run complete — nothing above was executed."
else
  ok "done"
fi
