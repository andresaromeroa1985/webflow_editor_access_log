-- Registrar tracking via RDAP + name.com account membership.
--
-- One row per *registrable* domain (the apex — example.com, not www.example.com).
-- A site's customDomains list usually holds both the apex and its www alias;
-- both collapse to the same row here, so registrar lookups happen once per
-- real domain rather than once per alias.

CREATE TABLE IF NOT EXISTS domains (
  domain             TEXT PRIMARY KEY,     -- lowercase apex, e.g. "peros.com"
  tld                TEXT,                 -- "com" — used to pick the RDAP server

  -- From RDAP. registrar_name NULL + rdap_status 'ok' means the registry
  -- answered but didn't expose a registrar entity (rare, some ccTLDs).
  registrar_name     TEXT,
  registrar_iana_id  TEXT,
  rdap_status        TEXT,                 -- ok | not_found | unsupported_tld | error
  rdap_error         TEXT,
  rdap_checked_at    TEXT,

  -- From the name.com account API. Answers a question RDAP can't:
  -- "is this in SpotOn's account?" — as opposed to a client's own name.com account.
  -- NULL = never checked, 0 = checked and not ours, 1 = ours.
  in_namecom_account INTEGER,
  namecom_checked_at TEXT,

  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_domains_rdap_checked ON domains(rdap_checked_at);
CREATE INDEX IF NOT EXISTS idx_domains_registrar    ON domains(registrar_name);

-- Link from site to its primary registrable domain. A site with two genuinely
-- different apex domains (rare) records the first; custom_domain_count still
-- reflects the true total.
ALTER TABLE sites ADD COLUMN apex_domain TEXT;
CREATE INDEX IF NOT EXISTS idx_sites_apex ON sites(apex_domain);

-- Small key/value store for things that are expensive to fetch and change
-- slowly: the IANA RDAP bootstrap file (~70KB, refreshed weekly) and the
-- timestamp of the last name.com account sync.
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
