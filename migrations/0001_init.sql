-- Webflow Editor Access Log — initial schema
--
-- Design note: we deliberately do NOT store a denormalized "is_client" flag on
-- events. Whether an event counts as a client edit depends on the internal-user
-- allowlist, which changes over time (designers join, leave, get reclassified).
-- Classification is resolved at query time via a LEFT JOIN against
-- internal_users, so correcting the allowlist retroactively fixes every number
-- on the dashboard without a re-sync.

CREATE TABLE IF NOT EXISTS sites (
  id                 TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  short_name         TEXT,
  workspace_id       TEXT,
  last_published     TEXT,
  -- 0 when the activity_logs endpoint returned 403/404 for this site
  -- (non-Enterprise plan, or token not authorized for it).
  activity_supported INTEGER NOT NULL DEFAULT 1,
  last_synced_at     TEXT,
  sync_error         TEXT,
  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_events (
  -- Webflow's own event id. PRIMARY KEY gives us idempotent re-sync for free.
  id                 TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL,
  created_on         TEXT NOT NULL,          -- ISO-8601 UTC, as returned by Webflow
  event              TEXT,                   -- e.g. page_dom_modified, site_published
  resource_operation TEXT,                   -- CREATED | MODIFIED | DELETED | PUBLISHED
  resource_name      TEXT,
  -- NULL user = system-generated event (e.g. automatic backup_created).
  -- These must never count as client activity.
  user_id            TEXT,
  user_name          TEXT,
  source             TEXT,                   -- DESIGNER | EDITOR | WEBFLOW_AI | ...
  payload_json       TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_events_site_created ON activity_events(site_id, created_on DESC);
CREATE INDEX IF NOT EXISTS idx_events_created      ON activity_events(created_on DESC);
CREATE INDEX IF NOT EXISTS idx_events_user         ON activity_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_event        ON activity_events(event);

-- The allowlist that defines "not a client".
-- Anyone who appears in activity_events but NOT here is treated as a client.
CREATE TABLE IF NOT EXISTS internal_users (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT,
  note         TEXT,
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-site incremental sync watermark. The activity_logs endpoint has no date
-- filter, so we page newest-first and stop as soon as we recognise an event id
-- we already hold.
CREATE TABLE IF NOT EXISTS sync_state (
  site_id               TEXT PRIMARY KEY,
  last_event_id         TEXT,
  last_event_created_on TEXT,
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  sites_processed INTEGER NOT NULL DEFAULT 0,
  events_inserted INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);
