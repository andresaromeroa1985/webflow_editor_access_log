-- Custom domain tracking.
--
-- All of this comes from the `customDomains` array that List Sites already
-- returns on every roster refresh, so populating it costs no extra API calls.
--
-- Each entry looks like:
--   { "id": "...", "url": "example.com", "lastPublished": "2022-12-07T…" | null }
--
-- `lastPublished` being null is the interesting case: the domain is attached to
-- the site but has never been published to. That's a half-finished setup, and
-- it's invisible if you only ask "does this site have a domain?".

ALTER TABLE sites ADD COLUMN custom_domains_json TEXT;

-- Number of custom domains attached (0 = still on *.webflow.io).
ALTER TABLE sites ADD COLUMN custom_domain_count INTEGER NOT NULL DEFAULT 0;

-- Most recent publish to ANY of this site's custom domains.
-- NULL while at least one domain is attached means "attached, never published".
ALTER TABLE sites ADD COLUMN domain_last_published TEXT;

-- Denormalized state so the dashboard can group and index cheaply.
--   'none'      - no custom domain attached
--   'unpublished' - domain(s) attached, never published to any of them
--   'live'      - published to at least one custom domain
ALTER TABLE sites ADD COLUMN domain_state TEXT NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_sites_domain_state ON sites(domain_state);
