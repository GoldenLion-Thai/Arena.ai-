#!/usr/bin/env bash
# =============================================================================
# GRiD-OS-SOVEREIGN — local quickstart (the fastest method)
#
#   bash deploy/local.sh                          # real Ollama, small model
#   bash deploy/local.sh --model qwen2.5:14b-instruct-q4_K_M
#   bash deploy/local.sh --mock                   # no Ollama, no download: demo host
#
# One command: makes sure node and Ollama exist, starts the model host, pulls a
# model, launches the app on http://localhost:8080 and opens your browser.
# Ctrl-C stops everything it started and leaves what was already running alone.
#
# macOS · Linux · WSL2. Nothing is uploaded anywhere; weights stay on disk.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODEL="qwen2.5:3b-instruct-q4_K_M"
PORT="8080"
HOST="127.0.0.1"          # loopback by default; --host 0.0.0.0 inside a container/preview
OLLAMA_PORT="11434"
KEEP_ALIVE="30m"
MOCK=0
NO_OPEN=0
SKIP_PULL=0
NO_INSTALL=0

if [[ -t 1 ]]; then A=$'\033[38;5;190m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; O=$'\033[0m'
else A=""; D=""; G=""; Y=""; R=""; O=""; fi
info() { printf '  %s·%s %s\n' "$D" "$O" "$*"; }
good() { printf '  %s✓%s %s\n' "$G" "$O" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$O" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$O" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)      MODEL="${2:-}"; shift 2 ;;
    --port)       PORT="${2:-}"; shift 2 ;;
    --host)       HOST="${2:-}"; shift 2 ;;
    --ollama-port) OLLAMA_PORT="${2:-}"; shift 2 ;;
    --keep-alive) KEEP_ALIVE="${2:-}"; shift 2 ;;
    --mock)       MOCK=1; shift ;;
    --no-open)    NO_OPEN=1; shift ;;
    --skip-pull)  SKIP_PULL=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown flag: $1" ;;
  esac
done

printf '\n%sGRiD-OS-SOVEREIGN — local quickstart%s\n' "$A" "$O"

OS="$(uname -s)"
[[ $OS == Linux && -n ${WSL_DISTRO_NAME:-} ]] && OS="WSL"

# ------------------------------------------------------------------- cleanup
PIDS=()
CLEANED=0
cleanup() {
  [[ $CLEANED -eq 1 ]] && return   # INT/TERM and EXIT both fire; say it once
  CLEANED=1
  printf '\n'
  for pid in "${PIDS[@]:-}"; do
    [[ -n $pid ]] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  info "stopped what this script started"
}
trap cleanup EXIT INT TERM

started_ollama=0
started_mock=0

# ------------------------------------------------------------------- 1 · node
command -v node >/dev/null 2>&1 || die "node not found — install Node 18+ (https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ ${NODE_MAJOR:-0} -ge 18 ]] || die "node $(node -v) is too old — need 18+"
good "node $(node -v)"

cd "$REPO_ROOT"
[[ -f server.js ]] || die "server.js not found — run this from the repository root"

# ------------------------------------------------------- 2 · model host mode
if [[ $MOCK -eq 1 ]]; then
  info "mock mode — no Ollama, no downloads (responses are marked MOCK-*)"
  [[ -f tests/mock-ollama.mjs ]] || die "tests/mock-ollama.mjs missing"
  OLLAMA_PORT="${OLLAMA_PORT/11434/11500}"
  [[ $OLLAMA_PORT == 11434 ]] && OLLAMA_PORT=11500
  node tests/mock-ollama.mjs "$OLLAMA_PORT" &
  PIDS+=($!); started_mock=1
  MODEL="qwen2.5:14b-instruct-q4_K_M (mock)"
else
  if ! command -v ollama >/dev/null 2>&1; then
    [[ $NO_INSTALL -eq 1 ]] && die "ollama not installed and --no-install given"
    warn "ollama not found — installing"
    case "$OS" in
      Darwin)
        if command -v brew >/dev/null 2>&1; then brew install ollama
        else die "install Ollama.app from https://ollama.com/download, then re-run"; fi
        ;;
      Linux|WSL)
        curl -fsSL https://ollama.com/install.sh | sh || die "official installer failed — install manually from https://ollama.com/download"
        ;;
      *) die "unsupported OS: $OS" ;;
    esac
  fi
  good "ollama $(ollama --version 2>&1 | head -1 || echo installed)"

  # is the host already serving?
  if curl -fsS --max-time 2 "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1; then
    good "model host already running on :${OLLAMA_PORT}"
  else
    info "starting ollama serve on 127.0.0.1:${OLLAMA_PORT}"
    OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" OLLAMA_KEEP_ALIVE="$KEEP_ALIVE" ollama serve >/tmp/grid-os-ollama.log 2>&1 &
    PIDS+=($!); started_ollama=1
    for _ in $(seq 1 30); do
      curl -fsS --max-time 1 "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1 && break
      sleep 1
    done
    curl -fsS --max-time 2 "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1 \
      || die "ollama did not come up — see /tmp/grid-os-ollama.log"
    good "model host up (log: /tmp/grid-os-ollama.log)"
  fi

  # ------------------------------------------------------------ 3 · weights
  if [[ $SKIP_PULL -eq 0 ]]; then
    if curl -fsS --max-time 5 "http://127.0.0.1:${OLLAMA_PORT}/api/tags" | grep -q "\"$MODEL\""; then
      good "$MODEL already on disk"
    else
      info "pulling $MODEL (resumable — Ctrl-C and re-run to continue)"
      ollama pull "$MODEL" || die "pull failed. Offline? Re-run with --mock, or --skip-pull and choose a model you already have."
      good "$MODEL ready"
    fi
  fi
fi

# ------------------------------------------------------------------- 4 · app
info "starting the app tier on ${HOST}:${PORT} → gateway http://127.0.0.1:${OLLAMA_PORT}"
OLLAMA_URL="http://127.0.0.1:${OLLAMA_PORT}" PORT="$PORT" HOST="$HOST" GATEWAY_PREFIX="/gateway/" \
  node server.js &
PIDS+=($!)

URL="http://${HOST}:${PORT}"
for _ in $(seq 1 20); do
  curl -fsS --max-time 1 "${URL}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS --max-time 2 "${URL}/healthz" >/dev/null 2>&1 || die "app did not come up on ${URL}"
good "healthz: $(curl -fsS "${URL}/healthz")"

# ------------------------------------------------------------------- 5 · open
if [[ $NO_OPEN -eq 0 ]]; then
  case "$OS" in
    Darwin) open "$URL" 2>/dev/null || true ;;
    WSL)    powershell.exe -c "start $URL" 2>/dev/null || cmd.exe /c start "$URL" 2>/dev/null || true ;;
    Linux)  xdg-open "$URL" 2>/dev/null || true ;;
  esac
fi

cat <<EOF

${A}Ready${O}

  Workspace      ${URL}/app.html
  Landing        ${URL}/
  Behaviour Lab  ${URL}/lab.html
  Gateway        ${URL}/gateway/api/tags
  Model          ${MODEL}
  Keep-alive     ${KEEP_ALIVE}  ${D}(first request after idle pays a ~1–4s reload)${O}

  In the workspace: ⚙ Settings → "Ollama (localhost)" or "Same-origin proxy"
  → Save & probe. The top-bar chip should read ${G}GATEWAY LIVE${O}.

  ${D}Ctrl-C stops this script, the app tier$([[ $started_ollama -eq 1 ]] && echo " and the ollama host it started")${O}
EOF

# stay in the foreground so the trap and the child processes behave
wait
