#!/usr/bin/env bash
# =============================================================================
# GRiD-OS-SOVEREIGN — build the upload-ready artifact
#
#   bash deploy/package.sh                 → dist/grid-os-sovereign-<ver>-<sha>.tar.gz
#   bash deploy/package.sh --out /tmp/rel  → anywhere you like
#
# Produces everything needed to put this on a VPS without git or GitHub access:
#
#   dist/<name>-<ver>-<sha>.tar.gz   runtime files only (no node_modules)
#   dist/<name>-<ver>-<sha>.sha256   checksum for the tarball
#   dist/manifest.json               version, sha, file count, build metadata
#   dist/INSTALL.txt                 the exact scp + install commands
#
# The tarball is self-installing:
#   tar -xzf <artifact> && sudo bash deploy/install.sh --source . --domain llm.example.com
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT="${REPO_ROOT}/dist"
NAME="grid-os-sovereign"
VERSION=""
INCLUDE_TESTS=1
DOMAIN_HINT="llm.example.com"

if [[ -t 1 ]]; then A=$'\033[38;5;190m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; O=$'\033[0m'
else A=""; D=""; G=""; R=""; O=""; fi
die() { printf '\n%s✗ %s%s\n' "$R" "$*" "$O" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)     OUT="${2:-}"; shift 2 ;;
    --name)    NAME="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --no-tests) INCLUDE_TESTS=0; shift ;;
    --domain)  DOMAIN_HINT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

cd "$REPO_ROOT"
[[ -f server.js && -f index.html && -f app.html && -f lab.html ]] || die "not a GRiD-OS-SOVEREIGN checkout"

[[ -z $VERSION ]] && VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
DIRTY=$(git diff --quiet 2>/dev/null && echo "" || echo "-dirty")
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ARTIFACT="${NAME}-${VERSION}-${SHA}${DIRTY}.tar.gz"

# what ships: runtime surface + deployment automation (+ tests unless --no-tests)
INCLUDE=(index.html app.html lab.html server.js package.json README.md DESIGN.md assets deploy)
[[ $INCLUDE_TESTS -eq 1 ]] && INCLUDE+=(tests)
[[ -f .gitignore ]] && INCLUDE+=(.gitignore)
[[ -d .github ]] && INCLUDE+=(.github)
[[ -d oci ]] && INCLUDE+=(oci)

for f in "${INCLUDE[@]}"; do [[ -e $f ]] || die "expected path missing: $f"; done

mkdir -p "$OUT"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
TOP="${STAGE}/${NAME}-${VERSION}"
mkdir -p "$TOP"

# copy without the junk, deterministically (sorted, fixed mtimes → reproducible)
for f in "${INCLUDE[@]}"; do
  if [[ -d $f ]]; then
    mkdir -p "${TOP}/${f}"
    (cd "$REPO_ROOT" && tar -cf - \
      --exclude node_modules --exclude dist --exclude .git --exclude shots \
      --exclude '*.log' --exclude package-lock.json --exclude .DS_Store "$f") \
      | (cd "$TOP" && tar -xf -)
  else
    cp -p "$f" "${TOP}/"
  fi
done

TARBALL="${OUT}/${ARTIFACT}"
# Fixed owner/mtime + sorted entries make the build byte-reproducible for the
# same tree, so two hosts can compare checksums instead of trusting a re-run.
EPOCH=$(date -d "$STAMP" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$STAMP" +%s 2>/dev/null || echo 0)
export SOURCE_DATE_EPOCH="$EPOCH"
TAR_REPRO=(--sort=name --owner=0 --group=0 --numeric-owner --mtime="@${EPOCH}")
tar --help 2>&1 | grep -q -- "--sort" || TAR_REPRO=(--owner=0 --group=0 --numeric-owner)  # bsdtar (macOS)
tar "${TAR_REPRO[@]}" -czf "$TARBALL" -C "$STAGE" "${NAME}-${VERSION}"

BYTES=$(wc -c < "$TARBALL" | tr -d ' ')
FILES=$(tar -tzf "$TARBALL" | wc -l | tr -d ' ')
SUM=$( (sha256sum "$TARBALL" 2>/dev/null || shasum -a 256 "$TARBALL") | awk '{print $1}')

printf '%s  %s\n' "$SUM" "$ARTIFACT" > "${OUT}/${ARTIFACT}.sha256"

cat > "${OUT}/manifest.json" <<EOF
{
  "name": "${NAME}",
  "version": "${VERSION}",
  "artifact": "${ARTIFACT}",
  "sha256": "${SUM}",
  "bytes": ${BYTES},
  "files": ${FILES},
  "built_at": "${STAMP}",
  "git": { "sha": "${SHA}", "branch": "${BRANCH}", "dirty": $([[ -n $DIRTY ]] && echo true || echo false) },
  "contents": ["index.html", "app.html", "lab.html", "server.js", "assets/", "deploy/"$([[ $INCLUDE_TESTS -eq 1 ]] && echo ', "tests/"')],
  "runtime": { "node": ">=18", "dependencies": "none", "model_host": "ollama >= 0.3 or any OpenAI-compatible gateway" }
}
EOF

cat > "${OUT}/INSTALL.txt" <<EOF
GRiD-OS-SOVEREIGN ${VERSION} (${SHA}) — built ${STAMP}
artifact : ${ARTIFACT}
sha256   : ${SUM}
size     : ${BYTES} bytes, ${FILES} entries
runtime  : node >= 18, zero npm dependencies

────────────────────────────────────────────────────────────────────────────
UPLOAD + INSTALL ON A VPS (automated method)
────────────────────────────────────────────────────────────────────────────
  scp ${OUT}/${ARTIFACT} ubuntu@YOUR_HOST:/tmp/

  ssh ubuntu@YOUR_HOST '
    set -e
    cd /tmp && sha256sum -c <(echo "${SUM}  ${ARTIFACT}")
    tar -xzf ${ARTIFACT} && cd ${NAME}-${VERSION}
    sudo bash deploy/install.sh --source . \\
        --domain ${DOMAIN_HINT} --email you@example.com \\
        --model qwen2.5:14b-instruct-q4_K_M \\
        --auth admin:CHANGE_ME --yes
  '

Or, without uploading (the box reaches GitHub):
  curl -fsSL https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/main/deploy/install.sh \\
    | sudo bash -s -- --domain ${DOMAIN_HINT} --email you@example.com --auth admin:CHANGE_ME

────────────────────────────────────────────────────────────────────────────
LOCAL (fastest method)
────────────────────────────────────────────────────────────────────────────
  tar -xzf ${ARTIFACT} && cd ${NAME}-${VERSION}
  bash deploy/local.sh                 # real Ollama
  bash deploy/local.sh --mock          # no Ollama installed? demo host

VERIFY AFTER INSTALL
  bash deploy/verify.sh --url https://${DOMAIN_HINT} --expect-models --auth admin:CHANGE_ME
EOF

printf '\n%sPackaged%s\n\n' "$A" "$O"
printf '  %s%s%s\n' "$G" "$TARBALL" "$O"
printf '  %s·%s %s bytes · %s entries · sha256 %s…\n' "$D" "$O" "$BYTES" "$FILES" "${SUM:0:16}"
printf '  %s·%s %s/manifest.json\n' "$D" "$O" "$OUT"
printf '  %s·%s %s/INSTALL.txt  (scp + install commands)\n\n' "$D" "$O" "$OUT"
