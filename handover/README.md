# Handover pack — GRiD-OS-SOVEREIGN + KiNETiC-Ai

**Audience:** an AI coding agent installing this for you (written for **Qoder.ai IDE**, but it is
tool-agnostic), or a human operator with SSH access. Everything needed to install, deploy, verify
and hand back is in this directory plus `deploy/`.

**What you are installing.** A private-LLM product: a browser UI (`GRiD-OS-SOVEREIGN`, platform
brand **KiNETiC-Ai**) that talks to a local model host (Ollama) through a same-origin gateway
proxy, backed by a data platform that does real hybrid RAG (dense + BM25 → reciprocal-rank
fusion), runs an internal wiki with backlinks and review dates, mirrors cold content to
SharePoint, and enforces a 20 GB live ceiling with a 60-day "nobody opened it" demotion rule.

**Start here, in this order:**

| # | File | What it answers |
|---|------|-----------------|
| 1 | `handover/STATUS.md` | **Is it complete?** What is built, what is deliberately not wired, what needs your hardware or credentials. Read this first — it is the honest answer. |
| 2 | `handover/AGENT-BRIEF.md` | The brief for an AI IDE: repo map, invariants, commands, known traps, definition of done. |
| 3 | `handover/VPS-COOLIFY.md` | Install Coolify on the VPS (Kami-VPS) and get a **public HTTPS URL you can open from your laptop**. |
| 4 | `handover/WINDOWS-11.md` | Run the whole thing on a **local Windows 11 PC** (WSL2 recommended, native Node also covered). |
| 5 | `handover/ACCEPTANCE.md` | The verification checklist: every claim mapped to a command that proves it. Run it before you accept the work. |

---

## Three install paths — pick one (or do all three)

**A. Coolify on the VPS → public URL (recommended for "URL to laptop").**
Coolify is Apache-2.0 open source and free forever on your own hardware. It gives you the thing
you actually asked for: a reverse proxy, automatic Let's Encrypt TLS, one-click redeploys from the
GitHub repo, and a URL you can open from any machine.

```bash
# on the VPS, as root
sudo bash deploy/coolify/install-coolify.sh --dry-run     # rehearse, changes nothing
sudo bash deploy/coolify/install-coolify.sh --email you@example.com --username kami
# → Coolify UI at http://<vps-ip>:8000, then deploy deploy/coolify/docker-compose.yml
```
Full walkthrough, including the domain/URL step and GPU notes: **`handover/VPS-COOLIFY.md`**.
Verified against Coolify **v4.4.2** (released 2026-10-07).

**B. Bare metal, no Docker → systemd + nginx + certbot.**
`deploy/install.sh` provisions a Linux host directly: Ollama, the app as a systemd unit, nginx in
front, firewall, optional TLS, optional data platform. Use this if you would rather not run a
container orchestrator, or for an air-gapped-ish host where you control every layer.

```bash
bash deploy/install.sh --dry-run --yes                    # prints the plan, changes nothing
bash deploy/install.sh --domain grid.example.com --email you@example.com \
     --platform --gpu auto --tls letsencrypt --auth basic
bash deploy/verify.sh --url https://grid.example.com --expect-tls --platform --json
```

**C. Local Windows 11 PC → development and demo.**
Two options: WSL2 (Ubuntu) and run the same bash scripts as on the server, or native Node with
PowerShell commands. Neither needs Docker. **`handover/WINDOWS-11.md`** has both, with the exact
commands and what differs from Linux.

```bash
bash deploy/local.sh --mock --platform --fixtures          # full demo, no GPU, no downloads
```

---

## Before you start — what you need

| Need | Why | If you do not have it |
|------|-----|----------------------|
| SSH root (or sudo) on the VPS | Coolify's installer refuses to run as non-root | Path C (local PC) or ask your host for sudo |
| A domain name → A record at the VPS IP | Clean HTTPS URL for the laptop | Coolify still generates a URL from the server IP; TLS needs a real domain |
| 16 GB+ RAM on the node | Ollama with a 7B Q4 model; Coolify itself wants 2 GB | Pilot with `--mock` (path C) to prove the wiring |
| 32 GB RAM + 50 GB+ disk for the **production data shape** | `capacityPlan()` wants 22 GB for HNSW index + heap at the 20 GB live ceiling, and 50 GB per node provisioned | Run the platform with the JSONL store; the ceiling and retention rules still apply |
| GPU (optional) | Chat latency. A 7B Q4 model on CPU is usable but slow | Uncomment the GPU block in the Coolify compose only on a GPU node |
| GitHub access to `GoldenLion-Thai/Arena.ai-` | Coolify deploys from the repo | Or `bash deploy/package.sh` to build an offline tarball |
| SharePoint / Microsoft Graph credentials | Only for the mirror tier | It is stubbed and tested against a fake tenant; see `STATUS.md` §3 |

**Credentials rule:** never paste passwords, tokens or 2FA codes into a chat with an AI agent.
`install-coolify.sh` deliberately takes `--password-file` instead of a password argument, because
argv is visible to other users on the host. Put secrets in Coolify's environment variables or in a
file with `chmod 600`.

---

## What is in this repository

```
index.html app.html lab.html wiki.html   the four surfaces of the product
server.js                                app tier: static files + /gateway/* and /platform/* proxies
assets/                                  brand, chat, wiki, lab, retrieval UI code
platform/                                the data platform (config, embeddings, store, ingest,
                                         retrieve, sharepoint, lifecycle, wiki, server, schema.sql)
deploy/                                  install.sh, local.sh, verify.sh, package.sh, nginx tmpl,
                                         systemd unit, cloud-init, docker compose, Makefile
deploy/coolify/                          install-coolify.sh + docker-compose.yml (path A)
Dockerfile .dockerignore                 one image, two roles (app tier / data platform)
tests/                                   smoke.mjs, gateway.mjs, platform.mjs, deploy.mjs
docs/DATA-PLATFORM.md                    the design and the capacity arithmetic
handover/                                this pack
```

**Runtime dependencies: none.** No `npm install` is needed to run the product; Node 22+ is the only
requirement. `devDependencies` (`js-yaml`, `jsdom`, `fake-indexeddb`) exist purely so the test suite
can assert against real YAML, a real DOM and a real IndexedDB.

**Prove it before you trust it:**

```bash
npm install            # dev dependencies only, for the tests
npm test               # 4 suites; see ACCEPTANCE.md for the current pass count
```
