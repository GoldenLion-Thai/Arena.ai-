#!/usr/bin/env bash
# =============================================================================
# GRiD-OS-SOVEREIGN — automated host installer (VPS / bare metal / VM)
#
#   Fastest method (existing box, Ubuntu/Debian/Oracle Linux/RHEL/Fedora):
#
#     curl -fsSL https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/main/deploy/install.sh \
#       | sudo bash -s -- --domain llm.example.com --email you@example.com \
#                         --model qwen2.5:14b-instruct-q4_K_M
#
#   From a checkout (also works offline except for the model pull):
#
#     sudo bash deploy/install.sh --domain llm.example.com --model qwen2.5:14b
#
#   See the plan without touching the machine:
#
#     bash deploy/install.sh --dry-run --domain llm.example.com
#
# What it does, in order:
#   1  preflight    OS, arch, systemd, RAM/disk, root or sudo
#   2  runtime      node >= 18 for the app tier
#   3  ollama       official installer, GitHub release fallback, systemd hardening
#   4  models       ollama pull for every --model (idempotent, resumable)
#   5  app          files to /opt/grid-os-sovereign, system user, systemd unit
#   6  edge         nginx site from template: TLS, basic auth, IP allowlist
#   7  tls          certbot (Let's Encrypt) or self-signed, or off
#   8  firewall     ufw/firewalld: 22/80/443 open, 8080/11434 loopback only
#   9  verify       deploy/verify.sh against the live host
#
# Idempotent: re-running upgrades in place and skips what is already correct.
# Nothing here sends data anywhere except: package manager, ollama.com/GitHub
# (runtime), registry.ollama.ai (weights), Let's Encrypt (certificate).
# =============================================================================
set -euo pipefail

ORIG_ARGS=("$@")
PKG_VERSION="1.0.0"   # not VERSION: /etc/os-release exports that name
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ------------------------------------------------------------------- defaults
DOMAIN=""
EMAIL=""
MODELS=()
ALLOW=()
AUTH=""
AUTH_USER="admin"
AUTH_PASS=""
TLS="auto"                # auto | certbot | self | off
APP_DIR="/opt/grid-os-sovereign"
APP_PORT="8080"
OLLAMA_HOST="127.0.0.1:11434"
KEEP_ALIVE="30m"
GPU="auto"                # auto | cuda | rocm | cpu
NGINX_ROOT=""             # default: $APP_DIR
SERVICE_USER="grid"
REPO="GoldenLion-Thai/Arena.ai-"
REF="main"
SOURCE=""                 # dir | tarball | url  (default: local checkout, else GitHub)
DRY_RUN=0
ASSUME_YES=0
RENDER_ONLY=0
RENDER_OUT=""
SKIP_OLLAMA=0
SKIP_APP=0
SKIP_NGINX=0
SKIP_FIREWALL=0
SKIP_VERIFY=0
LOG_FILE="/var/log/grid-os-sovereign-install.log"

# ----------------------------------------------------------------- terminal ui
if [[ -t 1 ]]; then
  C_DIM=$'\033[2m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
  C_ACC=$'\033[38;5;190m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_ACC=""; C_OFF=""
fi

step=0
say()  { printf '%s\n' "$*"; }
head_step() { step=$((step + 1)); printf '\n%s[%d/9] %s%s\n' "$C_ACC" "$step" "$*" "$C_OFF"; }
info() { printf '  %s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
good() { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$C_ERR" "$*" "$C_OFF" >&2; exit 1; }

# run <cmd…> — executes, or prints in dry-run. Never silent about mutations.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %s[dry-run]%s %s\n' "$C_DIM" "$C_OFF" "$*"
    return 0
  fi
  printf '  %s$%s %s\n' "$C_DIM" "$C_OFF" "$*"
  "$@"
}

# security_block — pure: turns --auth / --allow into nginx directives.
security_block() {
  AUTH_BLOCK=""
  ALLOW_BLOCK=""
  if [[ -n $AUTH ]]; then
    AUTH_BLOCK="    auth_basic \"GRiD-OS-SOVEREIGN\";\n    auth_basic_user_file ${HTPASSWD};\n"
  fi
  if [[ ${#ALLOW[@]} -gt 0 ]]; then
    local c
    for c in "${ALLOW[@]}"; do ALLOW_BLOCK+="    allow ${c};\n"; done
    ALLOW_BLOCK+="    deny all;\n"
  fi
}

# render_site — pure: template + tokens in, nginx config out.
#   {{#TLS}}…{{/TLS}}    kept when TLS is on
#   {{^TLS}}…{{^/TLS}}   kept when TLS is off
#   {{SECURITY}}         auth_basic and/or allow/deny (may render to nothing)
render_site() {
  local keep="tls"; [[ $TLS == off ]] && keep="plain"
  awk -v keep="$keep" \
      -v domain="${DOMAIN:-_}" \
      -v root="${NGINX_ROOT:-$APP_DIR}" \
      -v app_port="${APP_PORT}" \
      -v ollama_port="${OLLAMA_HOST##*:}" \
      -v cert="${TLS_CERT_PATH}" \
      -v key="${TLS_KEY_PATH}" \
      -v auth="$AUTH_BLOCK" -v allow="$ALLOW_BLOCK" '
    /^\{\{#TLS\}\}/   { blk = "tls";   next }
    /^\{\{\/TLS\}\}/  { blk = "";       next }
    /^\{\{\^TLS\}\}/  { blk = "plain"; next }
    /^\{\{\^\/TLS\}\}/{ blk = "";      next }
    blk != "" && blk != keep { next }
    {
      gsub(/\{\{DOMAIN\}\}/, domain);      gsub(/\{\{ROOT\}\}/, root)
      gsub(/\{\{APP_PORT\}\}/, app_port);  gsub(/\{\{OLLAMA_PORT\}\}/, ollama_port)
      gsub(/\{\{TLS_CERT\}\}/, cert);      gsub(/\{\{TLS_KEY\}\}/, key)
      if (/\{\{SECURITY\}\}/) { printf "%s%s", auth, allow; next }
      print
    }' "${REPO_ROOT}/deploy/nginx.conf.tmpl"
}

# write_file <path> <<EOF — write a heredoc, or announce it in dry-run.
# (`run tee path >/dev/null <<EOF` would swallow its own dry-run message.)
write_file() {
  local path="$1" body
  body="$(cat)"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %s[dry-run]%s write %s (%s bytes)\n' "$C_DIM" "$C_OFF" "$path" "${#body}"
    printf '%s\n' "$body" | sed "s/^/      ${C_DIM}|${C_OFF} /"
  else
    printf '  %s$%s write %s\n' "$C_DIM" "$C_OFF" "$path"
    printf '%s\n' "$body" > "$path"
  fi
}

# capture <cmd…> — run but swallow output unless it fails
capture() {
  if [[ $DRY_RUN -eq 1 ]]; then printf '  %s[dry-run]%s %s\n' "$C_DIM" "$C_OFF" "$*"; return 0; fi
  local out
  if ! out="$("$@" 2>&1)"; then printf '%s\n' "$out" >&2; return 1; fi
}

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<EOF

Flags
  --domain HOST          Public hostname (enables TLS + redirect). Omit for IP-only.
  --email ADDR           Let's Encrypt contact (required for --tls certbot).
  --model NAME           Model to pull; repeatable. Default: qwen2.5:7b-instruct-q4_K_M
  --tls MODE             auto|certbot|self|off (default: certbot when --domain given)
  --auth USER:PASS       Enable nginx basic auth on the whole site.
  --allow CIDR           IP allowlist; repeatable. Omit to allow any (auth strongly advised).
  --app-dir PATH         Install path (default /opt/grid-os-sovereign)
  --port N               App tier listen port on loopback (default 8080)
  --ollama-host H:P      Ollama bind address (default 127.0.0.1:11434 — keep it private)
  --keep-alive DUR       OLLAMA_KEEP_ALIVE (default 30m)
  --gpu MODE             auto|cuda|rocm|cpu
  --source DIR|TARBALL|URL  Where the app files come from (default: this checkout)
  --repo OWNER/NAME --ref REF  GitHub source when no local checkout is present
  --skip-ollama | --skip-app | --skip-nginx | --skip-firewall | --skip-verify
  --render-only          Print the rendered nginx site and exit (no changes made)
  --out FILE             With --render-only, write the site here instead of stdout
  --dry-run              Print the exact plan, change nothing
  -y, --yes              Non-interactive (for cloud-init / CI)
  -h, --help             This text
EOF
}

# --------------------------------------------------------------------- parsing
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        DOMAIN="${2:-}"; shift 2 ;;
    --email)         EMAIL="${2:-}"; shift 2 ;;
    --model)         MODELS+=("${2:-}"); shift 2 ;;
    --allow)         ALLOW+=("${2:-}"); shift 2 ;;
    --auth)          AUTH="${2:-}"; shift 2 ;;
    --tls)           TLS="${2:-}"; shift 2 ;;
    --app-dir)       APP_DIR="${2:-}"; shift 2 ;;
    --port)          APP_PORT="${2:-}"; shift 2 ;;
    --ollama-host)   OLLAMA_HOST="${2:-}"; shift 2 ;;
    --keep-alive)    KEEP_ALIVE="${2:-}"; shift 2 ;;
    --gpu)           GPU="${2:-}"; shift 2 ;;
    --source)        SOURCE="${2:-}"; shift 2 ;;
    --repo)          REPO="${2:-}"; shift 2 ;;
    --ref)           REF="${2:-}"; shift 2 ;;
    --skip-ollama)   SKIP_OLLAMA=1; shift ;;
    --skip-app)      SKIP_APP=1; shift ;;
    --skip-nginx)    SKIP_NGINX=1; shift ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --skip-verify)   SKIP_VERIFY=1; shift ;;
    --render-only)   RENDER_ONLY=1; shift ;;
    --out)           RENDER_OUT="${2:-}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -y|--yes)        ASSUME_YES=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown flag: $1 (try --help)" ;;
  esac
done

if [[ ${#MODELS[@]} -eq 0 ]]; then MODELS=("qwen2.5:7b-instruct-q4_K_M"); fi
SITE_NAME="grid-os-sovereign"
HTPASSWD="/etc/nginx/.grid-os-sovereign.htpasswd"
TLS_CERT_PATH="/etc/ssl/grid-os-sovereign/fullchain.pem"
TLS_KEY_PATH="/etc/ssl/grid-os-sovereign/privkey.pem"
security_block
if [[ -z $AUTH && -n $AUTH_PASS ]]; then AUTH="${AUTH_USER}:${AUTH_PASS}"; fi
if [[ -n $AUTH && $AUTH != *:* ]]; then
  printf '✗ --auth expects USER:PASS (got "%s")\n' "$AUTH" >&2; exit 2
fi
if [[ -n $AUTH && ( -z ${AUTH%%:*} || -z ${AUTH#*:} ) ]]; then
  printf '✗ --auth needs both a user and a password\n' >&2; exit 2
fi
if [[ $TLS == auto ]]; then TLS=$([[ -n $DOMAIN ]] && echo certbot || echo off); fi

confirm() {
  [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]] && return 0
  [[ ! -t 0 ]] && return 0
  printf '\n%s%s%s ' "$C_WARN" "$*" "$C_OFF"; printf '[y/N] '
  local a; read -r a; [[ $a =~ ^[Yy]$ ]]
}

if [[ $RENDER_ONLY -eq 1 ]]; then
  [[ -f "${REPO_ROOT}/deploy/nginx.conf.tmpl" ]] || die "nginx.conf.tmpl not found next to this script"
  if [[ -n $RENDER_OUT ]]; then render_site > "$RENDER_OUT"; say "wrote $RENDER_OUT"; else render_site; fi
  exit 0
fi

# ============================================================ 1 · preflight
head_step "preflight"

if [[ $EUID -ne 0 && $DRY_RUN -eq 0 ]]; then
  if command -v sudo >/dev/null; then
    warn "not root — re-running with sudo (environment preserved)"
    exec sudo -E bash "${BASH_SOURCE[0]}" "${ORIG_ARGS[@]}"
  fi
  die "must run as root (or install sudo)"
fi

OS_ID="unknown"; OS_LIKE=""; OS_VERSION=""
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_LIKE="${ID_LIKE:-}"; OS_VERSION="${VERSION_ID:-${VERSION:-}}"
fi
ARCH="$(uname -m)"
PKG="apt"
case "$OS_ID$OS_LIKE" in
  *debian*|*ubuntu*) PKG="apt" ;;
  *rhel*|*fedora*|*centos*|*ol*) PKG="dnf" ;;
  *) warn "unrecognised distro '$OS_ID' — assuming apt-compatible; use --skip-* if needed" ;;
esac

RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
DISK_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
SYSTEMD=0; command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] && SYSTEMD=1

good "$OS_ID $OS_VERSION ($ARCH) · pkg=$PKG · ram=${RAM_MB}MB · disk=${DISK_GB}GB free"
[[ $SYSTEMD -eq 1 ]] && good "systemd present" || warn "no systemd (container?) — services will be printed, not installed"

if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1 || echo "nvidia")
  good "GPU detected: $GPU_NAME"
  [[ $GPU == auto ]] && GPU=cuda
else
  info "no NVIDIA GPU — CPU inference (expect 3–10 tok/s; pick a ≤7B quantised model)"
  [[ $GPU == auto ]] && GPU=cpu
fi
[[ $GPU == rocm ]] && { command -v rocminfo >/dev/null || warn "ROCm requested but rocminfo not found"; }

if [[ $GPU == cpu && $RAM_MB -lt 6000 ]]; then
  warn "only ${RAM_MB}MB RAM on CPU: use a small model (qwen2.5:1.5b, llama3.2:3b)"
fi

pkg_install() {
  if [[ $PKG == apt ]]; then
    capture env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    capture env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  else
    capture dnf install -y -q "$@"
  fi
}

# ============================================================ 2 · runtime
head_step "app runtime (node >= 18)"

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [[ ${NODE_MAJOR:-0} -ge 18 ]]; then good "node $(node -v)"; NODE_OK=1
  else warn "node $(node -v) is too old (need >= 18)"; fi
fi
if [[ $NODE_OK -eq 0 ]]; then
  if [[ $PKG == apt ]]; then
    info "installing nodejs from NodeSource (node 20 LTS)"
    run bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  else
    run dnf module reset -y nodejs || true
    run dnf module enable -y nodejs:20
    run dnf install -y -q nodejs
  fi
fi

# ============================================================ 3 · ollama
head_step "ollama (model host)"

if [[ $SKIP_OLLAMA -eq 1 ]]; then
  info "skipped (--skip-ollama) — OLLAMA_URL must point elsewhere"
elif command -v ollama >/dev/null 2>&1; then
  good "ollama $(ollama --version 2>/dev/null | head -1 || echo present) already installed"
  run systemctl enable --now ollama || true
else
  info "installing ollama (official script)"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %s[dry-run]%s curl -fsSL https://ollama.com/install.sh | sh\n' "$C_DIM" "$C_OFF"
  elif ! bash -c "curl -fsSL https://ollama.com/install.sh | sh"; then
    warn "official installer failed — falling back to the GitHub release tarball"
    TMPD=$(mktemp -d)
    ASSET="ollama-linux-${ARCH/x86_64/amd64}.tar.zst"
    [[ $ARCH == aarch64 ]] && ASSET="ollama-linux-arm64.tar.zst"
    run bash -c "curl -fsSL -o '$TMPD/ollama.tar.zst' \"https://github.com/ollama/ollama/releases/latest/download/$ASSET\""
    pkg_install zstd
    run bash -c "tar --use-compress-program=unzstd -xf '$TMPD/ollama.tar.zst' -C /usr/local"
    run rm -rf "$TMPD"
  fi
fi

if [[ $SKIP_OLLAMA -eq 0 ]]; then
  info "hardening + configuring ollama (loopback only, keep-alive ${KEEP_ALIVE})"
  run mkdir -p /etc/systemd/system/ollama.service.d
  run mkdir -p /var/lib/ollama/models
  if [[ -f ${REPO_ROOT}/deploy/ollama.service ]]; then
    run cp "${REPO_ROOT}/deploy/ollama.service" /etc/systemd/system/ollama.service.d/override.conf
  else
    write_file /etc/systemd/system/ollama.service.d/override.conf <<EOF
[Service]
Environment="OLLAMA_HOST=${OLLAMA_HOST}"
Environment="OLLAMA_KEEP_ALIVE=${KEEP_ALIVE}"
Environment="OLLAMA_NUM_PARALLEL=4"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_MODELS=/var/lib/ollama/models"
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
RestrictSUIDSGID=true
EOF
  fi
  # keep the bind address in sync with --ollama-host if it is not the default
  if [[ $OLLAMA_HOST != "127.0.0.1:11434" ]]; then
    run sed -i "s#^Environment=\"OLLAMA_HOST=.*#Environment=\"OLLAMA_HOST=${OLLAMA_HOST}\"#" \
      /etc/systemd/system/ollama.service.d/override.conf
  fi
  run systemctl daemon-reload
  run systemctl enable --now ollama
  run systemctl restart ollama || true
fi

# ============================================================ 4 · models
head_step "model weights"

if [[ $SKIP_OLLAMA -eq 1 ]]; then
  info "skipped — models live on the remote host"
else
  for m in "${MODELS[@]}"; do
    [[ -z $m ]] && continue
    if [[ $DRY_RUN -eq 0 ]] && curl -fsS --max-time 5 "http://${OLLAMA_HOST}/api/tags" 2>/dev/null | grep -q "\"$m\""; then
      good "$m already present"
    else
      info "pulling $m (resumable; large models take a while)"
      run ollama pull "$m"
    fi
  done
  info "keep-alive is ${KEEP_ALIVE}: the first request after idle pays a reload (~1–4s)."
  info "for sub-400ms TTFT on cold starts, keep one model warm or shorten --keep-alive."
fi

# ============================================================ 5 · app
head_step "app tier → ${APP_DIR}"

resolve_source() {
  if [[ -n $SOURCE ]]; then echo "$SOURCE"; return; fi
  if [[ -f "${REPO_ROOT}/server.js" && -f "${REPO_ROOT}/index.html" ]]; then echo "$REPO_ROOT"; return; fi
  echo "https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz"
}
SRC="$(resolve_source)"
info "source: $SRC"

run mkdir -p "$APP_DIR"
run id -u "$SERVICE_USER" >/dev/null 2>&1 || run useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" || true

if [[ $DRY_RUN -eq 0 ]]; then
  case "$SRC" in
    http*|/*/*.tar.gz|*.tar.gz)
      TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
      curl -fsSL -o "$TMPD/src.tar.gz" "$SRC"
      tar -xzf "$TMPD/src.tar.gz" -C "$TMPD" --strip-components=1
      rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$TMPD"/ "$APP_DIR"/ 2>/dev/null \
        || cp -a "$TMPD"/. "$APP_DIR"/
      ;;
    *)
      if command -v rsync >/dev/null; then
        rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude shots "$SRC"/ "$APP_DIR"/
      else
        cp -a "$SRC"/. "$APP_DIR"/
      fi
      ;;
  esac
else
  run rsync -a --delete --exclude node_modules "$SRC"/ "$APP_DIR"/
fi

write_file "/etc/grid-os-sovereign.env" <<EOF
# Written by deploy/install.sh — the app tier reads this and nothing else.
PORT=${APP_PORT}
HOST=127.0.0.1
OLLAMA_URL=http://${OLLAMA_HOST}
GATEWAY_PREFIX=/gateway/
EOF

run chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
run chmod 640 /etc/grid-os-sovereign.env

if [[ $SYSTEMD -eq 1 ]]; then
  write_file /etc/systemd/system/grid-os-sovereign.service <<EOF
[Unit]
Description=GRiD-OS-SOVEREIGN — private LLM workspace (app tier)
Documentation=https://github.com/${REPO}
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/grid-os-sovereign.env
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
# Zero runtime dependencies, so nothing to update underneath it.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=false

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
  run systemctl enable --now grid-os-sovereign.service
  run systemctl restart grid-os-sovereign.service || true
else
  warn "no systemd — start manually:  cd ${APP_DIR} && PORT=${APP_PORT} HOST=127.0.0.1 OLLAMA_URL=http://${OLLAMA_HOST} node server.js"
fi

# ============================================================ 6 · edge
head_step "nginx edge (TLS, auth, streaming)"

SITE_FILE="/etc/nginx/sites-available/${SITE_NAME}.conf"
[[ $PKG == dnf ]] && SITE_FILE="/etc/nginx/conf.d/${SITE_NAME}.conf"

if [[ $SKIP_NGINX -eq 1 ]]; then
  info "skipped (--skip-nginx) — the app is on http://127.0.0.1:${APP_PORT}"
else
  command -v nginx >/dev/null 2>&1 || { info "installing nginx"; run pkg_install nginx; }
  [[ $PKG == apt ]] && run mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

  if [[ -n $AUTH ]]; then
    AU="${AUTH%%:*}"; AP="${AUTH#*:}"
    [[ -z $AP ]] && die "--auth expects USER:PASS"
    info "basic auth for user '$AU' (bcrypt hash stored in $HTPASSWD)"
    command -v htpasswd >/dev/null 2>&1 || { [[ $PKG == apt ]] && run pkg_install apache2-utils || run pkg_install httpd-tools; }
    if [[ $DRY_RUN -eq 0 ]]; then htpasswd -bc "$HTPASSWD" "$AU" "$AP" >/dev/null; chmod 640 "$HTPASSWD"; fi
  else
    warn "no authentication configured. This is a private-model host: add --auth USER:PASS"
    warn "or put your IdP in front (nginx auth_request / OIDC proxy) before exposing it."
  fi
  [[ ${#ALLOW[@]} -gt 0 ]] && info "IP allowlist: ${ALLOW[*]}"

  TMPL="${REPO_ROOT}/deploy/nginx.conf.tmpl"
  [[ -f $TMPL ]] || die "nginx template not found at $TMPL (run from a checkout or pass --source)"
  info "rendering ${SITE_FILE} (mode: $([[ $TLS == off ]] && echo plain-http || echo https))"
  if [[ $DRY_RUN -eq 0 ]]; then
    render_site > "$SITE_FILE"
    # the template documents its own tokens in comments — only real config lines matter
    if grep -v '^\s*#' "$SITE_FILE" | grep -q "{{"; then
      warn "unsubstituted tokens remain in $SITE_FILE:"
      grep -n "{{" "$SITE_FILE" | grep -v '^\s*#' | head -5 | sed 's/^/      /'
    else
      good "site rendered with every token substituted"
    fi
  else
    printf '  %s[dry-run]%s render %s → %s\n' "$C_DIM" "$C_OFF" "$TMPL" "$SITE_FILE"
  fi

  if [[ $PKG == apt && -d /etc/nginx/sites-enabled ]]; then
    run ln -sf "$SITE_FILE" "/etc/nginx/sites-enabled/${SITE_NAME}.conf"
    run rm -f /etc/nginx/sites-enabled/default
  fi
  run nginx -t
  run systemctl enable --now nginx
  run systemctl reload nginx
fi

# ============================================================ 7 · tls
head_step "TLS"

if [[ $SKIP_NGINX -eq 1 || $TLS == off ]]; then
  info "TLS off — serving plain HTTP. Fine behind another terminator; unsafe on a public IP."
elif [[ $TLS == certbot ]]; then
  [[ -z $DOMAIN ]] && die "--tls certbot needs --domain"
  [[ -z $EMAIL ]] && die "--tls certbot needs --email (Let's Encrypt expiry notices)"
  command -v certbot >/dev/null 2>&1 || { info "installing certbot"; [[ $PKG == apt ]] && run pkg_install certbot python3-certbot-nginx || run pkg_install certbot python3-certbot-nginx; }
  info "requesting a Let's Encrypt certificate for ${DOMAIN}"
  run certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
  run bash -c "systemctl list-timers | grep -q certbot || (crontab -l 2>/dev/null; echo '17 4 * * * certbot renew --quiet --deploy-hook \"systemctl reload nginx\"') | crontab -"
elif [[ $TLS == self ]]; then
  info "self-signed certificate (browsers will warn; use for staging only)"
  run mkdir -p /etc/ssl/grid-os-sovereign
  run openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout /etc/ssl/grid-os-sovereign/privkey.pem \
    -out /etc/ssl/grid-os-sovereign/fullchain.pem \
    -subj "/CN=${DOMAIN:-$(hostname -f 2>/dev/null || echo localhost)}"
  run systemctl reload nginx
fi

# ============================================================ 8 · firewall
head_step "host firewall"

if [[ $SKIP_FIREWALL -eq 1 ]]; then
  info "skipped (--skip-firewall)"
elif command -v ufw >/dev/null 2>&1; then
  run ufw allow 22/tcp comment "ssh"
  [[ $TLS != off ]] && run ufw allow 80/tcp comment "http → redirect + ACME"
  run ufw allow 443/tcp comment "https"
  run ufw deny 8080/tcp comment "app tier is loopback only"
  run ufw deny 11434/tcp comment "ollama is loopback only"
  run ufw --force enable
elif command -v firewall-cmd >/dev/null 2>&1; then
  run firewall-cmd --permanent --add-service=ssh
  run firewall-cmd --permanent --add-service=https
  [[ $TLS != off ]] && run firewall-cmd --permanent --add-service=http
  run firewall-cmd --permanent --remove-service=cockpit || true
  run firewall-cmd --reload
else
  warn "no ufw/firewalld — rely on the cloud security list (see oci/ or deploy/README.md)"
fi
info "the model port must never be public. Verify from outside:  nc -vz <host> 11434  → must fail"

# ============================================================ 9 · verify
head_step "verification"

VERIFY="${SCRIPT_DIR}/verify.sh"
if [[ $SKIP_VERIFY -eq 1 ]]; then
  info "skipped (--skip-verify)"
elif [[ $DRY_RUN -eq 1 ]]; then
  run bash "$VERIFY" --url "http://127.0.0.1:${APP_PORT}" --expect-models
elif [[ -f $VERIFY ]]; then
  URL="http://127.0.0.1:${APP_PORT}"
  [[ -n $DOMAIN && $TLS != off ]] && URL="https://${DOMAIN}"
  bash "$VERIFY" --url "$URL" --expect-models || warn "verification reported failures — see above"
else
  info "verify.sh not present; manual check:  curl -s http://127.0.0.1:${APP_PORT}/healthz"
fi

# ------------------------------------------------------------------- summary
PUBLIC="http://127.0.0.1:${APP_PORT}"
[[ -n $DOMAIN && $TLS != off ]] && PUBLIC="https://${DOMAIN}"

run bash -c "printf '%s\n' "$(date -Is) installed v${PKG_VERSION} domain=${DOMAIN:-none} tls=${TLS} models=${MODELS[*]}" >> ${LOG_FILE}"

cat <<EOF

${C_ACC}GRiD-OS-SOVEREIGN ${PKG_VERSION} installed${C_OFF}

  URL              ${PUBLIC}
  App files        ${APP_DIR}          (service user: ${SERVICE_USER})
  App env          /etc/grid-os-sovereign.env
  App service      systemctl status grid-os-sovereign
  Model host       http://${OLLAMA_HOST}   (loopback — not published)
  Models           ${MODELS[*]}
  Edge             ${SITE_FILE}
  TLS              ${TLS}
  Auth             $([[ -n $AUTH ]] && echo "basic auth (${AUTH%%:*})" || echo "${C_WARN}none — add one${C_OFF}")
  Allowlist        $([[ ${#ALLOW[@]} -gt 0 ]] && echo "${ALLOW[*]}" || echo "any")
  Install log      ${LOG_FILE}

  Next: open ${PUBLIC}, press ⚙ Settings, pick "Same-origin proxy → Ollama",
  Save & probe. The chip in the top bar should read GATEWAY LIVE.

  Re-run any time to upgrade in place:
    sudo bash ${SCRIPT_DIR}/install.sh ${DOMAIN:+--domain ${DOMAIN} }${EMAIL:+--email ${EMAIL} }$(printf -- '--model %s ' "${MODELS[@]}")

EOF
