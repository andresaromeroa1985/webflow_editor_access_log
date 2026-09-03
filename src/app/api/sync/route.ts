import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/db";
import {
  ActivityUnavailableError,
  fetchNewEvents,
  listSites,
  mapWithConcurrency,
} from "@/lib/webflow";
import type { WebflowActivityEvent, DomainState } from "@/lib/types";

export const dynamic = "force-dynamic";

interface SiteBatchRow {
  id: string;
  display_name: string;
  last_event_id: string | null;
}

/**
 * Batched sync.
 *
 * Why batched: a Worker invocation has a wall-clock budget, and the portfolio is
 * ~950 sites. One request per site per night is ~16 minutes of API time at 60
 * req/min — far past what a single invocation can hold. So the caller (the
 * GitHub Actions cron) loops:
 *
 *   GET /api/sync?offset=0   -> { done: false, nextOffset: 25 }
 *   GET /api/sync?offset=25  -> { done: false, nextOffset: 50 }
 *   ...                      -> { done: true }
 *
 * offset=0 also refreshes the site roster from Webflow before processing.
 */
async function handle(req: NextRequest) {
  const env = getEnv();
  const db = env.DB;

  // ---- auth ---------------------------------------------------------------
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.CRON_SECRET || presented !== env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.WEBFLOW_API_TOKEN) {
    return NextResponse.json(
      { error: "WEBFLOW_API_TOKEN is not configured" },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const batchSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("batch") ?? "25") || 25),
  );
  const concurrency = Math.min(
    8,
    Math.max(1, Number(url.searchParams.get("concurrency") ?? "4") || 4),
  );

  const backfillDays = Number(env.BACKFILL_DAYS ?? "180") || 180;
  const backfillCutoff = new Date(Date.now() - backfillDays * 86_400_000);

  const startedAt = new Date().toISOString();
  let refreshedSites = 0;

  // ---- roster refresh (first batch only) ----------------------------------
  if (offset === 0) {
    const sites = await listSites(env.WEBFLOW_API_TOKEN);
    refreshedSites = sites.length;

    for (let i = 0; i < sites.length; i += 50) {
      const chunk = sites.slice(i, i + 50);
      await db.batch(
        chunk.map((s) => {
          const domains = s.customDomains ?? [];
          const published = domains
            .map((d) => d.lastPublished)
            .filter((v): v is string => Boolean(v))
            .sort();
          const domainLastPublished =
            published.length > 0 ? published[published.length - 1] : null;

          // none        - still on *.webflow.io
          // unpublished - domain attached, never published to it
          // live        - published to at least one custom domain
          const domainState: DomainState =
            domains.length === 0
              ? "none"
              : domainLastPublished
                ? "live"
                : "unpublished";

          return db
            .prepare(
              `INSERT INTO sites
                 (id, display_name, short_name, workspace_id, last_published,
                  custom_domains_json, custom_domain_count, domain_last_published, domain_state)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(id) DO UPDATE SET
                 display_name          = excluded.display_name,
                 short_name            = excluded.short_name,
                 workspace_id          = excluded.workspace_id,
                 last_published        = excluded.last_published,
                 custom_domains_json   = excluded.custom_domains_json,
                 custom_domain_count   = excluded.custom_domain_count,
                 domain_last_published = excluded.domain_last_published,
                 domain_state          = excluded.domain_state`,
            )
            .bind(
              s.id,
              s.displayName ?? "(unnamed)",
              s.shortName ?? null,
              s.workspaceId ?? null,
              s.lastPublished ?? null,
              domains.length > 0 ? JSON.stringify(domains) : null,
              domains.length,
              domainLastPublished,
              domainState,
            );
        }),
      );
    }
  }

  // ---- select this batch of sites -----------------------------------------
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM sites WHERE activity_supported = 1`)
    .first<{ n: number }>();
  const totalSites = totalRow?.n ?? 0;

  const { results: siteBatch } = await db
    .prepare(
      `SELECT s.id, s.display_name, ss.last_event_id
         FROM sites s
         LEFT JOIN sync_state ss ON ss.site_id = s.id
        WHERE s.activity_supported = 1
        ORDER BY s.id
        LIMIT ?1 OFFSET ?2`,
    )
    .bind(batchSize, offset)
    .all<SiteBatchRow>();

  const batchRows: SiteBatchRow[] = (siteBatch ?? []) as SiteBatchRow[];

  let eventsInserted = 0;
  let errors = 0;
  const errorDetail: { site: string; message: string }[] = [];

  // ---- pull each site ------------------------------------------------------
  const perSite = await mapWithConcurrency(
    batchRows,
    concurrency,
    async (site: SiteBatchRow) => {
      try {
        const { events } = await fetchNewEvents(
          env.WEBFLOW_API_TOKEN,
          site.id,
          { knownEventId: site.last_event_id, backfillCutoff },
        );
        return { site, events, error: null as string | null, unsupported: false };
      } catch (err) {
        const unsupported = err instanceof ActivityUnavailableError;
        return {
          site,
          events: [] as WebflowActivityEvent[],
          error: err instanceof Error ? err.message : String(err),
          unsupported,
        };
      }
    },
  );

  // ---- persist -------------------------------------------------------------
  const now = new Date().toISOString();

  for (const { site, events, error, unsupported } of perSite) {
    if (error) {
      errors++;
      errorDetail.push({ site: site.display_name, message: error.slice(0, 200) });
      await db
        .prepare(
          `UPDATE sites
              SET sync_error = ?2,
                  last_synced_at = ?3,
                  activity_supported = ?4
            WHERE id = ?1`,
        )
        .bind(site.id, error.slice(0, 500), now, unsupported ? 0 : 1)
        .run();
      continue;
    }

    if (events.length > 0) {
      // Insert oldest-first so the newest event is the last thing written.
      const ordered = [...events].reverse();

      for (let i = 0; i < ordered.length; i += 50) {
        const chunk = ordered.slice(i, i + 50);
        await db.batch(
          chunk.map((e) =>
            db
              .prepare(
                `INSERT INTO activity_events
                   (id, site_id, created_on, event, resource_operation,
                    resource_name, user_id, user_name, source, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO NOTHING`,
              )
              .bind(
                e.id,
                site.id,
                e.createdOn,
                e.event ?? null,
                e.resourceOperation ?? null,
                e.resourceName ?? null,
                e.user?.id ?? null,
                e.user?.displayName ?? null,
                e.source ?? null,
                e.payload ? JSON.stringify(e.payload) : null,
              ),
          ),
        );
      }
      eventsInserted += ordered.length;

      // Watermark = newest event we just stored.
      const newest = events[0];
      await db
        .prepare(
          `INSERT INTO sync_state (site_id, last_event_id, last_event_created_on, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(site_id) DO UPDATE SET
             last_event_id         = excluded.last_event_id,
             last_event_created_on = excluded.last_event_created_on,
             updated_at            = excluded.updated_at`,
        )
        .bind(site.id, newest.id, newest.createdOn, now)
        .run();
    }

    await db
      .prepare(
        `UPDATE sites SET last_synced_at = ?2, sync_error = NULL WHERE id = ?1`,
      )
      .bind(site.id, now)
      .run();
  }

  const processed = batchRows.length;
  const nextOffset = offset + processed;
  const done = processed === 0 || nextOffset >= totalSites;

  await db
    .prepare(
      `INSERT INTO sync_runs
         (started_at, finished_at, sites_processed, events_inserted, errors, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      startedAt,
      new Date().toISOString(),
      processed,
      eventsInserted,
      errors,
      `offset=${offset}`,
    )
    .run();

  return NextResponse.json({
    ok: true,
    done,
    offset,
    nextOffset: done ? null : nextOffset,
    totalSites,
    refreshedSites,
    sitesProcessed: processed,
    eventsInserted,
    errors,
    errorDetail: errorDetail.slice(0, 10),
  });
}

export const GET = handle;
export const POST = handle;
