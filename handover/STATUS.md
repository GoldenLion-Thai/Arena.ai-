# STATUS — is this complete?

**Verdict: the product and the deployment automation are complete and tested. The installation
itself has not been executed, because executing it needs your hardware, your domain and your
credentials — none of which an agent in a sandbox has.** Everything you need to run it is here,
and every claim below is backed by either a test or a command you can run.

Two separate questions, answered separately:

1. **Is the delivery complete?** Yes for code, docs, deployment automation, tests, and the Coolify
   + Windows paths as *artifacts*. No for the act of installing on your VPS, which requires root on
   that VPS.
2. **Will it run on a local Windows 11 PC?** Yes — see §5. WSL2 is the supported route; native
   Node works too, with two documented differences.

---

## 1. Complete, tested, and running

| Requirement | Status | Enforced in | Proof |
|---|---|---|---|
| App named `GRiD-OS-[NAME]` → `GRiD-OS-SOVEREIGN`, platform brand **KiNETiC-Ai** | ✅ | `assets/js/brand.js` | `tests/smoke.mjs` |
| Private LLM chat UI, same-origin gateway to Ollama | ✅ | `server.js` (`/gateway/*` proxy), `assets/js/chat.js` | `tests/gateway.mjs` (50 assertions) |
| **Real RAG**, not keyword matching | ✅ | `platform/retrieve.mjs` — dense HNSW + BM25, reciprocal-rank fusion (k=60), per-document diversification | `tests/platform.mjs` |
| Production database shape (Postgres 16 + pgvector, RLS, HNSW m=16/efC=128/efS=100) | ✅ SQL | `platform/schema.sql` | `tests/deploy.mjs` (schema parity + compose wiring) |
| **One unified database shared by all apps** | ✅ | `platform/server.mjs` + `platform/config.mjs` — 5 apps, hashed API keys, scopes, verticals, per-app rate limits, audit log | `tests/platform.mjs` |
| **Organised wiki** with backlinks and review dates | ✅ | `platform/wiki.mjs`, `wiki.html`, `assets/js/wiki.js` | live: 5 pages / 5 revisions / **9 backlinks** / 1 overdue review |
| **Double headroom** | ✅ | `capacityPlan()` — 22 GB RAM for a 10.53 GB working set (2×); 100 GB provisioned for a 20 GB ceiling (2.5×); 100 connections for 48 wanted (2.08×) | `tests/platform.mjs` asserts the ratios |
| **SharePoint mirror** with re-openable path | ✅ | `platform/sharepoint.mjs` — demotion is blocked until `verifyMirror()` passes | `tests/platform.mjs` |
| **50 GB per node, 20 GB live ceiling** | ✅ | `platform/config.mjs` quotas (legal 5, finance 4, consulting 4, compliance 3, operations 2, people 1.5, shared 0.5 GB = 20 GB) | `tests/platform.mjs` |
| **Only live/production/useful data admitted** | ✅ | `platform/ingest.mjs` — minimum ~40 tokens, tier + vertical classification, rejection reasons returned | `tests/platform.mjs` |
| **60 days unopened → back to SharePoint, re-openable** | ✅ | `platform/lifecycle.mjs` — retrieval does *not* reset the clock, opening *does*; 4.3 KB stub stays discoverable; rehydrate reports drift; window tightens 60→30→14 days at 90%/97% of quota | `tests/platform.mjs`; live demo shows a 61-day document in cold tier |
| **Shared across all business verticals** | ✅ | vertical-scoped ACLs (`vertical:<id>` principals), default-deny public | `tests/platform.mjs` |
| Deployment automation (bare metal, no Docker) | ✅ | `deploy/install.sh` (23 flags, `--dry-run`, `--render-only`), `deploy/verify.sh`, `deploy/package.sh` (byte-reproducible tarball), `deploy/cloud-init.yaml`, `deploy/Makefile` | `tests/deploy.mjs` (522 assertions) |
| Local demo without a GPU or downloads | ✅ | `deploy/local.sh --mock --platform --fixtures` | ran green; demo key printed in the banner |
| **Docker image (one Dockerfile, two roles)** | ✅ new | `Dockerfile`, `.dockerignore` | `tests/deploy.mjs` |
| **Coolify install path (free forever, OSS, latest)** | ✅ new | `deploy/coolify/install-coolify.sh`, `deploy/coolify/docker-compose.yml` | `tests/deploy.mjs` + `--dry-run` exercised |
| **Handover pack for an AI IDE / human** | ✅ new | `handover/` (6 documents) | `tests/deploy.mjs` asserts each file and its required content |
| Test suite green | ✅ | `tests/*.mjs` | see `ACCEPTANCE.md` for the count |

---

## 2. Deliberately **not** wired (do not be surprised)

These are the honest gaps. They are stated in `docs/DATA-PLATFORM.md §9`, in the compose file
headers, and here — never left to be discovered.

1. **The Postgres adapter is the next piece of work.** The reference server in `platform/` persists
   to **JSONL** files. `platform/schema.sql` is the real production shape and the compose `pgvector`
   profile applies it on first boot, but no code reads or writes those tables yet: `DATABASE_URL` is
   set in the environment and **unused**. Consequence: everything above works and is tested against
   the JSONL store; moving to Postgres means writing an adapter behind the same store interface
   (`listDocuments`, `getDocument`, `markOpened`, `canRead`, `putDocument`, `scanChunks`,
   `chunksFor`, `auditLog`) and re-pointing `createStore()`.
2. **`GraphSharePoint` has never met a real tenant.** `platform/sharepoint.mjs` implements the
   Microsoft Graph calls, and the mirror/demotion logic is tested against an in-memory fake. Real
   credentials, a real site/drive id and a real tenant are required before the mirror moves actual
   bytes. Until then, demotion is exercised against the fake and is blocked unless `verifyMirror()`
   passes — which is the safe direction to fail in.
3. **No model weights were pulled in the environment where this was built.** No GPU, no Docker, and
   `registry.ollama.ai` was not reachable. The retrieval path is therefore proven with a
   deterministic local embedder (`HashEmbedder`) and a mock Ollama (`tests/mock-ollama.mjs`). On
   your hardware, `model-pull` fetches `nomic-embed-text` and `qwen2.5:7b-instruct-q4_K_M`; until
   they land, `PLATFORM_EMBED=auto` falls back to the hashing embedder and says so in `/healthz`
   (`embedder` field) rather than pretending.
4. **TLS has not been issued.** `deploy/install.sh --tls letsencrypt` renders and runs the certbot
   path, and `deploy/verify.sh --expect-tls` checks it, but no certificate was obtained here — that
   needs your domain and a public host.

---

## 3. Not executed — because it needs your machine

| Action | Why it was not done here | What to run instead |
|---|---|---|
| Install Coolify on Kami-VPS | The build sandbox has no Docker, no root, and no SSH egress to your VPS | `sudo bash deploy/coolify/install-coolify.sh` on the VPS (§ `VPS-COOLIFY.md`) |
| Deploy the stack and get the laptop URL | Same — plus it needs your GitHub repo access and your domain | Coolify UI → New Resource → Docker Compose |
| `docker build` the image | No Docker daemon in the sandbox | `docker build -t grid-os-sovereign .` anywhere Docker exists |
| Run on a real Windows 11 PC | The sandbox is Linux | `handover/WINDOWS-11.md`, both routes |

**Consequence for the Coolify artifacts specifically:** `deploy/coolify/install-coolify.sh` was
exercised with `--dry-run` (all host checks ran; it exits 3 with a clear message when the Coolify
CDN is unreachable, which is exactly what happened in a network-restricted sandbox). Its flags,
environment variables, upgrade path and UI port were verified against Coolify's own source
(`coollabsio/coolify` **v4.4.2**: `scripts/install.sh` documents `ROOT_USERNAME`,
`ROOT_USER_EMAIL`, `ROOT_USER_PASSWORD`, `AUTOUPDATE`, `REGISTRY_URL`; `scripts/upgrade.sh` takes
`<image> <helper> <registry> <skip-backup>`; the installer prints `http://<ip>:8000`; and its 386
service templates confirm the `SERVICE_URL_<name>_<port>` magic-variable convention). The compose
file was parsed as YAML and asserted by tests. It has **not** been run against a live Coolify.

---

## 4. What only you can supply

- **Root/sudo on the VPS**, and its public IP.
- **A domain** (A record → VPS IP) if you want HTTPS on a name rather than an IP-based URL.
- **GitHub access** for Coolify to clone `GoldenLion-Thai/Arena.ai-` (branch
  `arena/01a0a1c1-arena-ai`), or an offline tarball from `deploy/package.sh`.
- **Basic-auth credentials** for the UI, and an **admin email** for TLS/Let's Encrypt notices.
- **SharePoint/Graph app credentials** if and when you want the mirror to move real bytes.
- **Hardware decisions**: CPU-only pilot vs GPU node; 16 GB pilot vs the 32 GB production shape.

---

## 5. Is it complete for a **local Windows 11 PC**?

**Yes, with one structural caveat:** every automation script in this repository is **bash**. Windows
11 ships neither bash nor a POSIX shell in the default path, so the supported local route is
**WSL2 (Ubuntu)** — after which Windows behaves exactly like the VPS, including Docker Desktop if
you want the Coolify compose locally.

| Capability on Windows 11 | WSL2 (Ubuntu) | Native Windows (PowerShell) |
|---|---|---|
| Run the UI (`node server.js`) | ✅ | ✅ |
| Run the data platform (`node platform/server.mjs`) | ✅ | ✅ |
| Run the full demo (`deploy/local.sh --mock --platform --fixtures`) | ✅ | ❌ needs `bash` (Git Bash works) |
| Provisioning (`deploy/install.sh`, systemd, nginx, ufw) | ⚠️ WSL2 has no systemd by default → use `local.sh` instead | ❌ |
| Coolify locally | ✅ via Docker Desktop + WSL2 backend | ✅ via Docker Desktop |
| Ollama | ✅ Linux Ollama inside WSL2, or Windows Ollama with `OLLAMA_URL=http://<host>:11434` | ✅ native Windows build |
| GPU passthrough to WSL2 | ⚠️ works for CUDA on supported drivers; verify with `nvidia-smi` inside WSL2 | ✅ native |
| Test suite (`npm test`) | ✅ | ✅ |

Exact commands, the two native-Windows differences, and how to reach the WSL2 server from the
Windows browser: **`handover/WINDOWS-11.md`**.

---

## 6. Build provenance

- Repository: `https://github.com/GoldenLion-Thai/Arena.ai-`
- Branch: `arena/01a0a1c1-arena-ai` (pull request #1 open against `main`)
- Runtime: Node 22+ (developed on Node 22.22), zero runtime npm dependencies
- Verified Coolify release at handover time: **v4.4.2** (2026-10-07)
- Latest Ollama release checked while writing the automation: **v0.34.3**
- Test suites: `smoke.mjs`, `gateway.mjs`, `platform.mjs`, `deploy.mjs` — counts in `ACCEPTANCE.md`
- Live demo state at handover: 11 documents / 10 chunks indexed, 5 wiki pages, 9 backlinks,
  1 overdue review, retrieval returning citations with a content checksum in ~7 ms,
  `withinBudget: true`, one document correctly in cold tier ("not opened for 61 days — reverted to
  SharePoint")

**If you are the agent installing this:** your definition of done is in
`handover/ACCEPTANCE.md`, and the traps that already cost this project time are in
`handover/AGENT-BRIEF.md` §6. Read both before you change anything.
