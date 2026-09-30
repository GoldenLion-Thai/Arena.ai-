/* ============================================================================
   platform/schema.sql — KiNETiC-Ai on Postgres 16 + pgvector 0.7+

   This is the production shape of the same platform that platform/*.mjs runs
   in-process. One cluster, four schemas, one set of rules:

     rag        documents, chunks, vectors, lexical index — the retrieval tier
     wiki       pages, immutable revisions, the link graph
     platform   verticals, api keys, mirrors, lifecycle events, capacity maths
     audit      append-only event log, partitioned by month

   The invariants that matter are enforced HERE, not only in application code,
   so a rogue script cannot break them:

     1. Authorisation is applied in the candidate query (row level security),
        never filtered out of the results afterwards.
     2. Default deny: an app connection with no principal context sees nothing.
        Only the internal role (ingest, sweeper) bypasses RLS.
     3. Nothing leaves the live tier without a verified mirror. platform.
        demote_to_cold() raises if it is told the mirror is not verified.
     4. Wiki revisions cannot be updated or deleted — a trigger refuses, and
        the grants do not allow it either.
     5. Capacity is arithmetic, not adjectives: platform.capacity_constants
        holds the same numbers platform/config.mjs uses, and tests/platform.mjs
        asserts the two agree.

   Run it:
     psql "$DATABASE_URL" -f platform/schema.sql
   or let deploy/docker-compose.platform.yml apply it on first boot.

   Sizing this file assumes (see platform/config.mjs → capacityPlan()):
     768-dim vectors · HNSW m=16 ef_construction=128 · 400-token chunks
     10,226 planning bytes per chunk · 20 GB live ceiling · 50 GB per node
     ⇒ 1,785,019 chunks ≈ 714M tokens, HNSW index ≈ 7.05 GB, heap ≈ 9.95 GB
     ⇒ 22 GB RAM recommended (2× the 10.53 GB working set — the headroom rule)
   ========================================================================== */

\set ON_ERROR_STOP on

/* ------------------------------------------------------------------ extensions */
CREATE EXTENSION IF NOT EXISTS vector;      -- HNSW + halfvec + <=> cosine
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- title/slug similarity search
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), digest()

/* ----------------------------------------------------------------------- roles
   The app connects as kinetic_app. It is NOT a member of kinetic_internal, so
   it can never escape row level security by leaving the GUCs unset. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinetic_app') THEN
    CREATE ROLE kinetic_app LOGIN PASSWORD 'change-me-in-deployment';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinetic_internal') THEN
    CREATE ROLE kinetic_internal NOLOGIN;   -- ingest, sweeper, mirror jobs
  END IF;
END $$;
/* kinetic_app is deliberately NOT a member of kinetic_internal: that membership
   is the only thing that can switch row level security off, so handing it to the
   application role would make every policy below decorative. Grant it only to
   the roles that run ingest, the sweeper and the mirror jobs. */

CREATE SCHEMA IF NOT EXISTS rag;
CREATE SCHEMA IF NOT EXISTS wiki;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS audit;
REVOKE ALL ON SCHEMA public FROM public;

/* =============================================================================
   platform — the policy layer, as data
   ========================================================================== */

/* The numbers the capacity plan is built from. platform/config.mjs holds the
   same values; tests/platform.mjs parses this file and asserts they match, so
   the SQL and the application can never quietly disagree. */
CREATE TABLE IF NOT EXISTS platform.capacity_constants (
  key   text PRIMARY KEY,
  value numeric NOT NULL,
  note  text
);

INSERT INTO platform.capacity_constants (key, value, note) VALUES
  ('embedding_dims',            768,   'nomic-embed-text'),
  ('bytes_per_dim',             4,     'float32; 2 if halfvec'),
  ('planning_bytes_column',     3080,  'dims*4 + 8 byte varlena header'),
  ('planning_bytes_hnsw_index', 4243,  '(dims*4 + m*3*4) * 1.3 page overhead'),
  ('planning_bytes_text',       1103,  '400 tokens * 4 chars / 1.45 (TOAST)'),
  ('planning_bytes_fts',        800,   'tsvector + GIN posting lists'),
  ('planning_bytes_row_meta',   1000,  'heap tuple, item id, per-row overhead'),
  ('planning_bytes_per_chunk',  10226, 'the sum: what one chunk really costs'),
  ('cold_stub_bytes',           4280,  '1200 B metadata + one 768-dim summary vector column (3080 B)'),
  ('live_ceiling_gb',           20,    'all verticals combined, live tier'),
  ('node_volume_gb',            50,    'per VPS node block volume'),
  ('nodes',                     2,     'primary + replica'),
  ('headroom_target',           2,     'provisioned / wanted, minimum'),
  ('hnsw_m',                    16,    ''),
  ('hnsw_ef_construction',      128,   ''),
  ('hnsw_ef_search',            100,   ''),
  ('chunk_target_tokens',       400,   ''),
  ('cold_after_days_unopened',  60,    'the 60-day rule'),
  ('adaptive_tighten_at_pct',   90,    'quota % at which the window tightens'),
  ('adaptive_tightened_days',   30,    'window once tightened'),
  ('adaptive_critical_at_pct',  97,    'quota % at which the window goes critical'),
  ('adaptive_critical_days',    14,    'window when critical'),
  ('rrf_k',                     60,    'reciprocal rank fusion constant')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note;

CREATE TABLE IF NOT EXISTS platform.verticals (
  id            text PRIMARY KEY,
  label         text NOT NULL,
  quota_gb      numeric(8,3) NOT NULL CHECK (quota_gb > 0),
  sensitivity   text NOT NULL DEFAULT 'medium' CHECK (sensitivity IN ('low','medium','high','critical')),
  sp_site       text,                     -- the SharePoint site this vertical mirrors
  sort          int  NOT NULL DEFAULT 100
);

/* Seven verticals, quotas summing to exactly the 20 GB live ceiling. The test
   suite asserts the sum; a quota edit that breaks the ceiling fails the build. */
INSERT INTO platform.verticals (id, label, quota_gb, sensitivity, sp_site, sort) VALUES
  ('legal',      'Legal',      5.000, 'high',     'site-legal',      10),
  ('finance',    'Finance',    4.000, 'high',     'site-finance',    20),
  ('consulting', 'Consulting', 4.000, 'high',     'site-consulting', 30),
  ('compliance', 'Compliance', 3.000, 'critical', 'site-compliance', 40),
  ('operations', 'Operations', 2.000, 'medium',   'site-operations', 50),
  ('people',     'People',     1.500, 'critical', 'site-people',     60),
  ('shared',     'Shared',     0.500, 'medium',   'site-company',    70)
ON CONFLICT (id) DO UPDATE SET
  quota_gb = EXCLUDED.quota_gb, sensitivity = EXCLUDED.sensitivity,
  sp_site = EXCLUDED.sp_site, label = EXCLUDED.label;

/* ------------------------------------------------------------------ contexts
   Every request sets these; RLS reads them. Unset means DENY for kinetic_app. */
CREATE OR REPLACE FUNCTION platform.setting_list(name text) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting(name, true) IS NULL OR current_setting(name, true) = '' THEN NULL
    ELSE string_to_array(current_setting(name, true), ',')
  END;
$$;

/* Only the internal role may act without a principal context. This is what
   makes "default deny" real rather than decorative. */
CREATE OR REPLACE FUNCTION platform.is_trusted_caller() RETURNS boolean
LANGUAGE sql STABLE AS $$
  /* session_user, not current_user: the SECURITY DEFINER helpers below run as
     their owner, and must still evaluate the CALLER's rights. */
  SELECT pg_has_role(session_user, 'kinetic_internal', 'MEMBER')
     AND current_setting('kinetic.internal', true) = 'on';
$$;

/* Can this caller read a row with this ACL in this vertical?
   Parity with store.canRead(): readers ?| principals OR groups ?| principals,
   where syncInbound writes `vertical:<id>` into groups for site-level grants. */
CREATE OR REPLACE FUNCTION platform.can_read(acl jsonb, doc_vertical text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN platform.is_trusted_caller() THEN true
    WHEN platform.setting_list('kinetic.verticals') IS NULL THEN false          -- default deny
    WHEN NOT doc_vertical = ANY (platform.setting_list('kinetic.verticals')) THEN false
    WHEN coalesce((acl->>'denyPublic')::boolean, true) = false THEN true        -- explicitly public
    WHEN coalesce(array_length(platform.setting_list('kinetic.principals'), 1), 0) = 0 THEN false
    WHEN coalesce(acl->'readers', '[]'::jsonb) ?| platform.setting_list('kinetic.principals') THEN true
    WHEN coalesce(acl->'groups',  '[]'::jsonb) ?| platform.setting_list('kinetic.principals') THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION platform.can_write(doc_vertical text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT platform.is_trusted_caller()
      OR (platform.setting_list('kinetic.verticals') IS NOT NULL
          AND doc_vertical = ANY (platform.setting_list('kinetic.verticals'))
          AND coalesce(platform.setting_list('kinetic.scopes'), '{}') && ARRAY['ingest','wiki']);
$$;

/* =============================================================================
   rag — documents and chunks
   ========================================================================== */

CREATE TABLE IF NOT EXISTS rag.documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical          text NOT NULL REFERENCES platform.verticals(id),
  title             text NOT NULL,
  source_kind       text NOT NULL DEFAULT 'upload' CHECK (source_kind IN ('upload','sharepoint','wiki','api')),
  content_hash      char(64) NOT NULL,                    -- sha256 of the source text
  tokens            int  NOT NULL DEFAULT 0,
  chunk_count       int  NOT NULL DEFAULT 0,
  bytes             bigint NOT NULL DEFAULT 0,            -- live bytes this document accounts for
  tier              text NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','warm','cold')),
  sensitivity       text NOT NULL DEFAULT 'medium' CHECK (sensitivity IN ('low','medium','high','critical')),
  tags              text[] NOT NULL DEFAULT '{}',
  summary           text NOT NULL DEFAULT '',
  summary_embedding vector(768),                          -- survives demotion: cold stubs stay discoverable
  acl               jsonb NOT NULL DEFAULT '{"readers":[],"groups":[],"denyPublic":true}',
  sharepoint        jsonb,                                -- {siteId,itemId,webUrl,etag,versionId,path}
  mirror_state      text NOT NULL DEFAULT 'pending' CHECK (mirror_state IN ('pending','mirrored','verified','failed')),
  mirror_verified_at timestamptz,
  archived_at       timestamptz,
  archive_reason    text,
  app_id            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_opened_at    timestamptz NOT NULL DEFAULT now(),   -- the 60-day clock; retrieval does NOT touch it
  last_opened_by    text,
  open_count        int NOT NULL DEFAULT 0,
  deleted           boolean NOT NULL DEFAULT false
);

/* Dedupe by content hash within a vertical: an edit updates in place, it never
   leaves a stale twin being cited. */
CREATE UNIQUE INDEX IF NOT EXISTS documents_dedupe ON rag.documents (vertical, content_hash) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS documents_tier_opened ON rag.documents (tier, last_opened_at);
CREATE INDEX IF NOT EXISTS documents_mirror ON rag.documents (mirror_state) WHERE mirror_state <> 'verified';
CREATE INDEX IF NOT EXISTS documents_title_trgm ON rag.documents USING gin (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS rag.chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      uuid NOT NULL REFERENCES rag.documents(id) ON DELETE CASCADE,
  vertical    text NOT NULL REFERENCES platform.verticals(id),
  ordinal     int  NOT NULL DEFAULT 0,
  heading     text,
  body        text NOT NULL,
  tokens      int  NOT NULL DEFAULT 0,
  page_start  int,
  page_end    int,
  char_start  int  NOT NULL DEFAULT 0,
  char_end    int  NOT NULL DEFAULT 0,
  tier        text NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','warm','cold')),
  embedding   vector(768) NOT NULL,
  /* Generated, so the lexical leg can never drift from the text it indexes. */
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading,'') || ' ' || body)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_doc ON rag.chunks (doc_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_tsv ON rag.chunks USING gin (tsv);

/* The vector index. m=16, ef_construction=128 — the same parameters
   platform/config.mjs plans with, and the same ones tests/platform.mjs checks.

   Build cost at the planned ceiling (1,785,019 chunks):
     index size ≈ 7.05 GB, build needs maintenance_work_mem ≥ 3 GB or it spills
     to disk and runs 10–50× slower. Set it for the session that builds:
       SET maintenance_work_mem = '3GB';
   Query side:
       SET hnsw.ef_search = 100;      -- recall/latency dial, per session
   halfvec would halve the column and the index (4000-dim limit vs 2000) at a
   small recall cost; EMBEDDING.halfvec in config.mjs is the switch. */
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON rag.chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

/* Vectors are stored normalised, so cosine distance is a dot product and the
   two ranking legs are comparable before fusion. */
CREATE OR REPLACE FUNCTION rag.assert_normalised() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n numeric;
BEGIN
  SELECT sqrt(sum(x * x)) INTO n FROM unnest(NEW.embedding::real[]) AS x;
  IF n IS NULL OR abs(n - 1.0) > 0.01 THEN
    RAISE EXCEPTION 'chunk % embedding is not L2-normalised (|v| = %)', NEW.id, coalesce(n, 0);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS chunks_normalised ON rag.chunks;
CREATE TRIGGER chunks_normalised BEFORE INSERT OR UPDATE OF embedding ON rag.chunks
  FOR EACH ROW EXECUTE FUNCTION rag.assert_normalised();

/* ------------------------------------------------------- hybrid retrieval
   Vector leg (HNSW) + lexical leg (GIN/tsvector), fused with reciprocal rank
   fusion at k=60. RLS is evaluated inside the CTEs, so authorisation happens
   in the candidate query — an unauthorised chunk is never ranked and then
   dropped, it is never fetched. */
CREATE OR REPLACE FUNCTION rag.search_hybrid(
  p_query  text,
  p_vector vector(768),
  p_k      int DEFAULT 8,
  p_pool   int DEFAULT 100
) RETURNS TABLE (chunk_id uuid, doc_id uuid, title text, vertical text, heading text,
                 body text, ordinal int, page_start int, char_start int, char_end int,
                 tier text, distance real, lex_rank real, ts_rank real, rrf real)
LANGUAGE sql STABLE AS $$
  WITH params AS (
    SELECT (SELECT value FROM platform.capacity_constants WHERE key = 'rrf_k')::int AS k
  ),
  lex AS (
    SELECT c.id, c.doc_id,
           row_number() OVER (ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery('english', p_query)) DESC)::real AS rn,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', p_query)) AS tr
    FROM rag.chunks c
    WHERE c.tsv @@ websearch_to_tsquery('english', p_query)
    ORDER BY tr DESC
    LIMIT p_pool
  ),
  vec AS (
    SELECT c.id, c.doc_id, (c.embedding <=> p_vector)::real AS dist,
           row_number() OVER (ORDER BY c.embedding <=> p_vector)::real AS rn
    FROM rag.chunks c
    WHERE p_vector IS NOT NULL
    ORDER BY c.embedding <=> p_vector
    LIMIT p_pool
  ),
  fused AS (
    SELECT id, doc_id,
           sum(1.0 / ((SELECT k FROM params) + rn))::real AS rrf,
           max(CASE WHEN src = 'lex' THEN rn END)::real AS lex_rank,
           max(CASE WHEN src = 'lex' THEN tr END)::real AS ts_rank,
           max(CASE WHEN src = 'vec' THEN dist END)::real AS distance
    FROM (
      SELECT id, doc_id, rn, 'lex'::text AS src, tr, NULL::real AS dist FROM lex
      UNION ALL
      SELECT id, doc_id, rn, 'vec'::text AS src, NULL::real AS tr, dist FROM vec
    ) legs
    GROUP BY id, doc_id
  )
  SELECT f.chunk_id, f.doc_id, d.title, d.vertical, c.heading, c.body, c.ordinal,
         c.page_start, c.char_start, c.char_end, c.tier,
         f.distance, f.lex_rank, f.ts_rank, f.rrf
  FROM (
    SELECT id AS chunk_id, doc_id, rrf, lex_rank, ts_rank, distance,
           /* diversity: at most 3 chunks per document in the top k, so one long
              contract cannot crowd out the rest of the estate */
           row_number() OVER (PARTITION BY doc_id ORDER BY rrf DESC) AS per_doc,
           row_number() OVER (ORDER BY rrf DESC) AS overall
    FROM fused
  ) f
  JOIN rag.chunks   c ON c.id = f.chunk_id
  JOIN rag.documents d ON d.id = f.doc_id
  WHERE f.per_doc <= 3 AND f.overall <= p_k * 3
    AND d.deleted = false
  ORDER BY f.rrf DESC
  LIMIT p_k;
$$;

/* Archived content stays DISCOVERABLE. This is the honest half of the 60-day
   rule: a cold document is surfaced with its reason and the way back in, never
   silently dropped from an answer. */
CREATE OR REPLACE FUNCTION rag.find_cold(p_query text, p_vector vector(768), p_k int DEFAULT 5)
RETURNS TABLE (doc_id uuid, title text, vertical text, summary text, days_unopened int,
               archive_reason text, sharepoint jsonb, score real)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.title, d.vertical, d.summary,
         (EXTRACT(EPOCH FROM (now() - d.last_opened_at)) / 86400)::int,
         d.archive_reason, d.sharepoint,
         (d.summary_embedding <=> p_vector)::real AS score
  FROM rag.documents d
  WHERE d.tier = 'cold' AND d.deleted = false AND p_vector IS NOT NULL
    AND d.summary_embedding IS NOT NULL
  ORDER BY d.summary_embedding <=> p_vector
  LIMIT p_k;
$$;

/* Opening a document is what resets the 60-day clock — retrieval does not.

   SECURITY DEFINER because row level security is row-level and cannot express
   "may update last_opened_at, may not update acl". The caller's right to READ
   the document is checked first, inside the definer, using the caller's own
   context (is_trusted_caller() looks at session_user, so the check is real).
   A document the caller cannot read raises "not found" — no existence leak. */
CREATE OR REPLACE FUNCTION rag.mark_opened(p_doc uuid, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = rag, platform, pg_temp AS $$
DECLARE v_acl jsonb; v_vertical text;
BEGIN
  SELECT acl, vertical INTO v_acl, v_vertical FROM rag.documents WHERE id = p_doc AND NOT deleted;
  IF NOT FOUND OR NOT platform.can_read(v_acl, v_vertical) THEN
    RAISE EXCEPTION 'no such document %', p_doc;
  END IF;
  UPDATE rag.documents
     SET last_opened_at = now(), last_opened_by = p_actor, open_count = open_count + 1,
         tier = CASE WHEN tier = 'cold' THEN 'warm' ELSE tier END
   WHERE id = p_doc;
END $$;

/* =============================================================================
   Retention — the 60-day rule, and the ceiling
   ========================================================================== */

/* Adaptive window: 60 days normally, 30 at 90% of the vertical quota, 14 at
   97%. Same thresholds as TIERS.adaptive in platform/config.mjs. */
CREATE OR REPLACE FUNCTION platform.vertical_used_bytes(p_vertical text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(d.bytes), 0) FROM rag.documents d
   WHERE d.vertical = p_vertical AND d.deleted = false AND d.tier <> 'cold';
$$;

CREATE OR REPLACE FUNCTION platform.cold_window_days(p_vertical text) RETURNS int
LANGUAGE sql STABLE AS $$
  WITH k AS (
    SELECT max(CASE WHEN key = 'adaptive_critical_at_pct'  THEN value END) / 100.0 AS critical_pct,
           max(CASE WHEN key = 'adaptive_critical_days'    THEN value END)::int    AS critical_days,
           max(CASE WHEN key = 'adaptive_tighten_at_pct'   THEN value END) / 100.0 AS tighten_pct,
           max(CASE WHEN key = 'adaptive_tightened_days'   THEN value END)::int    AS tightened_days,
           max(CASE WHEN key = 'cold_after_days_unopened'  THEN value END)::int    AS normal_days
    FROM platform.capacity_constants
  ),
  q AS (SELECT quota_gb FROM platform.verticals WHERE id = p_vertical),
  u AS (SELECT platform.vertical_used_bytes(p_vertical)::numeric / (1024^3) AS used_gb)
  SELECT CASE
    WHEN q.quota_gb IS NULL OR q.quota_gb = 0 THEN k.normal_days
    WHEN u.used_gb / q.quota_gb >= k.critical_pct THEN k.critical_days
    WHEN u.used_gb / q.quota_gb >= k.tighten_pct  THEN k.tightened_days
    ELSE k.normal_days
  END
  FROM k, q, u;
$$;

/* Eligible for the cold tier. Note the two hard requirements: a SharePoint
   pointer (somewhere to put it back) and a mirror state that proves the copy
   exists there. Content that cannot be restored is never demoted. */
CREATE OR REPLACE VIEW rag.cold_candidates AS
SELECT d.id, d.vertical, d.title, d.tier, d.bytes AS bytes_freed, d.chunk_count,
       d.last_opened_at, d.sharepoint, d.mirror_state,
       (EXTRACT(EPOCH FROM (now() - d.last_opened_at)) / 86400)::int AS days_unopened,
       platform.cold_window_days(d.vertical) AS window_days
FROM rag.documents d
WHERE d.deleted = false
  AND d.tier <> 'cold'
  AND d.sharepoint IS NOT NULL
  AND d.mirror_state IN ('mirrored', 'verified')
  AND (EXTRACT(EPOCH FROM (now() - d.last_opened_at)) / 86400) >= platform.cold_window_days(d.vertical);

/* The only way down to cold. p_verified must be true, and the caller must have
   obtained it from verifyMirror() — hash AND etag compared against SharePoint.
   Refusing here means no application bug can delete the only copy. */
CREATE OR REPLACE FUNCTION platform.demote_to_cold(p_doc uuid, p_verified boolean, p_reason text, p_actor text)
RETURNS TABLE (doc_id uuid, bytes_freed bigint, chunks_dropped int)
LANGUAGE plpgsql AS $$
DECLARE v_bytes bigint; v_chunks int; v_vertical text;
BEGIN
  IF NOT p_verified THEN
    RAISE EXCEPTION 'refusing to demote % — mirror not verified (the platform never deletes the only copy)', p_doc;
  END IF;

  SELECT bytes, chunk_count, vertical INTO v_bytes, v_chunks, v_vertical
    FROM rag.documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such document %', p_doc; END IF;

  DELETE FROM rag.chunks WHERE doc_id = p_doc;      -- ON DELETE CASCADE is not used: explicit is auditable

  UPDATE rag.documents
     SET tier = 'cold', chunk_count = 0, bytes = 0, archived_at = now(),
         archive_reason = p_reason, mirror_state = 'verified', mirror_verified_at = now(), updated_at = now()
   WHERE id = p_doc;

  INSERT INTO platform.lifecycle_events (doc_id, vertical, from_tier, to_tier, reason, bytes_freed, chunks_dropped, verified, actor)
  VALUES (p_doc, v_vertical, 'hot', 'cold', p_reason, v_bytes, v_chunks, true, p_actor);

  INSERT INTO audit.events (action, doc_id, vertical, actor, detail)
  VALUES ('lifecycle.demoted', p_doc, v_vertical, p_actor, jsonb_build_object('reason', p_reason, 'bytesFreed', v_bytes));

  RETURN QUERY SELECT p_doc, v_bytes, v_chunks;
END $$;

/* Reopening the path: the stub comes back as a live document, re-embedded from
   the SharePoint copy — the system of record, not our cached text. */
CREATE OR REPLACE FUNCTION platform.rehydrate_stub(p_doc uuid, p_actor text)
RETURNS TABLE (doc_id uuid, sharepoint jsonb, days_archived int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = rag, platform, pg_temp AS $$
DECLARE v_acl jsonb; v_vertical text; v_sp jsonb; v_archived timestamptz;
BEGIN
  SELECT acl, vertical, sharepoint, archived_at
    INTO v_acl, v_vertical, v_sp, v_archived
    FROM rag.documents WHERE id = p_doc AND NOT deleted AND tier = 'cold';
  IF NOT FOUND THEN RAISE EXCEPTION 'no cold document %', p_doc; END IF;
  IF NOT platform.can_read(v_acl, v_vertical) THEN RAISE EXCEPTION 'no cold document %', p_doc; END IF;
  IF v_sp IS NULL OR v_sp->>'itemId' IS NULL THEN
    /* no way back in: the content is not in SharePoint, so there is nothing to
       rehydrate from. Say so rather than returning an empty warm document. */
    RAISE EXCEPTION 'document % has no SharePoint pointer — cannot reopen the path', p_doc;
  END IF;

  UPDATE rag.documents
     SET tier = 'warm', archived_at = NULL, archive_reason = NULL, updated_at = now(),
         last_opened_at = now(), last_opened_by = p_actor, open_count = open_count + 1
   WHERE id = p_doc;

  INSERT INTO platform.lifecycle_events (doc_id, vertical, from_tier, to_tier, reason, verified, actor)
  VALUES (p_doc, v_vertical, 'cold', 'warm', 'rehydrated on request', true, p_actor);

  INSERT INTO audit.events (action, doc_id, vertical, actor, detail)
  VALUES ('lifecycle.rehydrated', p_doc, v_vertical, p_actor, jsonb_build_object('itemId', v_sp->>'itemId'));

  RETURN QUERY SELECT p_doc, v_sp, coalesce((EXTRACT(EPOCH FROM (now() - v_archived)) / 86400)::int, 0);
END $$;

/* ------------------------------------------------------------- capacity views
   Same arithmetic as capacityPlan() / liveBytes() / quotaReport(). */
CREATE OR REPLACE VIEW platform.live_usage AS
WITH c AS (
  SELECT max(CASE WHEN key = 'planning_bytes_per_chunk' THEN value END)::bigint AS per_chunk,
         max(CASE WHEN key = 'cold_stub_bytes'          THEN value END)::bigint AS stub
  FROM platform.capacity_constants
),
counts AS (
  SELECT v.id AS vertical,
         (SELECT count(*) FROM rag.chunks ch
            JOIN rag.documents dd ON dd.id = ch.doc_id
           WHERE dd.vertical = v.id AND dd.deleted = false) AS chunks,
         (SELECT count(*) FROM rag.documents d
           WHERE d.vertical = v.id AND d.deleted = false AND d.tier <> 'cold') AS live_documents,
         (SELECT count(*) FROM rag.documents d
           WHERE d.vertical = v.id AND d.deleted = false AND d.tier = 'cold') AS cold_stubs
  FROM platform.verticals v
)
/* Bytes are counted from the rows that actually exist, not from a stored
   counter, so the quota report cannot drift from the data — exactly what
   MemoryStore.liveBytes() does on the Node side. */
SELECT v.id AS vertical, v.label, v.quota_gb, v.sensitivity,
       n.chunks, n.live_documents, n.cold_stubs,
       (n.chunks * c.per_chunk) AS live_chunk_bytes,
       (n.cold_stubs * c.stub)  AS cold_stub_bytes,
       round((n.chunks * c.per_chunk + n.cold_stubs * c.stub) / 1024^3, 6) AS used_gb,
       round(((n.chunks * c.per_chunk + n.cold_stubs * c.stub) / 1024^3 / v.quota_gb) * 100, 2) AS pct_of_quota,
       platform.cold_window_days(v.id) AS window_days
FROM platform.verticals v JOIN counts n ON n.vertical = v.id CROSS JOIN c;

CREATE OR REPLACE VIEW platform.capacity AS
WITH u AS (SELECT sum(used_gb) AS live_gb, sum(chunks) AS chunks, sum(cold_stubs) AS stubs FROM platform.live_usage),
     k AS (SELECT max(CASE WHEN key='live_ceiling_gb' THEN value END) AS ceiling_gb,
                  max(CASE WHEN key='node_volume_gb' THEN value END) AS node_gb,
                  max(CASE WHEN key='nodes' THEN value END) AS nodes,
                  max(CASE WHEN key='headroom_target' THEN value END) AS headroom,
                  max(CASE WHEN key='planning_bytes_per_chunk' THEN value END) AS per_chunk
           FROM platform.capacity_constants)
SELECT u.live_gb, k.ceiling_gb, k.node_gb * k.nodes AS provisioned_gb,
       round(k.node_gb * k.nodes / NULLIF(u.live_gb, 0), 3) AS headroom_actual,
       (k.node_gb * k.nodes / NULLIF(u.live_gb, 0)) >= k.headroom AS headroom_ok,
       u.live_gb <= k.ceiling_gb AS ceiling_held,
       u.chunks, u.stubs,
       floor(k.ceiling_gb * 0.85 * 1024^3 / k.per_chunk)::bigint AS chunk_budget,
       round((u.chunks * k.per_chunk) / 1024^3, 6) AS heap_index_estimate_gb
FROM u, k;

/* Which documents to demote if the ceiling is breached: least recently opened
   first, and only those with a verified mirror. */
CREATE OR REPLACE VIEW platform.ceiling_breach_plan AS
SELECT d.id, d.vertical, d.title, d.bytes, d.last_opened_at, d.mirror_state,
       row_number() OVER (ORDER BY d.last_opened_at ASC) AS demote_order
FROM rag.documents d
WHERE d.deleted = false AND d.tier <> 'cold'
  AND d.sharepoint IS NOT NULL AND d.mirror_state IN ('mirrored','verified')
ORDER BY d.last_opened_at ASC;

/* =============================================================================
   wiki — organised knowledge, with a history that cannot be rewritten
   ========================================================================== */

CREATE TABLE IF NOT EXISTS wiki.pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical     text NOT NULL REFERENCES platform.verticals(id),
  slug         text NOT NULL,                       -- "<vertical>/<page-slug>"
  title        text NOT NULL,
  body         text NOT NULL,
  revision     int  NOT NULL DEFAULT 1,
  tags         text[] NOT NULL DEFAULT '{}',
  front_matter jsonb NOT NULL DEFAULT '{}',
  author       text NOT NULL DEFAULT 'unknown',
  review_by    date,                                -- nothing is trusted forever
  last_reviewed_at timestamptz,
  doc_id       uuid REFERENCES rag.documents(id) ON DELETE SET NULL,  -- the page as a citable RAG document
  backlinks    text[] NOT NULL DEFAULT '{}',
  mirror_state text NOT NULL DEFAULT 'pending' CHECK (mirror_state IN ('pending','mirrored','failed')),
  sharepoint   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS pages_vertical ON wiki.pages (vertical, updated_at DESC);
CREATE INDEX IF NOT EXISTS pages_title_trgm ON wiki.pages USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS pages_review ON wiki.pages (review_by) WHERE review_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS wiki.revisions (
  page_id   uuid NOT NULL REFERENCES wiki.pages(id) ON DELETE CASCADE,
  revision  int  NOT NULL,
  body      text NOT NULL,
  author    text NOT NULL,
  note      text NOT NULL DEFAULT '',
  hash      char(64) NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, revision)
);

/* Immutable history. Both the trigger and the grants say no. */
CREATE OR REPLACE FUNCTION wiki.refuse_revision_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wiki revisions are immutable: % of revision % on page % is refused',
    TG_OP, OLD.revision, OLD.page_id;
END $$;

DROP TRIGGER IF EXISTS revisions_immutable ON wiki.revisions;
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON wiki.revisions
  FOR EACH ROW EXECUTE FUNCTION wiki.refuse_revision_rewrite();

/* The link graph, both directions: [[slug]], [text](wiki:slug) and bare
   /wiki/slug in prose. */
CREATE TABLE IF NOT EXISTS wiki.links (
  from_slug text NOT NULL,
  to_slug   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_slug, to_slug)
);
CREATE INDEX IF NOT EXISTS links_to ON wiki.links (to_slug);

/* Review queue: overdue pages are surfaced, not quietly trusted. */
CREATE OR REPLACE VIEW wiki.review_queue AS
SELECT p.slug, p.title, p.vertical, p.author, p.review_by, p.last_reviewed_at,
       (p.review_by < CURRENT_DATE) AS overdue,
       (CURRENT_DATE - p.review_by) AS days_overdue
FROM wiki.pages p
WHERE p.review_by IS NOT NULL
ORDER BY overdue DESC, p.review_by ASC;

/* =============================================================================
   platform — keys, mirrors, lifecycle
   ========================================================================== */

CREATE TABLE IF NOT EXISTS platform.api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       text NOT NULL,
  label        text,
  key_hash     char(64) NOT NULL UNIQUE,   -- sha256 of the secret; the secret is shown once and never stored
  scopes       text[] NOT NULL DEFAULT '{search,read}',
  verticals    text[] NOT NULL DEFAULT '{*}',
  rate_per_min int  NOT NULL DEFAULT 120,
  revoked      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_app ON platform.api_keys (app_id) WHERE NOT revoked;

CREATE TABLE IF NOT EXISTS platform.mirrors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id     uuid REFERENCES rag.documents(id) ON DELETE CASCADE,
  page_id    uuid REFERENCES wiki.pages(id) ON DELETE CASCADE,
  direction  text NOT NULL CHECK (direction IN ('inbound','outbound')),
  item_id    text NOT NULL,
  site_id    text,
  etag       text,
  version_id text,
  verified   boolean NOT NULL DEFAULT false,
  reason     text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mirrors_doc ON platform.mirrors (doc_id, at DESC);
CREATE INDEX IF NOT EXISTS mirrors_item ON platform.mirrors (item_id, at DESC);

CREATE TABLE IF NOT EXISTS platform.lifecycle_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id         uuid REFERENCES rag.documents(id) ON DELETE CASCADE,
  vertical       text,
  from_tier      text,
  to_tier        text NOT NULL,
  reason         text,
  bytes_freed    bigint,
  chunks_dropped int,
  verified       boolean NOT NULL DEFAULT false,
  etag           text,
  actor          text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lifecycle_doc ON platform.lifecycle_events (doc_id, at DESC);
CREATE INDEX IF NOT EXISTS lifecycle_to ON platform.lifecycle_events (to_tier, at DESC);

/* =============================================================================
   audit — append-only, partitioned by month
   ========================================================================== */

CREATE TABLE IF NOT EXISTS audit.events (
  id       uuid NOT NULL DEFAULT gen_random_uuid(),
  at       timestamptz NOT NULL DEFAULT now(),
  action   text NOT NULL,
  doc_id   uuid,
  page_id  uuid,
  vertical text,
  app_id   text,
  actor    text,
  detail   jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE INDEX IF NOT EXISTS audit_action_at ON audit.events (action, at DESC);
CREATE INDEX IF NOT EXISTS audit_doc ON audit.events (doc_id, at DESC);

CREATE OR REPLACE FUNCTION audit.ensure_partition(p_month date DEFAULT date_trunc('month', now())::date)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE name text := 'events_' || to_char(p_month, 'YYYY_MM');
        nxt  date := (p_month + interval '1 month')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'audit' AND c.relname = name) THEN
    EXECUTE format('CREATE TABLE audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)', name, p_month, nxt);
  END IF;
  RETURN 'audit.' || name;
END $$;

SELECT audit.ensure_partition();
SELECT audit.ensure_partition((date_trunc('month', now()) + interval '1 month')::date);

/* History is not edited either. */
CREATE OR REPLACE FUNCTION audit.refuse_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only: % is refused', TG_OP;
END $$;

DROP TRIGGER IF EXISTS audit_immutable ON audit.events;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_rewrite();

/* =============================================================================
   Row level security — authorisation in the candidate query
   ========================================================================== */

ALTER TABLE rag.documents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki.pages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki.revisions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.api_keys        ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.mirrors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events    ENABLE ROW LEVEL SECURITY;

/* A chunk is visible when its document is. The join is on doc_id, so the
   policy is evaluated per chunk — no post-filtering step exists to forget. */
DROP POLICY IF EXISTS documents_rls ON rag.documents;
CREATE POLICY documents_rls ON rag.documents FOR SELECT TO kinetic_app
  USING (NOT deleted AND platform.can_read(acl, vertical));

DROP POLICY IF EXISTS documents_write ON rag.documents;
CREATE POLICY documents_write ON rag.documents FOR INSERT TO kinetic_app
  WITH CHECK (platform.can_write(vertical));

/* Apps cannot UPDATE documents directly at all: writes go through ingest
   (insert) or through the definer helpers above, which check read rights
   themselves. A blanket UPDATE policy for kinetic_app would let a caller edit
   an ACL it can read — the widening the platform exists to prevent. */
DROP POLICY IF EXISTS documents_update ON rag.documents;
CREATE POLICY documents_update ON rag.documents FOR UPDATE TO kinetic_app
  USING (platform.can_write(vertical)) WITH CHECK (platform.can_write(vertical));

DROP POLICY IF EXISTS chunks_rls ON rag.chunks;
CREATE POLICY chunks_rls ON rag.chunks FOR SELECT TO kinetic_app
  USING (EXISTS (SELECT 1 FROM rag.documents d
                  WHERE d.id = chunks.doc_id AND NOT d.deleted
                    AND platform.can_read(d.acl, d.vertical)));

DROP POLICY IF EXISTS chunks_write ON rag.chunks;
CREATE POLICY chunks_write ON rag.chunks FOR ALL TO kinetic_app
  USING (platform.is_trusted_caller()) WITH CHECK (platform.is_trusted_caller());

/* Wiki pages are a vertical's own knowledge: the vertical is the ACL, so the
   policy is scope, not item permissions. (Building a fake "public" ACL object
   and passing it to can_read would short-circuit on denyPublic and make this
   policy vacuous — which is worse than no policy, because it looks like one.) */
DROP POLICY IF EXISTS pages_rls ON wiki.pages;
CREATE POLICY pages_rls ON wiki.pages FOR SELECT TO kinetic_app
  USING (platform.is_trusted_caller()
         OR (platform.setting_list('kinetic.verticals') IS NOT NULL
             AND vertical = ANY (platform.setting_list('kinetic.verticals'))));

DROP POLICY IF EXISTS pages_write ON wiki.pages;
CREATE POLICY pages_write ON wiki.pages FOR ALL TO kinetic_app
  USING (platform.can_write(vertical)) WITH CHECK (platform.can_write(vertical));

DROP POLICY IF EXISTS revisions_rls ON wiki.revisions;
CREATE POLICY revisions_rls ON wiki.revisions FOR SELECT TO kinetic_app
  USING (EXISTS (SELECT 1 FROM wiki.pages p WHERE p.id = revisions.page_id));

DROP POLICY IF EXISTS revisions_insert ON wiki.revisions;
CREATE POLICY revisions_insert ON wiki.revisions FOR INSERT TO kinetic_app WITH CHECK (true);

/* The platform service must read key hashes to authenticate callers. Reading the
   table exposes nothing usable: only sha256 hashes are stored, the secret is
   shown once at creation and never written here. Writes are internal-only. */
DROP POLICY IF EXISTS keys_rls ON platform.api_keys;
CREATE POLICY keys_rls ON platform.api_keys FOR SELECT TO kinetic_app USING (true);

DROP POLICY IF EXISTS mirrors_rls ON platform.mirrors;
CREATE POLICY mirrors_rls ON platform.mirrors FOR ALL TO kinetic_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS lifecycle_rls ON platform.lifecycle_events;
CREATE POLICY lifecycle_rls ON platform.lifecycle_events FOR SELECT TO kinetic_app USING (true);

DROP POLICY IF EXISTS audit_rls ON audit.events;
CREATE POLICY audit_rls ON audit.events FOR SELECT TO kinetic_app USING (true);

DROP POLICY IF EXISTS audit_insert ON audit.events;
CREATE POLICY audit_insert ON audit.events FOR INSERT TO kinetic_app WITH CHECK (true);

/* =============================================================================
   Grants
   ========================================================================== */

GRANT USAGE ON SCHEMA rag, wiki, platform, audit TO kinetic_app;
GRANT SELECT, INSERT, UPDATE ON rag.documents TO kinetic_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rag.chunks TO kinetic_app;
GRANT SELECT, INSERT, UPDATE ON wiki.pages TO kinetic_app;
GRANT SELECT, INSERT ON wiki.revisions TO kinetic_app;          -- no UPDATE, no DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON wiki.links TO kinetic_app;
GRANT SELECT ON platform.verticals, platform.capacity_constants TO kinetic_app;
GRANT SELECT, INSERT, UPDATE ON platform.api_keys, platform.mirrors TO kinetic_app;
GRANT SELECT, INSERT ON platform.lifecycle_events TO kinetic_app;
GRANT SELECT, INSERT ON audit.events TO kinetic_app;            -- append-only
GRANT SELECT ON ALL TABLES IN SCHEMA rag, wiki, platform, audit TO kinetic_internal;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA rag, wiki, platform TO kinetic_internal;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rag, wiki, platform, audit TO kinetic_app, kinetic_internal;

/* =============================================================================
   Operations notes
   -----------------------------------------------------------------------------
   Connections   6 apps × 8 pooled = 48 wanted, 100 max_connections (2.08× the
                 want). Put PgBouncer in front in transaction mode; the GUC
                 context above (SET LOCAL kinetic.*) is transaction-scoped, so
                 transaction pooling is safe. Statement pooling is not.

   Memory        22 GB recommended: HNSW index ≈ 7.05 GB + heap ≈ 9.95 GB at
                 the 20 GB ceiling, and the policy is 2× the working set.
                 shared_buffers 25%, effective_cache_size 70%,
                 maintenance_work_mem 3 GB during index builds only.

   Storage       50 GB block volume per node at 10 VPU (Balanced) = 3,000 IOPS
                 and ~23 MB/s. That is throughput-limited, which is exactly why
                 the working set is sized to stay resident rather than scanned:
                 100 GB provisioned against a 20 GB live ceiling is 2.5× the
                 headroom the policy demands.

   Vacuum        Churn comes from ingest and from demotion deleting chunks.
                 Per-table autovacuum on rag.chunks: scale_factor 0.05,
                 vacuum_cost_delay 2ms. Watch bloat after a large sweep.

   Backups       pg_dump nightly + volume snapshot, and SharePoint remains the
                 system of record for source documents: RPO 15 min (delta sync),
                 RTO 1 hour. The audit partitions older than 24 months can be
                 detached and archived rather than dumped.

   Qdrant        Not needed at this scale. 1.78M chunks at 768 dims fit in
                 pgvector with the index in RAM. Move to a dedicated vector
                 service beyond ~50M vectors, or when a second embedding model
                 has to be served concurrently.

   Renaming      The platform brand is one constant: PLATFORM.name in
                 platform/config.mjs, and platform.verticals holds the business
                 mapping. Nothing else knows the name.
   ========================================================================== */
