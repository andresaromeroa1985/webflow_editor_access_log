import { CLIENT_EVENT_PREDICATE, daysAgoIso } from "./db";
import type { SiteSummaryRow, UnclassifiedUserRow } from "./types";

export interface Overview {
  windowDays: number;
  since: string;
  totalSites: number;
  sitesWithClientEdits: number;
  sitesNeverEdited: number;
  totalClientEvents: number;
  distinctClientEditors: number;
  lastSyncAt: string | null;
  sitesWithErrors: number;
  unclassifiedUsers: number;
  eventsStored: number;
}

/**
 * Headline numbers: "N of M sites had a client edit in the last <window> days."
 */
export async function getOverview(
  db: D1Database,
  windowDays: number,
): Promise<Overview> {
  const since = daysAgoIso(windowDays);

  const totals = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sites WHERE activity_supported = 1) AS total_sites,
         (SELECT COUNT(*) FROM sites WHERE sync_error IS NOT NULL)  AS sites_with_errors,
         (SELECT MAX(last_synced_at) FROM sites)                    AS last_sync_at,
         (SELECT COUNT(*) FROM activity_events)                     AS events_stored`,
    )
    .first<{
      total_sites: number;
      sites_with_errors: number;
      last_sync_at: string | null;
      events_stored: number;
    }>();

  const windowed = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT e.site_id) AS sites_with_client_edits,
         COUNT(*)                  AS total_client_events,
         COUNT(DISTINCT e.user_id) AS distinct_client_editors
       FROM activity_events e
       WHERE e.created_on >= ?1 AND ${CLIENT_EVENT_PREDICATE}`,
    )
    .bind(since)
    .first<{
      sites_with_client_edits: number;
      total_client_events: number;
      distinct_client_editors: number;
    }>();

  // Sites with no client edit EVER — the hard "dormant" number, independent of window.
  const never = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sites s
        WHERE s.activity_supported = 1
          AND NOT EXISTS (
            SELECT 1 FROM activity_events e
             WHERE e.site_id = s.id AND ${CLIENT_EVENT_PREDICATE}
          )`,
    )
    .first<{ n: number }>();

  const unclassified = await db
    .prepare(
      `SELECT COUNT(DISTINCT e.user_id) AS n
         FROM activity_events e
        WHERE ${CLIENT_EVENT_PREDICATE}`,
    )
    .first<{ n: number }>();

  return {
    windowDays,
    since,
    totalSites: totals?.total_sites ?? 0,
    sitesWithClientEdits: windowed?.sites_with_client_edits ?? 0,
    sitesNeverEdited: never?.n ?? 0,
    totalClientEvents: windowed?.total_client_events ?? 0,
    distinctClientEditors: windowed?.distinct_client_editors ?? 0,
    lastSyncAt: totals?.last_sync_at ?? null,
    sitesWithErrors: totals?.sites_with_errors ?? 0,
    unclassifiedUsers: unclassified?.n ?? 0,
    eventsStored: totals?.events_stored ?? 0,
  };
}

/** Per-site roster, client activity within the window plus all-time last edit. */
export async function getSiteSummaries(
  db: D1Database,
  windowDays: number,
  limit = 1000,
): Promise<SiteSummaryRow[]> {
  const since = daysAgoIso(windowDays);

  const { results } = await db
    .prepare(
      `SELECT
         s.id,
         s.display_name,
         s.short_name,
         s.last_synced_at,
         s.sync_error,
         s.activity_supported,
         COALESCE(w.client_events, 0)  AS client_events,
         COALESCE(w.client_editors, 0) AS client_editors,
         a.last_client_edit,
         a.last_any_edit
       FROM sites s
       LEFT JOIN (
         SELECT e.site_id,
                COUNT(*)                  AS client_events,
                COUNT(DISTINCT e.user_id) AS client_editors
           FROM activity_events e
          WHERE e.created_on >= ?1 AND ${CLIENT_EVENT_PREDICATE}
          GROUP BY e.site_id
       ) w ON w.site_id = s.id
       LEFT JOIN (
         SELECT e.site_id,
                MAX(CASE WHEN ${CLIENT_EVENT_PREDICATE} THEN e.created_on END) AS last_client_edit,
                MAX(e.created_on) AS last_any_edit
           FROM activity_events e
          GROUP BY e.site_id
       ) a ON a.site_id = s.id
       WHERE s.activity_supported = 1
       ORDER BY (w.client_events IS NULL), w.client_events DESC, s.display_name
       LIMIT ?2`,
    )
    .bind(since, limit)
    .all<SiteSummaryRow>();

  return results ?? [];
}

/**
 * Every user seen in the logs, with whether they're on the internal allowlist.
 *
 * `site_count` is the useful signal for bootstrapping the allowlist: a SpotOn
 * designer shows up across many sites, a client shows up on exactly one.
 */
export async function getUsers(db: D1Database): Promise<UnclassifiedUserRow[]> {
  const { results } = await db
    .prepare(
      `SELECT
         e.user_id,
         MAX(e.user_name)              AS user_name,
         COUNT(*)                      AS event_count,
         COUNT(DISTINCT e.site_id)     AS site_count,
         MIN(e.created_on)             AS first_seen,
         MAX(e.created_on)             AS last_seen,
         CASE WHEN iu.user_id IS NULL THEN 0 ELSE 1 END AS is_internal
       FROM activity_events e
       LEFT JOIN internal_users iu ON iu.user_id = e.user_id
      WHERE e.user_id IS NOT NULL
      GROUP BY e.user_id, iu.user_id
      ORDER BY site_count DESC, event_count DESC`,
    )
    .all<UnclassifiedUserRow>();

  return results ?? [];
}
