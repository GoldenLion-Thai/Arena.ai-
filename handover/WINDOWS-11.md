# Path C — running it on a local Windows 11 PC

**Answer to "is this complete for a local PC, Win11?" — yes.** The product is plain Node 22 with
zero runtime dependencies, so it runs on Windows exactly as it does on the VPS. The one structural
caveat: **every automation script in `deploy/` is bash**, so Windows needs a bash. Two supported
routes, in order of preference:

| Route | Bash from | Best for | Effort |
|---|---|---|---|
| **C1. WSL2 (Ubuntu)** | Real Linux | Everything, including Docker and the same commands as the VPS | ~20 min once |
| **C2. Native Windows + Git Bash** | Git for Windows | Running the app and the tests without a Linux layer | ~10 min |

`deploy/local.sh` was written with Windows in mind: it detects WSL and opens your browser with
`powershell.exe -c "start <url>"`, falling back to `cmd.exe /c start`. So the demo route already
ends with a browser window on your desktop.

---

## C1. WSL2 (recommended)

### 1. Enable WSL2

In **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu-24.04
wsl --set-default-version 2
wsl --update
wsl -l -v          # VERSION must be 2, not 1
```

Then reboot. If `wsl --install` fails: enable **Virtual Machine Platform** and **Windows Subsystem
for Linux** in *Turn Windows features on or off*, and make sure **virtualisation is on in the
BIOS/UEFI** (Task Manager → Performance → CPU → "Virtualization: Enabled").

### 2. Set up Ubuntu

```bash
sudo apt-get update && sudo apt-get install -y curl git build-essential

# Node 22 (NodeSource), or use nvm if you prefer
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # v22.x
```

**Keep the repository in the Linux filesystem (`~/`), not `/mnt/c/…`.** Cross-OS file access is an
order of magnitude slower and will make `npm test` crawl.

```bash
cd ~
git config --global core.autocrlf input      # belt and braces; .gitattributes already forces LF
git clone https://github.com/GoldenLion-Thai/Arena.ai-.git
cd Arena.ai-
git checkout arena/01a0a1c1-arena-ai
npm install                                  # dev dependencies only, for the tests
npm test                                     # all four suites
```

### 3. Run the full demo (no GPU, no model downloads)

```bash
bash deploy/local.sh --mock --platform --fixtures --no-open
```

That starts a mock Ollama (`tests/mock-ollama.mjs`), the data platform with deterministic fixture
content, and the app tier, then prints a banner with the URLs **and a demo API key**. Open
**`http://localhost:8080`** in your **Windows** browser — WSL2 forwards `localhost` to Windows
automatically. If it does not on your build, use `wsl hostname -I` from PowerShell and browse to
that address instead.

To prove the real retrieval path, hit the platform through the same origin:

```bash
KEY=<the key from the banner>
curl -s http://localhost:8080/platform/healthz
curl -s -H "Authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -d '{"query":"retention rule for unopened documents","k":3}' \
     http://localhost:8080/platform/v1/search
# appId comes from the key, and the parameter is "k" — not "topK".
```

### 4. Real models instead of the mock

Two options — pick one:

**(a) Ollama for Windows (native).** Easiest GPU path, and the weights live on the Windows side.

```powershell
winget install --id Ollama.Ollama -e
# let the WSL2 VM reach the Windows host: bind on all interfaces + allow it through the firewall
$env:OLLAMA_HOST = "0.0.0.0"
New-NetFirewallRule -DisplayName "Ollama from WSL2" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Allow
ollama pull nomic-embed-text
ollama pull qwen2.5:7b-instruct-q4_K_M
```

```bash
# inside WSL2 — the Windows host is the default gateway
WIN_HOST=$(ip route show default | awk '{print $3}')
OLLAMA_URL="http://$WIN_HOST:11434" bash deploy/local.sh --platform --fixtures --no-open
```

**(b) Ollama for Linux inside WSL2.** Keeps everything in one place; GPU passthrough needs the
**Windows** NVIDIA driver (do not install the Linux driver inside WSL2 — it breaks CUDA).

```bash
curl -fsSL https://ollama.com/install.sh | sh
nvidia-smi              # must work inside WSL2 for GPU inference
ollama pull nomic-embed-text && ollama pull qwen2.5:7b-instruct-q4_K_M
bash deploy/local.sh --platform --fixtures --no-open
```

Either way, confirm which embedder the platform actually used:

```bash
curl -s http://localhost:8080/platform/healthz   # "embedder":"nomic-embed-text", not the hash fallback
```

### 5. Docker in WSL2 (optional — mirrors the VPS exactly)

Install **Docker Desktop** with the WSL2 backend (*Settings → Resources → WSL integration → enable
your distro*), then:

```bash
docker build -t grid-os-sovereign .
docker compose -f deploy/coolify/docker-compose.yml up -d
# Coolify itself, locally: it needs ports 80/443/8000 free and root inside the distro
sudo bash deploy/coolify/install-coolify.sh --dry-run
```

Leave the GPU block in the compose file commented out unless the node really has one.

### 6. What does *not* apply in WSL2

- `deploy/install.sh` provisions **systemd units, nginx, ufw and certbot** on a Linux server. WSL2
  can run systemd (enable it in `/etc/wsl.conf` with `[boot] systemd=true`), but running a firewall
  and a public web server inside a laptop VM is not what you want — use `deploy/local.sh` locally and
  `deploy/install.sh` or Coolify on the VPS.
- The `oci/` manifests target Oracle Cloud shapes, not a laptop.
- No public URL: a laptop behind NAT is not reachable from the internet. That is what Path A exists
  for. You can expose one temporarily with a tunnel (Cloudflare/Tailscale/ngrok) if you need to show
  it to someone — treat that as a demo, not a deployment, and keep basic auth on.

---

## C2. Native Windows (PowerShell + Git Bash, no WSL)

### 1. Install

```powershell
winget install --id OpenJS.NodeJS.LTS -e        # Node 22 LTS
winget install --id Git.Git -e                  # includes Git Bash (a real bash)
# optional, for real models:
winget install --id Ollama.Ollama -e
```

Restart the terminal so `node`, `npm`, `git` and `ollama` are on PATH.

### 2. Clone and test (PowerShell)

```powershell
git config --global core.autocrlf input
cd $HOME\src
git clone https://github.com/GoldenLion-Thai/Arena.ai-.git
cd Arena.ai-
git checkout arena/01a0a1c1-arena-ai
npm install
npm test                       # works natively — the tests are plain Node, no bash
```

### 3. Run it — two ways

**With bash (Git Bash), the same command as everywhere else:**

```bash
# open "Git Bash" from the Start menu, cd to the repo
bash deploy/local.sh --mock --platform --fixtures
```

**Pure PowerShell, no bash at all** (three windows, or three background jobs):

```powershell
# window 1 — mock model host
node tests/mock-ollama.mjs 11500

# window 2 — data platform with demo content
$env:PLATFORM_PORT = "8090"
$env:PLATFORM_HOST = "127.0.0.1"
$env:PLATFORM_DATA = "$HOME\.kinetic\platform"
$env:OLLAMA_URL    = "http://127.0.0.1:11500"
node platform/server.mjs --fixtures        # prints a demo API key

# window 3 — app tier, proxying both
$env:PORT          = "8080"
$env:HOST          = "127.0.0.1"
$env:OLLAMA_URL    = "http://127.0.0.1:11500"
$env:PLATFORM_URL  = "http://127.0.0.1:8090"
node server.js
```

Open **`http://localhost:8080`**.

### 4. The two native-Windows differences (this is the honest part)

1. **`deploy/*.sh` need bash.** Git Bash provides it, so `local.sh`, `verify.sh` and `package.sh`
   all work. `install.sh` additionally needs systemd/nginx/ufw and is **Linux-only** — on Windows use
   Coolify with Docker Desktop, or a Linux VPS.
2. **Line endings.** If a `.sh` file arrives with CRLF you get `$'\r': command not found`. The
   repository now carries `.gitattributes` forcing LF, and `git config core.autocrlf input` before
   cloning makes it certain. To repair an existing checkout:
   ```powershell
   git rm --cached -r . ; git reset --hard
   ```

Everything else — the UI, the gateway proxy, the data platform, the wiki, retention, the test suite
— is identical to Linux, because it is plain Node with no native modules.

---

## Troubleshooting on Windows

| Symptom | Cause | Fix |
|---|---|---|
| `bash: command not found` | No bash installed | Install Git for Windows (Git Bash) or WSL2 |
| `$'\r': command not found` | CRLF checkout | `.gitattributes` + `git config core.autocrlf input`, then re-checkout |
| `'node' is not recognized` | PATH not refreshed after install | Close and reopen the terminal |
| `EADDRINUSE :::8080` | Another process holds the port | `netstat -ano \| findstr :8080` → `taskkill /PID <pid> /F` (PowerShell), or use `--port 8081` |
| `localhost:8080` unreachable from Windows | WSL2 localhost forwarding off | `wsl hostname -I` and browse to that IP; or `wsl --shutdown` and restart |
| Ollama in WSL2 cannot reach Windows Ollama | Bound to 127.0.0.1 / firewall | `OLLAMA_HOST=0.0.0.0` + the inbound firewall rule in §C1.4 |
| CUDA not visible in WSL2 | Linux NVIDIA driver installed inside WSL2 | Remove it; install the **Windows** driver; `nvidia-smi` should work in WSL2 |
| PowerShell refuses to run a script | Execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Antivirus deletes `node_modules` or flags scripts | Real-time scanning of the dev dir | Add the repo folder as an exclusion |
| Chat works but retrieval is lexical-only | Embedding model not pulled | `ollama pull nomic-embed-text`, then restart the platform; `/platform/healthz` reports which embedder is live |
| Two platforms running at once | A previous `local.sh` left processes behind | Kill leftovers before restarting, otherwise the app proxy talks to the **old** platform with the **old** key and you get a mysterious 401 |

---

## Where to go next

- Prove the install: **`handover/ACCEPTANCE.md`**
- Put it on the internet for your laptop: **`handover/VPS-COOLIFY.md`**
- What is and is not finished: **`handover/STATUS.md`**
- Agent ground rules and traps: **`handover/AGENT-BRIEF.md`**
