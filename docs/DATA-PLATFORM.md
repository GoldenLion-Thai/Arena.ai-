# KiNETiC-Ai — the unified data platform

**One knowledge substrate, shared by every app and every business vertical.**

KiNETiC-Ai is the data tier behind GRiD-OS-SOVEREIGN: real retrieval with real
citations, one wiki, one retention policy, one SharePoint mirror, and one set of
capacity numbers. It is the answer to "the RAG in this repo is illustrative" —
it is not illustrative now, and where something is still not wired, this document
says so in plain words rather than implying it.

Everything below is backed by code in `platform/` and by tests you can run:

```bash
npm install
npm test                 # 859 assertions: smoke + gateway + platform + deploy
npm run test:platform    # 299 — the platform assertions on their own
```

---

## 1. The brief, and where each requirement is enforced

| Requirement | Where it lives | Proven by |
| --- | --- | --- |
| Real RAG — vector + lexical retrieval with citations | `platform/embeddings.mjs`, `platform/retrieve.mjs` | "hybrid retrieval finds exact identifiers", citation-contract tests |
| One database shared by every app | `platform/store.mjs`, `platform/server.mjs`, `platform/schema.sql` | API tests: five apps, scoped keys, one store |
| A wiki, organised | `platform/wiki.mjs`, `wiki.html`, `assets/js/wiki.js` | wiki section (revisions, backlinks, reviews, mirror) + 97 UI assertions |
| Double headroom everywhere | `platform/config.mjs` → `capacityPlan()` | "storage headroom is at least 2×", RAM and connection headroom tests |
| SharePoint as a mirror | `platform/sharepoint.mjs` | inbound sync, outbound mirror, `verifyMirror` tests |
| 50 GB per VPS node | `STORAGE.nodeVolumeGB`, `volumePerformance()` | "a 50 GB volume at 10 VPU is throughput-limited" |
| 20 GB of live data overall | `STORAGE.liveCeilingGB`, `enforceCeiling()` | "the ceiling is held", quota sums exactly to 20 GB |
| Only live, production, useful data | `ADMISSION`, `admission()` in `platform/ingest.mjs` | drafts, personal files, duplicates, stale and over-quota content refused |
| 60 days unopened → back to SharePoint, reopenable | `TIERS`, `platform/lifecycle.mjs` | demotion, discovery, drift detection, rehydration tests |
| Shared across every vertical | `VERTICALS` (7), quotas summing to the ceiling | "the vertical quotas sum to the live ceiling exactly" |
| Branded KiNETiC-Ai | `PLATFORM.name` in `platform/config.mjs` | health/meta responses, schema comments, UI |

---

## 2. Capacity is arithmetic, not adjectives

Every number here is computed by `capacityPlan()` in `platform/config.mjs` and
asserted by the test suite. The same constants live in `platform/schema.sql`
(`platform.capacity_constants`), and a test parses the SQL to confirm the two
agree — so the schema cannot drift from the code that runs.

### 2.1 What one chunk costs

768-dimensional vectors (`nomic-embed-text`), HNSW `m = 16`, 400-token chunks:

| Component | Bytes | Why |
| --- | --- | --- |
| vector column | 3,080 | 768 × 4 (float32) + 8-byte varlena header |
| HNSW index | 4,243 | (768×4 + 16×3×4) × 1.3 for page overhead |
| chunk text | 1,103 | 400 tokens × 4 chars ÷ 1.45, TOAST-compressed |
| full-text index | 800 | `tsvector` + GIN posting lists |
| row and metadata | 1,000 | heap tuple, item id, per-row overhead |
| **planning total** | **10,226** | what one chunk really costs on disk and in RAM |

A cold stub — title, summary, one summary vector, a SharePoint pointer — costs
**4,280 B** (1,200 B of metadata + a 3,080 B vector column). Archived content is
not free, which is why it is kept small rather than kept hidden.

### 2.2 What fits inside the ceiling

| Measure | Value |
| --- | --- |
| live ceiling (all verticals) | **20 GB** |
| usable for chunks after a 15% reserve | 17 GB |
| chunks that fit | **1,785,019** |
| tokens that fit | ≈ **714 M** |
| equivalent long documents (150 chunks) | ≈ 11,900 |
| equivalent short documents (10 chunks) | ≈ 178,500 |
| HNSW index at that size | **7.05 GB** |
| heap at that size | **9.95 GB** |
| working set | 10.53 GB |
| **RAM recommended (2× policy)** | **22 GB** |
| `maintenance_work_mem` for index builds | 3 GB |

The 15% reserve is not padding: wiki pages, the audit log, cold stubs and normal
growth all live inside the same 20 GB.

### 2.3 Storage, and the headroom rule

| Measure | Value |
| --- | --- |
| per-node block volume | **50 GB** |
| nodes (primary + replica) | 2 |
| provisioned | 100 GB |
| live ceiling | 20 GB |
| **headroom** | **2.5×** (policy: ≥ 2.0×) |

**Double headroom is a policy with a number attached.** `capacityPlan()` returns
`headroomOk: false` if provisioned ÷ wanted ever drops below 2, and the test
suite fails the build when it does. The same rule is applied to RAM (22 GB for a
10.53 GB working set) and to database connections (100 `max_connections` for 48
pooled: 6 app pools × 8, i.e. 2.08×).

A 50 GB OCI volume at 10 VPU (Balanced) gives **3,000 IOPS and ~23 MB/s**. That
is throughput-limited, and it is the reason the design keeps the working set
resident in RAM instead of assuming it can scan: at 23 MB/s, reading the whole
17 GB heap once would take twelve minutes. Retrieval is budgeted at **350 ms
p95** (`OBSERVABILITY.targets.retrievalP95Ms`) and every search reports whether
it met that budget.

### 2.4 Verticals and quotas

Seven verticals, quotas summing to **exactly** the 20 GB ceiling — asserted, not
intended:

| Vertical | Quota | Sensitivity | SharePoint site |
| --- | --- | --- | --- |
| Legal | 5.0 GB | high | `site-legal` |
| Finance | 4.0 GB | high | `site-finance` |
| Consulting | 4.0 GB | high | `site-consulting` |
| Compliance | 3.0 GB | critical | `site-compliance` |
| Operations | 2.0 GB | medium | `site-operations` |
| People | 1.5 GB | critical | `site-people` |
| Shared (company + wiki) | 0.5 GB | medium | `site-company` |

A vertical that reaches 80% of its quota warns (`QUOTA.warnAtPct`); one that
would exceed it is refused at ingest (`QUOTA.rejectOnExceed`) rather than
silently shrinking everyone else's headroom.

---

## 3. Only live, production, useful data

"Useful" is a policy, and the policy is code: `ADMISSION` in `platform/config.mjs`,
applied by `admission()` in `platform/ingest.mjs`. Every refusal returns reasons,
and every refusal is audited.

Refused at the door:

- **drafts and templates** — `DRAFT`, `TEMPLATE`, `DO NOT CITE` in the title or path
- **personal sites and personal files** — `personal` in the path, or the item flagged personal
- **training and evaluation corpora** — they are not production knowledge
- **content older than 2,555 days** (7 years) unless explicitly retained
- **duplicates** — the same content hash in the same vertical updates in place
- **too short to be useful** — under 40 tokens for a document, under 8 for a wiki
  page (a twelve-token definition is exactly what an answer sometimes needs)
- **a content type nobody defined** — `document`, `wiki`, `runbook`, `policy`,
  `contract`, `report`, `email-thread`
- **anything that would push its vertical over quota**
- **anything without a SharePoint identity** when the source is SharePoint
  (`ADMISSION.requireSharePointId`) — if it cannot be put back, it does not come in

PII is flagged for review rather than blocked (`pii.action`), because blocking
silently is how knowledge disappears.

---

## 4. Retrieval

Hybrid, in this order, and every step is testable:

1. **Dense** — the query is embedded locally (Ollama `nomic-embed-text`, 768d, or
   a deterministic hashing embedder when no model host is reachable) and matched
   by cosine over an HNSW index.
2. **Lexical** — BM25 over the chunk text. Identifiers survive: the tokeniser
   keeps `14.2`, `FCA-2024-118` and `MSA-2024/07` intact, because shredding them
   on punctuation makes the exact reference a lawyer searches for unfindable.
3. **Fusion** — reciprocal rank fusion at k = 60, so a chunk both legs like wins.
4. **Diversity** — at most 3 chunks per document in the top k, so one long
   contract cannot crowd out the rest of the estate.

Measured on the fixtures: **3/3 exact identifiers ranked the right document
first**. The offline hashing embedder is lexical by nature, so this comparison
understates what a neural model adds; the number is reported rather than
dressed up.

### 4.1 Authorisation happens in the candidate query

This is the invariant that matters most. `store.scanChunks()` filters by vertical,
tier and ACL **before** anything is ranked, and `schema.sql` does the same with
row level security on `rag.chunks`. There is no post-filter step to forget.

- Default deny. An app call with no principal context sees nothing (`can_read`
  returns false when `kinetic.verticals` is unset); only the internal role — which
  the application role deliberately is not a member of — can bypass RLS.
- Permissions are inherited from the SharePoint item and **never widen**. A
  sharing link does not make something public; an empty grant list denies.
- A key scoped to `compliance` asking for `legal` gets an empty scope, not a 403:
  the platform does not confirm that legal content exists.
- Content that arrives **with** grants (a SharePoint item's mapped permissions, a
  wiki page's vertical group) keeps them exactly — `putDocument()` never adds to
  an explicit ACL. Content that arrives with **none** (an upload, an API ingest, a
  fixture) defaults to `groups: ["vertical:<id>"]` with `denyPublic: true`, so it
  is readable by keys granted that vertical and by nobody else. The earlier
  default was empty readers *and* empty groups, which made `can_read()` fall
  through to "any app-scoped key may read it": confidential content was
  effectively cross-app readable inside the platform while the vertical grant that
  should have covered it was ignored. `tests/platform.mjs` asserts both halves.

### 4.2 The citation contract

A citation states only what is known:

- a page number **only if the source supplied one**
- `tier: "cold"` and the reason, when the content is archived
- the SharePoint `webUrl` and item id when there is one
- `checksum: sha256:<first 16>` so a reader can verify what was quoted
- sensitivity, and a `restricted` marker for `critical` verticals

Archived content is **discovered, not dropped**: a cold match comes back with
"not opened for 71 days — reverted to SharePoint" and a link to reopen the path.
An answer that silently omits an archived source is a wrong answer with good
manners.

---

## 5. The 60-day rule

> Data nobody has opened for 60 days defaults back to SharePoint. If it is needed
> again, the path reopens.

Implemented in `platform/lifecycle.mjs`, enforced in `schema.sql`:

1. **Retrieval does not reset the clock.** Only `markOpened()` does — an explicit
   open, a read of the document, or a rehydration. A search that cited a document
   is not the same as somebody using it, and the tests assert the difference.
2. **Nothing is demoted without a verified mirror.** `verifyMirror()` compares the
   content hash *and* the eTag/version against SharePoint. If verification fails,
   the demotion is skipped, audited and reported — **the platform never deletes
   the only copy**. In SQL, `platform.demote_to_cold()` raises if it is told the
   mirror is not verified.
3. **Demotion keeps a discoverable stub**: title, summary, one summary vector, the
   SharePoint pointer, the reason, and the date. ~4.3 KB instead of ~1.5 MB.
4. **The window adapts to pressure**: 60 days normally, 30 at 90% of a vertical's
   quota, 14 at 97%. Under pressure the platform gets strict rather than getting
   slow, and the report says which window was in force.
5. **Reopening the path** pulls the content from SharePoint — the system of
   record, not our cached text — re-embeds it, and re-indexes it. If the source
   changed while it was archived, the drift is reported rather than hidden.
6. **The ceiling is enforced** by demoting least-recently-opened, mirror-verified
   documents until live bytes are back under 20 GB. Enforcement is audited.

---

## 6. SharePoint: mirror and cold tier

Two directions, one rule.

- **Inbound** — SharePoint is the system of record. A delta query every 15
  minutes (`SHAREPOINT.deltaIntervalMs`) pulls new and changed items from the
  `Knowledge` libraries; each item is admitted, chunked, embedded and indexed
  with the permissions it carried.
- **Outbound** — platform-born content (wiki pages, summaries, annotations) is
  written to the `KiNETiC-Ai Mirror` library, so nothing exists only here.

`GraphSharePoint` is real code against the documented Graph endpoints; it cannot
be exercised without a tenant, so the tests and the offline demo run against
`MockSharePoint`, which is faithful to the same contract (delta tokens, eTags,
version ids, permission grants, mirror verification).

Permissions are mapped by `mapPermissions()` and can only ever be as narrow as
the source: users → `sp:<id>`, groups → `sp:group:<id>`, applications →
`app:<id>`, and a site-level group grant additionally implies membership of that
vertical (`vertical:<id>`), which is the coarse grant the ACL checks. Sharing
links never widen access; anonymous access is only possible if explicitly
allowed.

---

## 7. The wiki

Organised by vertical, addressable by slug (`legal/indemnity-policy`), and
indexed into RAG so a page is citable in an answer next to a contract.

- **Immutable revisions.** An edit creates revision N+1; the previous text stays
  readable and diffable. `wiki.revisions` in `schema.sql` refuses UPDATE and
  DELETE by trigger *and* by grant — history here cannot be rewritten.
- **Links and backlinks.** `[[slug]]`, `[text](wiki:slug)` and a bare `/wiki/slug`
  in prose are all links, and the graph is stored in both directions.
- **Front matter.** `owner`, `review-by`, `tags`, `status` — parsed out of the
  body, never mixed into it.
- **Review dates.** Nothing is trusted forever. Overdue pages are surfaced in a
  queue rather than quietly believed; the UI flags them.
- **Mirrored out.** Pages go back to SharePoint, and the mirror state is recorded.
- **Admission applies** with a lower token floor (8 rather than 40), because a
  definition can be a dozen tokens and still be exactly what an answer needs.

The browser UI (`wiki.html` + `assets/js/wiki.js`) talks to the platform over the
**same origin** — `server.js` proxies `/platform/*` — so the browser makes no
cross-origin request and no third party sees your knowledge. It holds the API key
in `sessionStorage`, never `localStorage`, and it renders **nothing** when the
platform is down: no sample pages, no illustrative numbers, just the command that
fixes it.

---

## 8. One platform, every app

Five registered apps in `APPS`, each with declared scopes and verticals. A key
inherits its app's declared scopes and cannot exceed them silently.

| App | Scopes | Verticals | Rate |
| --- | --- | --- | --- |
| `grid-os-sovereign` (the workspace) | search, read, wiki | all | 240/min |
| `kinetic-wiki` | search, read, wiki, ingest | all | 240/min |
| `behaviour-lab` | search, read | shared | 60/min |
| `intake-automation` | ingest, read | legal, consulting | 120/min |
| `compliance-monitor` | search, read | compliance, legal | 60/min |

Scopes: `search`, `read`, `ingest`, `wiki`, `admin`. Rate limiting is a sliding
window per key (60 s, default 120/min, burst 20).

### API surface

```
GET    /healthz                          open — liveness and the live/ceiling position
GET    /v1/meta                          any valid key — what this key may do
POST   /v1/search                        search scope — hybrid retrieval + citations + context block
GET    /v1/documents                     read — list, scoped to the key's verticals
POST   /v1/documents                     ingest — admission policy applied, quota reported
GET    /v1/documents/:id                 read — marks the document opened (resets the clock)
POST   /v1/documents/:id/open            read — explicit open
POST   /v1/documents/:id/rehydrate       read — reopen the path from SharePoint
GET    /v1/wiki/pages                    read — list, scoped
POST   /v1/wiki/pages                    wiki — create
GET    /v1/wiki/pages/:slug              read — page + revision list + stats
PUT    /v1/wiki/pages/:slug              wiki — new revision
GET    /v1/wiki/pages/:slug/diff         read — line diff between two revisions
GET    /v1/wiki/search                   search — title, slug, tags, body
GET    /v1/wiki/stats                    read — coverage numbers for this key's scope
GET    /v1/wiki/reviews                  read — the review queue
GET    /v1/admin/capacity                admin — plan vs actual, presentable table
GET    /v1/admin/quota                   admin — per-vertical usage and window in force
GET    /v1/admin/audit                   admin — the audit log
POST   /v1/admin/lifecycle/sweep         admin — demote (or dry-run)
POST   /v1/admin/lifecycle/enforce       admin — hold the ceiling
POST   /v1/admin/mirror/sync             admin — SharePoint delta sync
POST   /v1/admin/wiki/mirror             admin — mirror pages back out
```

Wiki slugs contain `/`, so a client may send `finance/billing-cadence` or
`finance%2Fbilling-cadence`; both route to the same page. A path that decodes to
something containing `..` is refused.

Authentication is `Authorization: Bearer ka_…`. The secret is returned once at
creation and only its SHA-256 hash is stored. Every write is audited.

---

## 9. Production shape: Postgres 16 + pgvector

`platform/schema.sql` is the production schema: four schemas (`rag`, `wiki`,
`platform`, `audit`), 11 tables, 20 functions and views, 14 RLS policies,
18 indexes. It encodes the same invariants the Node code enforces:

- HNSW on `vector(768)` with `m = 16, ef_construction = 128`; `hnsw.ef_search = 100`
- a **generated** `tsvector` column, so the lexical leg cannot drift from the text
- a trigger that refuses a non-normalised vector on write
- `rag.search_hybrid()` — vector + lexical + RRF + per-document diversity, with
  RLS evaluated inside the candidate CTEs
- `rag.cold_candidates` — needs a SharePoint pointer *and* a mirrored state
- `platform.demote_to_cold()` — raises without a verified mirror
- `platform.cold_window_days()` — the adaptive 60/30/14 rule
- `platform.live_usage` and `platform.capacity` — bytes counted from the rows that
  actually exist, so the quota report cannot drift from the data
- immutable wiki revisions and an append-only, monthly-partitioned audit log
- `rag.mark_opened()` and `platform.rehydrate_stub()` as `SECURITY DEFINER`
  helpers that re-check the caller's read rights, because RLS is row-level and
  cannot express "may update `last_opened_at`, may not update `acl`"

**pgvector, not Qdrant.** At 1.78 M chunks and 768 dimensions the index is
~7 GB and fits in RAM beside the heap; a second service would add an operational
boundary and a consistency problem for no gain. Move to a dedicated vector engine
beyond ~50 M vectors, or when several embedding models must be served at once.

### What is NOT wired yet

Stated plainly, because a design document that implies otherwise is the thing this
repo exists to avoid:

- The reference server (`platform/server.mjs`) persists to **JSONL on a volume**
  (`MemoryStore`). It is complete and tested — retrieval, retention, wiki, mirror,
  ACLs, audit — and it is what the tests and the demo run against.
- `schema.sql` is real, reviewed SQL, and `deploy/docker-compose.platform.yml`
  applies it on first boot under the `pgvector` profile, so you can inspect the
  tables, views and functions against a real engine today.
- **The Postgres adapter — the code that makes the server read and write those
  tables instead of the JSONL store — is the next piece of work.** Until it lands,
  `DATABASE_URL` is set in the compose file and the platform does not use it.
- `GraphSharePoint` has never met a real tenant. The mock is faithful to the
  contract; the first live sync will surface things only a tenant can teach.
- Postgres is not installed in the CI sandbox, so `schema.sql` is validated
  structurally and for parity with the code (constants, grants, policies,
  invariants) rather than executed. Applying it to a real cluster is part of the
  adapter work.

---

## 10. Deployment

```bash
# one host: app tier + platform + model host, nothing published but :8080
cd deploy && docker compose -f docker-compose.platform.yml up -d

# add the production database (applies platform/schema.sql on first boot)
cd deploy && docker compose -f docker-compose.platform.yml --profile pgvector up -d

# or install on a VPS with systemd, nginx and TLS
sudo bash deploy/install.sh --domain ai.example.com --email ops@example.com \
  --model qwen2.5:14b-instruct-q4_K_M --platform --auth admin:CHANGE_ME

# issue a key for the wiki (the secret is printed once)
node platform/server.mjs --create-key kinetic-wiki

# run the platform on its own
node platform/server.mjs --port 8090 --host 127.0.0.1 --data-dir .data/platform

# point the app origin at it, then open /wiki.html
PLATFORM_URL=http://127.0.0.1:8090 node server.js
```

`--platform` writes `/etc/kinetic-ai.env`, a hardened `kinetic-ai.service`
(loopback only, `ProtectSystem=strict`, writable only in `/var/lib/kinetic-ai`),
pulls the embedding model, and adds `PLATFORM_URL` to the app tier's environment
so `/platform/*` is proxied on the same origin. Without the flag, `/platform/*`
answers 503 with the command that starts it — the UI shows that instead of
inventing content.

Verify from outside the host: `nc -vz <host> 8090` and `nc -vz <host> 11434` must
both fail. Only 443/80 (and 22) are reachable. `deploy/verify.sh` checks that from
the outside when you pass `--public-host`, and checks the data tier from the inside
when you pass `--platform`: it reads the platform's own health numbers through the
app origin, proves `/v1/meta` returns 401 without a key, confirms `/wiki.html` is
served, and reports — as a warning, not a pass — whether the store holds fixture
content or is still embedding with the offline fallback.

### Demos and fixture content

```bash
npm run local:demo        # app + data tier + sample content, one command, no downloads
bash deploy/local.sh --platform                 # the data tier, no sample content
node platform/server.mjs --data-dir .data/platform --fixtures
```

`--fixtures` seeds six documents across six verticals and five wiki pages so a demo
is not an empty room. It seeds through the real code paths only: the source items
are placed in SharePoint first, then `ingest()` applies admission, chunking and
embedding; `createPage()` writes the wiki; and `sweep()` demotes one document past
the 60-day rule after its mirror verifies — so the archived-match path, the
rehydrate path and the review queue are all reachable in a fresh install.

Everything it creates is labelled, and the label is derived from what is stored
rather than from a flag nobody reads: `sourceKind: "fixture"`, a `fixture` tag on
every page, a `/fixtures/` SharePoint path, and `fixtureContent: true` on
`/healthz`. The wiki prints that in its state panel; `verify.sh` warns about it;
`tests/platform.mjs` asserts the notice says plainly that this is not a live
corpus.

---

## 11. Operations

| Job | Cadence | What it does |
| --- | --- | --- |
| SharePoint delta sync | 15 min | pulls new/changed items, admits and indexes them |
| retention sweep | nightly | demotes what nobody opened, only with a verified mirror |
| ceiling enforcement | nightly, after the sweep | holds live bytes under 20 GB |
| wiki mirror | after writes | pushes platform-born pages back out |
| review queue | weekly | surfaces pages past their review date |
| quota report | weekly | per-vertical usage, pressure, window in force |
| audit partitions | monthly | `audit.ensure_partition()` |

Watch `quota_pct` per vertical (warn at 80%), `retrieval_ms` p95 against the
350 ms budget, `cold_demotions` and `rehydrations` (a high rehydration rate means
the window is too aggressive for that vertical), and HNSW build time after a large
ingest — raise `maintenance_work_mem` to 3 GB for the session that builds.

Backups: `pg_dump` nightly plus volume snapshots. SharePoint remains the system
of record for source documents, so **RPO is 15 minutes** (the delta interval) and
**RTO is about an hour** (restore, re-sync, re-embed only what changed).

---

## 12. Branding and renaming

The platform brand is one constant: `PLATFORM.name` in `platform/config.mjs`.
The product wordmark is another: `NAME` in `assets/js/brand.js`. Changing either
propagates to the API responses, the UI, the page titles and the schema comments.
If KiNETiC-Ai is meant to become the master brand rather than the platform brand,
that is a one-line change plus the `TITLES` map — not a refactor.

---

## 13. Testing

```bash
npm test                 # every suite
npm run test:platform    # tests/platform.mjs  — the platform on its own
npm run test:smoke       # tests/smoke.mjs     — pages and UI, including the wiki
npm run test:gateway     # tests/gateway.mjs   — the model gateway and the proxy
npm run test:deploy      # tests/deploy.mjs    — installer, packager, compose, terraform, CI
```

The files that carry the proof:

| File | What it proves |
| --- | --- |
| `tests/platform.mjs` | capacity arithmetic, embeddings, chunking, admission, ingestion, retrieval and the citation contract, retention and rehydration, the wiki, the HTTP API, permissions, persistence, the same-origin proxy, and parity between `platform/schema.sql` and `platform/config.mjs` |
| `tests/smoke.mjs` (`testWiki`) | the wiki page in jsdom against a fake platform that answers the shapes `platform/server.mjs` returns |
| `tests/mock-ollama.mjs` | a model host that serves `/api/embed`, `/api/embeddings` and `/v1/embeddings`, so embeddings are exercised without a GPU |
| `tests/deploy.mjs` | `install.sh --platform`, the platform compose file, and the documentation claims |

The platform suite covers, in order: capacity arithmetic, embeddings, chunking,
admission, ingestion and dedupe, retrieval and the citation contract, retention
and rehydration, the wiki, the HTTP API, permissions, persistence across a
restart, the same-origin proxy, and parity between `schema.sql` and the code.

The wiki UI tests drive the real page in jsdom against a fake platform that
answers the shapes `platform/server.mjs` returns, and assert what the UI *claims*:
that it renders nothing when the platform is down, that a refused key is reported,
that a read-only key is not offered write actions, that citations state a page
only when the source gave one, that archived content is surfaced with the way back
in, and that the key lives in `sessionStorage` and never in `localStorage`.
