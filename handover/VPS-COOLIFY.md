# Path A — Coolify on the VPS (Kami-VPS) → a public URL you can open from your laptop

**End state:** Coolify (Apache-2.0, free forever on your own hardware, auto-updating) runs on the
VPS; this repository deploys from it as a Docker Compose resource; its reverse proxy (Traefik by
default in v4 — Caddy and custom are options under *Server → Proxy*) terminates Let's Encrypt TLS;
and one URL — `https://<your-domain>/` — serves the UI, the gateway and the data platform on a
single origin that your laptop can reach.

Everything below was verified against Coolify **v4.4.2** (released 2026-10-07) by reading its own
source: `scripts/install.sh`, `scripts/upgrade.sh`, `docker-compose.prod.yml`,
`bootstrap/helpers/parsers.php` (the `SERVICE_URL_*` magic-variable parser) and the 386 service
templates in `templates/compose/`. What has **not** been done is run it — the build sandbox has no
Docker, no root and no egress to `cdn.coollabs.io`. That is your operator's step, and this document
is written so that step is mechanical.

---

## 0. Sizing the node (read before you buy/provision)

Coolify itself is light: its installer requires ≥ 2 GB RAM and installs Docker, Traefik/Caddy,
Postgres and Redis. **This stack is not light**, because a local LLM is not light:

| Node | What it can run | Notes |
|---|---|---|
| 4 GB / 2 vCPU | Coolify only | Not enough for Ollama with a real model. Do not attempt the stack here. |
| **16 GB / 4 vCPU / 80 GB** | Coolify + GRiD-OS + platform + a 7B Q4 model on CPU | The **pilot** shape. Chat works, slowly. Retrieval works properly once `nomic-embed-text` is pulled. |
| **32 GB / 8 vCPU / 200 GB** | The above plus the production data shape | `capacityPlan()` wants **22 GB RAM** for the HNSW index (~7.05 GB) + heap (~9.95 GB) at the **20 GB live ceiling**, and the provisioning figure is **50 GB per node**. This is the shape the design assumes. |
| GPU node (e.g. A10/L4, 24 GB VRAM) | Fast chat + embeddings | Install the NVIDIA container toolkit on the host first, then uncomment the `deploy:` GPU block in `deploy/coolify/docker-compose.yml`. Coolify does not install drivers for you. |

Disk: model weights are gigabytes each (`qwen2.5:7b-instruct-q4_K_M` ≈ 4.7 GB,
`nomic-embed-text` ≈ 274 MB), Coolify's images add more, and the platform wants 50 GB provisioned
per node. Under 60 GB free is workable but tight; the installer warns about it.

---

## 1. Prerequisites

- Root (or sudo) on the VPS. The official Coolify installer exits immediately if `EUID != 0`.
- Debian/Ubuntu/RHEL-family/Alpine (the installer handles these; anything else is untested).
- Outbound 443 to `cdn.coollabs.io`, `get.docker.com`, `docker.io`, `registry.ollama.ai`,
  `github.com`, and `api.github.com` (the installer and Coolify fetch versions and images from these).
- Ports **80**, **443** and **8000** free on the host.
- A GitHub account able to read `GoldenLion-Thai/Arena.ai-` (private repo → Coolify needs a GitHub
  App or a deploy key).
- Optional but recommended: a domain with an **A record pointing at the VPS IP**, for a stable
  HTTPS URL. Without one, Coolify still generates a URL, but TLS is only issued for a name that
  resolves to the host.

---

## 2. Install

### 2.1 Rehearse (changes nothing)

```bash
git clone https://github.com/GoldenLion-Thai/Arena.ai-.git && cd Arena.ai-
git checkout arena/01a0a1c1-arena-ai

sudo bash deploy/coolify/install-coolify.sh --check-only   # host + network checks only
sudo bash deploy/coolify/install-coolify.sh --dry-run \
     --email you@example.com --username kami               # prints every command it would run
```

Exit codes: `0` ok · `1` a host check failed · `2` you aborted · `3` the Coolify CDN is unreachable.
A `3` on a locked-down network is not a bug in the script — it means run this on the VPS itself.

### 2.2 Install for real

```bash
sudo bash deploy/coolify/install-coolify.sh \
     --email you@example.com --username kami --yes
```

What it does, in order:
1. Host checks (root, OS, curl, RAM, disk, ports 80/443/8000, Docker presence).
2. Reaches `https://cdn.coollabs.io/coolify/versions.json` and reports the latest v4 version.
3. Downloads the **official** installer to a temp file and prints its line count, sha256 and first
   line — so you can see what you are about to run as root. It refuses to run anything that does not
   start with a shebang.
4. Runs it with `ROOT_USER_EMAIL`, `ROOT_USERNAME` (and `ROOT_USER_PASSWORD` if you passed
   `--password-file`). The official installer's spinner UI switches itself off when stdout is not a
   tty, so this is safe over `ssh -T`, in cloud-init or in CI.
5. Prints the UI URL and the exact next steps.

The official installer, in turn, installs Docker (via `get.docker.com`), the `curl wget git jq
openssl` and OpenSSH prerequisites, configures Docker's address pool, then deploys Coolify's own
stack — 9 steps, logged to `/data/coolify/source/installation-<date>.log`. Expect **5–15 minutes**
on a fresh VPS, longer on a slow disk.

> **Password handling.** Never pass a password as an argument: argv is readable by other users via
> `/proc/<pid>/cmdline` and lands in shell history. Either let Coolify ask for admin details in the
> UI on first login, or:
> ```bash
> umask 077 && printf '%s' "$STRONG_PASSWORD" > /root/.coolify-admin-pass
> sudo bash deploy/coolify/install-coolify.sh --email you@example.com \
>      --username kami --password-file /root/.coolify-admin-pass --yes
> shred -u /root/.coolify-admin-pass
> ```

### 2.3 First login

Open **`http://<vps-ip>:8000`** from your laptop (the installer prints this URL, with your public
IPv4/IPv6 and private addresses). Create or confirm the admin account, then under
*Settings → Instance* set the instance domain if you have one. Under *Server → Proxy* you can see
which proxy Coolify chose (Traefik by default).

If the server does not appear as connected: the installer connects localhost automatically via an
SSH key it generates; *Servers → localhost* should show green. If it is red, check
`systemctl status docker` and Coolify's own logs.

---

## 3. Deploy this repository from Coolify

1. **Projects → New Project** — e.g. `kinetic`.
2. **New Resource → Docker Compose.**
3. Connect Git: for the private repo, either install Coolify's **GitHub App** on
   `GoldenLion-Thai/Arena.ai-` or add a **deploy key** (*Server → Private Key*, then paste the
   public half into GitHub → Settings → Deploy keys). Choose branch
   **`arena/01a0a1c1-arena-ai`** (or merge PR #1 and use `main`).
4. **Docker Compose location:** `deploy/coolify/docker-compose.yml`
   **Base directory:** the repository root (Coolify's default). The compose file's build context is
   `../..` precisely so it works either way — relative paths in a compose file resolve against the
   compose file, not the working directory.
5. **Environment variables** (Resource → Environment Variables). These are the only values you must
   supply; everything else in the compose file has a working default:

   | Variable | Purpose | Default |
   |---|---|---|
   | `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Protects the UI with HTTP basic auth. Leave unset for none — not recommended on a public URL. | unset |
   | `EMBED_MODEL` | Embedding model `model-pull` fetches. | `nomic-embed-text` |
   | `CHAT_MODEL` | Chat model `model-pull` fetches. | `qwen2.5:7b-instruct-q4_K_M` |
   | `POSTGRES_PASSWORD` | Only needed if you enable the `pgvector` profile. | `change-me` (change it) |

   Coolify's magic variable `SERVICE_URL_GRID_8080` is already in the compose file — **do not set a
   value for it**; Coolify generates the URL.
6. **Deploy.** Watch the build log. First deploy: image build (fast — no npm install, the Dockerfile
   is a copy plus a user), then `model-pull` downloads weights (minutes to tens of minutes depending
   on the link). `model-pull` is a one-shot service that exits 0 when both models are present.
7. Optional: enable **Auto Deploy** (webhook) so a `git push` redeploys, and **Docker Compose
   profiles → `pgvector`** if you want Postgres running (see the honesty note below).

### What each service is

| Service | Exposed? | Notes |
|---|---|---|
| `grid-os` | **Yes** — the only one | UI + `/gateway/*` → Ollama + `/platform/*` → platform. `SERVICE_URL_GRID_8080`. |
| `platform` | No | The data platform. JSONL store on the `platform-data` volume. Binds `0.0.0.0` **inside the container** so `grid-os` can reach it; nothing publishes 8090. |
| `ollama` | No | Model host, `OLLAMA_HOST=0.0.0.0:11434` on the compose network only. |
| `model-pull` | No | One-shot weight fetcher. |
| `postgres` | No | `pgvector` profile only. Schema applied from `platform/schema.sql` on first boot. |

> **Honest note carried into the compose file:** the `pgvector` profile gives you a real Postgres 16
> + pgvector database with the production schema (HNSW, row-level security, retention views, tuned
> `shared_buffers`/`maintenance_work_mem`). The reference platform still persists to its JSONL
> store; `DATABASE_URL` is set and **unused** until the adapter lands. Enable the profile if you want
> the database present and inspectable now; do not expect the platform to read from it yet.

---

## 4. The URL to your laptop

Coolify assigns a URL to any compose service that declares a `SERVICE_URL_<name>_<port>` magic
variable — it generates the FQDN, points its proxy at `grid-os:8080` on the internal network, and
issues a certificate. You then either keep the generated one or replace it:

**Option 1 — your own domain (recommended).**
1. DNS: `A  grid.example.com  →  <vps-public-ip>` (and `AAAA` if you have IPv6). Wait for it to
   resolve: `dig +short grid.example.com` from your laptop.
2. Coolify: Resource → **Domains** → set `https://grid.example.com` for the `grid-os` service.
3. Redeploy (or let Coolify re-issue). TLS is Let's Encrypt via the proxy; HTTP-01 needs port 80
   reachable from the internet.
4. From your laptop: `https://grid.example.com` → the UI.

**Option 2 — the generated URL.** After the first deploy, open Resource → *grid-os* and copy the
generated FQDN Coolify shows. Its exact shape depends on your instance settings (*Settings →
Instance → Domains*); on a fresh install it is derived from the server IP. Verify in the UI rather
than assuming — this is the one Coolify behaviour that varies by instance configuration.

**Option 3 — no domain yet, just prove it.** From the VPS itself:
```bash
curl -s http://127.0.0.1:8080/healthz          # only if you publish 8080; normally you do not
docker compose -f deploy/coolify/docker-compose.yml exec grid-os wget -qO- http://127.0.0.1:8080/healthz
```
Then set up DNS and switch to Option 1 before showing it to anyone.

**Firewall.** Coolify's proxy wants 80/443 open to the world and 8000 open to you. Nothing else
needs to be: do **not** open 8080, 8090, 11434 or 5432. If `deploy/install.sh --skip-firewall` was
not used on this host before, check `ufw status` / your cloud security list and close anything the
stack does not need.

---

## 5. Verify from the laptop

```bash
BASE=https://grid.example.com            # ← your URL
curl -s  $BASE/healthz | head -c 400     # app tier: ok, version, gateway+platform reachability
curl -s  $BASE/platform/healthz          # platform: backend, dims, documents, chunks, embedder
curl -sI $BASE/                          # 200 + TLS
curl -s  $BASE/ -o /dev/null -w '%{http_code} %{ssl_verify_result}\n'
```

Then in the browser: open `$BASE`, send a chat message (proves UI → gateway → Ollama), open the
**Lab** page and run a retrieval (proves UI → platform → embeddings → RRF ranking with citations),
open the **Wiki** page (proves pages, revisions and backlinks).

The full checklist, including the internal-port and cold-tier checks, is
**`handover/ACCEPTANCE.md`**. Run it and keep the output.

---

## 6. Staying upgraded (free forever)

- **Coolify** auto-updates by default. The installer's `AUTOUPDATE` variable controls it; this
  script leaves it on unless you pass `--no-autoupdate`.
- **Force an upgrade now:**
  ```bash
  sudo bash deploy/coolify/install-coolify.sh --upgrade
  ```
  That runs Coolify's own `upgrade.sh latest latest <registry> false` — preferring the copy already
  installed at `/data/coolify/source/upgrade.sh`, downloading from the CDN only if it is missing.
  Logs land in `/data/coolify/source/upgrade-<date>.log`; a status file is written alongside.
- **Your app** upgrades on redeploy: `git push` (with Auto Deploy enabled) or *Resource → Redeploy*.
  Coolify keeps named volumes across redeploys — `platform-data`, `ollama-models` and `pg-data`
  survive; they are only removed when you delete the resource. That is what makes a redeploy safe
  and a teardown deliberate.
- **Pin or roll back** by setting the git ref in the resource to a known-good commit and redeploying.
  `deploy/package.sh` produces a byte-reproducible tarball if you need an offline artifact instead.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `http://<ip>:8000` refuses | Coolify still starting, or 8000 firewalled | `docker ps` — look for the `coolify` container; `docker logs coolify`; open 8000 to your IP only |
| Deploy fails on `pull access denied` | Private repo not authorised | Re-check the GitHub App / deploy key and the branch name |
| Build fails resolving `../..` context | Compose base directory set to something other than the repo root | Set base directory to the repo root, or point the compose location at the repo root copy |
| `grid-os` healthy but URL 502 | Proxy has no route because the magic env was given a value | Remove any value you set for `SERVICE_URL_GRID_8080`; Coolify generates it |
| Chat returns an error, `/healthz` shows the gateway unreachable | `ollama` still starting, or weights missing | `docker compose logs ollama model-pull`; wait for `model-pull` to exit 0 |
| Retrieval works but `/platform/healthz` says the hashing embedder | `nomic-embed-text` not pulled | Wait for `model-pull`, or `docker compose exec ollama ollama pull nomic-embed-text` |
| Platform requests 401 | Wrong/missing API key, or the key was issued before a redeploy of a fresh volume | `docker compose exec platform node platform/server.mjs --create-key` (or `--fixtures`, which prints one) and use `Authorization: Bearer ka_…` |
| `model-pull` restarts forever | Disk full or egress to `registry.ollama.ai` blocked | `df -h`; check outbound 443; it exits 0 on success and is `restart: "no"` |
| Ollama OOM-killed | Node too small for the chosen model | Use a smaller quant (`qwen2.5:3b-instruct-q4_K_M`) or a bigger node; `OLLAMA_MAX_LOADED_MODELS=2` is already conservative |
| Postgres starts but the platform ignores it | Expected — see the honesty note | The adapter is the next piece of work (`STATUS.md` §2) |
| TLS not issued | DNS not resolving to the host, or port 80 blocked | `dig +short <domain>`; open 80; check the proxy's Let's Encrypt logs |

---

## 8. Removing it

```bash
# the app only — keeps Coolify
docker compose -f deploy/coolify/docker-compose.yml down            # keeps volumes
docker compose -f deploy/coolify/docker-compose.yml down -v         # deletes data too
```
Coolify itself lives in `/data/coolify`; removing it is a deliberate act — take a backup of
`/data/coolify` first if you might want the configuration back. Coolify has its own database backup
scheduler (*Server → Backups*); use it, and store the destination off the node.
