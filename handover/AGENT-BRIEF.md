# AGENT BRIEF — for Qoder.ai IDE (or any coding agent) taking over the install

You are being handed a working, tested repository and asked to **install and verify it**, not to
redesign it. The product is `GRiD-OS-SOVEREIGN` (platform brand **KiNETiC-Ai**) — a private-LLM
product: browser UI → same-origin gateway → local Ollama, backed by a data platform doing real
hybrid RAG, a wiki, SharePoint mirroring and retention.

Your job, in order:

1. Read `handover/STATUS.md` — know what is finished and what is deliberately not wired.
2. Pick the install path with the operator: **A** Coolify on the VPS (public URL), **B** bare metal
   via `deploy/install.sh`, **C** local machine via `deploy/local.sh`.
3. Rehearse with `--dry-run` before you change anything. Every automation script here has one.
4. Install, then run `handover/ACCEPTANCE.md` end to end and show the operator the output.
5. Report what passed, what failed, and what you could not test — with evidence, not adjectives.

---

## 1. Ground rules (non-negotiable)

- **Do not rename the app.** The operator mandated the `GRiD-OS-[INSERT NAME]` format; it is
  `GRiD-OS-SOVEREIGN`. The brand string lives in `assets/js/brand.js`.
- **Every design claim must be backed by working code and a test.** If you add an artifact, add an
  assertion in `tests/deploy.mjs`. If you change behaviour, change the test that pins it. The suite
  is the contract.
- **State honestly what is not wired.** This repository already does that in three places
  (`docs/DATA-PLATFORM.md §9`, the compose headers, `handover/STATUS.md §2`). Keep that habit; do
  not "tidy up" an honesty note because it looks unfinished.
- **Never accept credentials in chat.** No passwords, tokens or 2FA codes in prompts, logs or
  commit messages. `deploy/coolify/install-coolify.sh` takes `--password-file` for exactly this
  reason. Put secrets in Coolify env vars, `chmod 600` files, or your secret manager.
- **Never commit `.data/`** (gitignored by design — it can hold real content hashes and audit rows),
  `node_modules/`, model weights, or generated tarballs.
- **Internal services stay unpublished.** `8090` (platform), `11434` (Ollama) and `5432` (Postgres)
  must never be reachable from outside the host or the compose network. Only the app tier's `8080`
  (or Coolify's proxy on 443) faces the world. If you find yourself adding a `ports:` entry to make
  debugging easier, stop and use the same-origin proxy instead.
- **One origin for the browser.** The UI calls `/gateway/*` and `/platform/*` on its own origin;
  `server.js` proxies those to the internal addresses. Do not "simplify" this into direct
  cross-origin calls — it is what keeps internal addresses out of the client and CORS out of the
  design.

## 2. Repo map

```
server.js                 app tier. Static files + /gateway/* (Ollama) + /platform/* (platform).
                          Env: PORT HOST OLLAMA_URL GATEWAY_PREFIX PLATFORM_URL PLATFORM_PREFIX
                          BASIC_AUTH_USER BASIC_AUTH_PASS. No dependencies.
index.html app.html       product site + chat workspace
lab.html                  retrieval lab (RAG parameters, citations, cold-tier behaviour)
wiki.html                 the wiki surface
assets/js/                brand.js, chat.js, wiki.js, lab.js, retrieval.js — plain ES modules
platform/config.mjs       APPS (5), SCOPES, verticals, quotas, capacityPlan(), chunking policy
platform/embeddings.mjs   Ollama embedder + HashEmbedder (deterministic offline fallback)
platform/store.mjs        JSONL store: documents, chunks, ACLs, audit log, opened-at tracking
platform/ingest.mjs       admission: is this live/useful data? tiering, chunking, rejection reasons
platform/retrieve.mjs     hybrid retrieval: dense + BM25 → RRF (k=60), diversification, citations
platform/sharepoint.mjs   Graph mirror; verifyMirror() gates demotion
platform/lifecycle.mjs    the 60-day rule, cold stubs, rehydrate, tightening windows at quota
platform/wiki.mjs         pages, revisions, backlinks (linkSlug), review queue
platform/server.mjs       HTTP API for all of the above; hashed API keys; --fixtures --create-key
platform/schema.sql       Postgres 16 + pgvector production shape (HNSW, RLS, retention views)
platform/fixtures.mjs     deterministic demo content so a cold machine can be shown real behaviour
deploy/                   install.sh verify.sh package.sh local.sh nginx.conf.tmpl ollama.service
                          cloud-init.yaml docker-compose*.yml Makefile README.md
deploy/coolify/           install-coolify.sh + docker-compose.yml  ← path A
Dockerfile .dockerignore  one image, two roles (app tier by default, platform via command override)
tests/                    smoke.mjs gateway.mjs platform.mjs deploy.mjs mock-ollama.mjs
docs/DATA-PLATFORM.md     the design document and the capacity arithmetic
handover/                 this pack
```

## 3. Invariants — break one and a test should fail

| Invariant | Where |
|---|---|
| Retrieval is hybrid and ranked by RRF, not by a single similarity score | `platform/retrieve.mjs` |
| RAM and disk provisioning are ≥ 2× the computed working set | `capacityPlan()` in `platform/config.mjs` |
| Nothing is demoted to SharePoint until the mirror copy is verified | `platform/sharepoint.mjs` → `verifyMirror()` |
| Reading a document in retrieval does **not** reset the 60-day clock; opening it does | `platform/lifecycle.mjs` |
| Cold documents keep a discoverable stub and a rehydrate path that reports drift | `platform/lifecycle.mjs` |
| Empty ACL defaults to vertical-scoped with public denied (never world-readable) | `platform/store.mjs` → `putDocument` |
| Reader principals are `vertical:<id>` — not `group:vertical:<id>` | `platform/config.mjs` |
| API keys are stored hashed; scopes and per-app rate limits are enforced at the edge | `platform/server.mjs` |
| `reviewBy` is an ISO **string** everywhere it is written | `platform/wiki.mjs`, `platform/fixtures.mjs` |
| Wikilinks are slugified **per path segment** so `vertical/slug` keeps its slash | `platform/wiki.mjs` → `linkSlug()` |
| The tarball is byte-reproducible (source date, not wall clock) | `deploy/package.sh` |
| The app is reachable only through its own origin | `server.js` |

## 4. Commands

```bash
# development / demo (no Docker, no GPU, no downloads)
bash deploy/local.sh --mock --platform --fixtures --host 0.0.0.0 --port 8080
#   → prints a demo API key in its banner; Ctrl-C stops all three processes

# individual tiers
node server.js                                  # app tier, :8080
node platform/server.mjs --port 8090            # data platform
node platform/server.mjs --fixtures             # + deterministic demo content
node tests/mock-ollama.mjs 11500                # mock model host

# tests (dev dependencies only: js-yaml, jsdom, fake-indexeddb)
npm install && npm test
npm run test:platform                           # one suite

# bare-metal provisioning (path B)
bash deploy/install.sh --dry-run --yes                       # print the plan
bash deploy/install.sh --domain grid.example.com --email you@example.com \
     --platform --gpu auto --tls letsencrypt --auth basic     # do it
bash deploy/install.sh --render-only --out /tmp/render       # just write the files
bash deploy/verify.sh --url https://grid.example.com --expect-tls --platform --json

# Coolify (path A)
sudo bash deploy/coolify/install-coolify.sh --dry-run
sudo bash deploy/coolify/install-coolify.sh --email you@example.com --username kami
sudo bash deploy/coolify/install-coolify.sh --upgrade         # force latest
sudo bash deploy/coolify/install-coolify.sh --check-only      # host checks, no changes

# Docker (any host with a daemon)
docker build -t grid-os-sovereign .
docker run --rm -p 8080:8080 grid-os-sovereign
docker compose -f deploy/coolify/docker-compose.yml up -d     # full stack by hand
docker compose -f deploy/coolify/docker-compose.yml --profile pgvector up -d

# offline delivery
bash deploy/package.sh --out dist --version 1.0.0
```

## 5. API surface you will verify against

All platform routes are below `/platform` when reached through the app tier (the proxy strips the
prefix); on the platform port itself they start at `/`.

```
GET  /healthz                 public. ok, platform, version, backend, embedder, dims, liveGB,
                              ceilingGB, documents, chunks, verticals, sharePoint, fixtureContent
GET  /v1/meta                 any valid key. apps, scopes, verticals, tiers, storage, this key's
                              own scopes/verticals/ratePerMin, capacity headroom, quota total
POST /v1/search               scope search. {query, k?, verticals?, tiers?, includeCold?, readers?,
                              context?, maxContextTokens?} → {hits, citations, cold, context,
                              metrics}. appId comes from the KEY, never the body. `k`, not `topK`.
GET  /v1/documents            scope read. ?vertical=&tier=&q=
POST /v1/documents            scope ingest. {content, vertical, title?, acl?, …} →
                              201 {accepted:true, document, chunks, quota}
                              or 422 {accepted:false, reasons, warnings}
GET  /v1/documents/:id        scope read. READING IS OPENING — it resets the retention clock.
                              A cold document returns no chunks and rehydratable:true.
POST /v1/documents/:id/open   resets the clock explicitly; returns retentionClockResetDays
POST /v1/documents/:id/rehydrate   pulls content back from SharePoint and re-indexes it
GET  /v1/wiki/pages           scope read. ?vertical=&q=
GET|PUT /v1/wiki/pages/:slug  slug is `vertical/page`; PUT writes a new revision
GET  /v1/wiki/pages/:slug/diff   ?to=&from=
GET  /v1/wiki/search          scope search. ?q=&vertical=&limit=
GET  /v1/wiki/reviews         scope read. ?days=30 — the review queue
GET  /v1/admin/capacity       scope admin. capacityPlan(): headroom and chunk arithmetic
GET  /v1/admin/quota          scope admin. per-vertical quota rows + totals
GET  /v1/admin/audit          scope admin. ?action=&vertical=&docId=&limit=
POST /v1/admin/lifecycle/sweep    scope admin. demote what is due (mirror verified first)
POST /v1/admin/lifecycle/enforce  scope admin. enforce the 20 GB ceiling
POST /v1/admin/mirror/sync    scope admin. inbound sync from SharePoint
POST /v1/admin/wiki/mirror    scope admin. mirror wiki pages
POST /gateway/chat/completions    app tier → Ollama, same origin, streaming
```

Auth: `Authorization: Bearer ka_...` (created with `node platform/server.mjs --create-key` or
`--fixtures`). The key is hashed at rest; its scopes and verticals decide what a request can see.
An empty-ACL document is private to its vertical by default.

Two deliberate behaviours worth knowing before you "fix" them:

- Out-of-vertical or unreadable documents answer **404, not 403** — a 403 would leak existence.
- Searching never resets the retention clock; **reading or opening** does. That is the whole point of
  the 60-day rule: retrieving a document is not the same as somebody using it.

## 6. Traps that already cost this project time

**Architecture traps (all fixed; do not reintroduce):**
1. `platform.embedder = x` does not reach the routes — use `setEmbedder()`.
2. Documents with an empty ACL used to be readable by any app — `putDocument` now vertical-scopes
   the default and denies public.
3. `deploy/package.sh` used wall-clock timestamps, which broke byte-reproducibility — it now uses a
   source date.
4. Slug-shaped wikilinks (`vertical/slug`) were destroyed by whole-string `slugify()` — use
   `linkSlug()`, which normalises per path segment. Before the fix: 0 backlinks. After: 9.
5. A numeric `reviewBy` made `Date.parse()` return NaN and silently dropped the page from the review
   queue — write ISO strings; `reviewQueue()` now coerces numbers and skips unparseable values.

**API-shape traps:**
6. `createPlatform()` has **no** `retrieve` method. Retrieval is `search(store, embedder, params)`
   from `platform/retrieve.mjs`, returning `{hits, citations, cold, context, metrics}` — and
   `context` is an **object**, not a string.
7. The offline embedder is `new HashEmbedder()`. `createEmbedder({provider:'hash'})` and
   `createPlatform({embedder:'hash'})` are **not** valid.
8. Store methods are `listDocuments`, `getDocument`, `markOpened`, `canRead`, `putDocument`,
   `daysSinceOpened`, `scanChunks({verticals,tiers,readers,appId,limit})`, `chunksFor(id)`,
   `auditLog({action})`. There is no `setMeta`/`setLastOpened`; `lastOpenedAt` is ISO.
9. `createPage()` returns `{ok, page}`. Omit `acl` for the production default; a malformed `acl`
   makes the page private to everyone.
10. Ingest needs ≥ ~40 tokens or you get `{accepted:false, reasons}` — that is the admission rule
    working, not a bug.
11. Fixture cold-tier test order matters: `sharePoint.seed()` first, then `sharePoint.getItem(id)`.
    Calling `ingest()` directly leaves `mirrorState:"pending"`, and invented item ids fail
    `verifyMirror()`.
12. Reader principals are `vertical:<id>`, not `group:vertical:<id>`.

**Environment traps:**
13. jsdom fires `DOMContentLoaded` twice — boot guards are required in the front-end code.
14. A killed `local.sh` can leave `node platform/server.mjs`, `mock-ollama.mjs` or `server.js`
    holding a port. The app proxy then silently talks to the **old** platform with the **old** key
    and you get a mysterious 401. Kill leftovers by pid before re-running, and give test ports
    margin (the platform test port is 8299). **Never** `pkill -f local.sh` — it matches your own
    command line.
15. Asserting "no `.data/` in the checkout" is a wrong test: `local.sh --platform` writes
    `.data/platform` **by design** (gitignored). Assert the gitignore and temp-dir isolation instead.
16. A sandbox or CI runner often has no Docker, no GPU, no root and no egress to
    `registry.ollama.ai` / `cdn.coollabs.io`. Do not report an install as failed because of that —
    report it as **not executable in this environment** and hand the operator the exact command.

## 7. Definition of done

Run `handover/ACCEPTANCE.md` in full. You are done when:

- [ ] `npm test` is green and you have pasted the pass/fail counts.
- [ ] The chosen path is installed and `deploy/verify.sh` (or the ACCEPTANCE curl set) passes
      against the **real** URL the operator will use.
- [ ] The operator can open the URL from their laptop and chat with a model.
- [ ] `/platform/healthz` reports the embedder actually in use (`nomic-embed-text`, not the
      hashing fallback) once models are pulled — or you have said plainly that weights are missing.
- [ ] Internal ports are not published (`ss -ltnp` on the host shows only 80/443/8000 or 8080).
- [ ] Nothing secret was committed, and `.data/` is not in the diff.
- [ ] Anything you could not verify is listed explicitly, with the reason and the command that would
      verify it. "I could not test TLS because no domain is pointed at the host yet" is a good
      report. Silence about it is not.

## 8. Reporting back

Report in this shape — the operator asked for reports, not narrative:

```
PATH TAKEN:            A / B / C, host, Coolify version
COMMANDS RUN:          exact lines
TEST SUITE:            <n> passed / <n> failed per suite
PUBLIC URL:            https://… (reachable from laptop: yes/no + evidence)
INTERNAL PORTS:        published? (evidence)
MODELS:                pulled? which? embedder reported by /healthz
NOT WIRED (unchanged): Postgres adapter, GraphSharePoint, TLS — as STATUS.md §2
BLOCKED ON OPERATOR:   domain / credentials / hardware / sudo
```
