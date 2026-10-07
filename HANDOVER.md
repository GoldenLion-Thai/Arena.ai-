# ARENA COMMAND SUITE — HANDOVER & INSTALL/DEPLOY PACK

Generated: 2026-10-07 (Europe/London)
Purpose: machine- and human-readable handover so an AI IDE (e.g. Qoder.ai) or a
Coolify VPS can install, run, and deploy this project with zero guesswork.

---

## 0. WHAT THIS IS

A terminal-grade **brand + product design foundation** for the "X Command" vertical
family, plus a **working prototype** of the flagship app, CONTENT COMMAND.

- `design/brand/` — logo system (SVG), source-of-truth generator + linter
- `design/apps/` — app design specs (Content Command, Recon console)
- `docs/` — project audit + autonomy roadmap
- `dashboard/index.html` — live project dashboard (static)
- `app/content-command/` — **working** CONTENT COMMAND terminal (static SPA, mock data)
- `tools/` — `brand_gen.py` (geometry → SVG) and `brand_lint.py` (hard-rule enforcer)

The repo is **zero-build** for the static parts: pure HTML/CSS/JS + a Python 3
generator. No `npm install`, no bundler.

---

## 1. COMPLETENESS ASSESSMENT (honest)

| Area | State | Notes |
|---|---|---|
| Brand / logo system | DONE (95%) | 19 SVG assets, lint-enforced, no curves, no capital K |
| Project dashboard | SHIPPED V1 (90%) | static, relative asset links |
| Content Command app | WORKING PROTOTYPE (78%) | 7 modules on **mock** data; no real backend/connectors yet |
| Recon & Reconstruction | DESIGN-ONLY (45%) | UI concept + spec **only**; no extraction/decryption code (policy) |
| Vertical products (Sales/Support/Product/Finance/Research) | 15% each | logo templates exist; no app shells |
| Backend / real data | NOT BUILT | `app/content-command/data.js` is the swap point for real APIs |
| Auth / multi-tenant | NOT BUILT | n/a for prototype |
| CI | NOT BUILT | recommended: run `brand_lint.py` on every logo change |

**Is it "complete"?** No — by design it is a design + prototype foundation. It is
complete *as a handover artifact*: brand law is locked, the flagship app runs, and
the data layer is isolated for real connectors. Production completeness requires the
backend/sync/connector work listed in `docs/PROJECT-AUDIT.md`.

---

## 2. LOCAL INSTALL — WINDOWS 11

Prereqs: **Git for Windows** + **Python 3.11+** (add to PATH during install).

```powershell
# 1. clone
git clone https://github.com/GoldenLion-Thai/Arena.ai-.git
cd Arena.ai-

# 2. serve the whole repo (dashboard + app) on :8080
python -m http.server 8080

# 3. open in browser
#    Dashboard : http://localhost:8080/dashboard/index.html
#    App       : http://localhost:8080/app/content-command/index.html
```

Optional — regenerate / verify brand assets:
```powershell
python tools/brand_gen.py     # regenerate 19 SVG assets + PNG previews
python tools/brand_lint.py    # MUST print PASS before any logo ships
```

No Node/npm required for the shipped app. Node 22 is only used to syntax-check the
JS during development.

---

## 3. AI IDE INSTALL (Qoder.ai / Qodo / Cursor / VS Code)

The project is **zero-build**, so any AI coding IDE can open the folder and act:

1. Open the repo root in the IDE (Qoder.ai: point it at the cloned folder / repo URL).
2. Tell the agent: *"Serve this repo with a static server and open
   app/content-command/index.html. Regenerate brand assets with
   tools/brand_gen.py and verify with tools/brand_lint.py."*
3. The agent can edit `app/content-command/data.js` to wire real API connectors,
   or extend `app/content-command/app.js` with new modules. All brand rules are
   enforced by `tools/brand_lint.py` and the hard constraints below.

There is **no package.json / build step** to run. If you want a containerized
dev server, see the Dockerfile in this repo.

---

## 4. DEPLOY — KAMI-VPS-ASCI via COOLIFY (free tier / upgraded)

Goal: a public URL reachable from your laptop. Coolify is a self-hosted PaaS; this
repo ships a `Dockerfile` (nginx static serve) so deployment is one-click.

### 4.1 Provision the VPS
- OS: Ubuntu 22.04/24.04 LTS (any "freeforever"/upgraded plan on KAMI-VPS-ASCI).
- Open ports in the VPS firewall: `22` (SSH), `80`, `443`, and `8000` (Coolify UI,
  lock this down after setup).

### 4.2 Install Docker + Coolify
```bash
# on the VPS
curl -fsSL https://get.docker.com | sh
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```
- Coolify UI: `http://<VPS-IP>:8000` → create admin, set a strong password.
- (Harden later: put Coolify behind a reverse proxy + TLS, restrict :8000.)

### 4.3 Create the app
1. Coolify → **Projects** → New Project (`arena-command`).
2. **Add Resource → Application → Git**, connect GitHub, select repo
   `GoldenLion-Thai/Arena.ai-`, branch `arena/01a0cd26-arena-ai`.
3. Build: choose **Dockerfile** (repo root). The shipped `Dockerfile` serves the
   repo over nginx on port 80.
4. **Domain**: set an FQDN (e.g. `arena.yourdomain.com`) **or** use Coolify's
   auto-generated preview URL (`https://<random>.coolify.freeforever.me`).
   Enable **HTTPS (Let's Encrypt)**.
5. Deploy. Coolify builds the image and exposes the URL.

### 4.4 Reach it from the laptop
Open the deployed URL in any browser on the laptop. If you used an FQDN, point its
DNS A record at the VPS IP first. If you used the auto URL, it is live immediately.
Both are reachable from the laptop over the internet.

> Note: this serves the **static** dashboard + prototype. To run the *real* data
> layer you would add a backend service (same repo or linked Coolify resource) and
> point `app/content-command/data.js` at it.

---

## 5. BRAND LAW (must hold on every surface)

- **Nothing round or oval** — rectangles, bars, straight lines, angles, grid blocks only.
- **No capital `K`** anywhere (lint enforces in SVG titles + generator).
- Top-left logo fits the collapsible sidebar: 64u collapsed mark · 240u expanded lockup.
- 8u grid · 1u hairline · 0u radius · 12u symbol-to-text gap · uppercase angular monoline.
- Core color electric cyan `#3DD6F5` on near-black `#0A0B0D`.

---

## 6. CONNECTORS / REPORTS (this handover)

This pack and the project status were pushed to the connected workspace apps:
- **Google Drive** — full handover pack uploaded as a Doc.
- **Google Docs** — same document (Drive Doc).
- **Notion** — status + handover page created.
- **Linear** — handover issue created with next steps.
- **Gmail** — summary draft created (not sent; review & send yourself).
- **Google Calendar** — handover-review event created on primary calendar.

GitHub: committed + pushed to `arena/01a0cd26-arena-ai`.

---

## 7. NEXT STEPS TO PRODUCTION

1. Swap `app/content-command/data.js` mock layer for real API connectors (read-only).
2. Add sync retries + idempotency + incremental cursors (Platform ingestion).
3. Add LLM enrichment prompt versioning + tag review queue.
4. Add scorer rubric weighting + ICP context; weekly brief cron.
5. Build the vertical app shells (Sales/Support/Product/Finance/Research) from templates.
6. Recon & Reconstruction stays **design/oversight UI only** — no decryption code.
7. Add CI: run `tools/brand_lint.py` on every logo/brand change.
