/// <reference types="@cloudflare/workers-types" />

// Generated/maintained alongside `npm run cf-typegen`.
// Declares the bindings and environment variables this app expects.

declare namespace Cloudflare {
  interface Env {
    /** D1 (SQLite) binding declared in wrangler.json */
    DB: D1Database;
    /** Webflow Data API token with `sites:read` + `site_activity:read` */
    WEBFLOW_API_TOKEN: string;
    /** Shared secret required by /api/sync (sent as `Authorization: Bearer <secret>`) */
    CRON_SECRET: string;
    /** How far back the very first sync of a site reaches. Default 180. */
    BACKFILL_DAYS?: string;
  }
}

interface CloudflareEnv extends Cloudflare.Env {}
