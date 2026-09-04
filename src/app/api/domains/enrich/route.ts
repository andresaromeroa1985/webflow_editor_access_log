import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/db";
import {
  fetchNamecomDomains,
  loadRdapBootstrap,
  rdapLookup,
} from "@/lib/domains";
import { mapWithConcurrency } from "@/lib/webflow";

export const dynamic = "force-dynamic";

const RDAP_RECHECK_DAYS = 30;
const NAMECOM_RECHECK_HOURS = 24;

/** D1 caps bound parameters per statement at 100; stay comfortably under. */
const IN_CHUNK = 50;
/** Statements per db.batch() call. */
const BATCH_CHUNK = 25;

/**
 * Registrar enrichment, batched like /api/sync.
 *
 *   GET /api/domains/enrich?namecom=1&limit=0   -> name.com sync only
 *   GET /api/domains/enrich?limit=20            -> 20 RDAP lookups
 *   GET /api/domains/enrich?limit=20            -> 20 more ...
 *   ...                                         -> { done: true }
 *
 * Two independent jobs:
 *
 * 1. name.com account sync — flags which of OUR domains sit in SpotOn's
 *    name.com account. Runs when forced (`namecom=1`) or when the last sync is
 *    older than 24h. Iterates our ~550 domains, not the account's (which may be
 *    thousands), and writes in a handful of batched statements.
 *
 * 2. RDAP registrar lookups — one HTTP request per domain against the registry
 *    for anything never checked or checked >30 days ago. This is the part that
 *    gets paged with `limit`.
 *
 * Keeping each call small matters: a Worker invocation has a wall-clock budget
 * and the gateway returns 504 past it. The nightly workflow does name.com first
 * as its own call, then loops RDAP.
 *
 * Query params:
 *   limit      RDAP lookups this call (default 20, max 50, 0 = skip RDAP)
 *   namecom=1  force a name.com resync regardless of the 24h window
 *   force=1    treat every domain as RDAP-stale (full recheck)
 */
export async function GET(req: NextRequest) {
  const env = getEnv();
  const db = env.DB;

  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.CRON_SECRET || presented !== env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit =
    rawLimit === null
      ? 20
      : Math.min(50, Math.max(0, Number(rawLimit) || 0));
  const forceNamecom = url.searchParams.get("namecom") === "1";
  const forceAll = url.searchParams.get("force") === "1";

  const now = new Date().toISOString();
  const result: Record<string, unknown> = { ok: true };

  // ---- 1. name.com account sync ------------------------------------------
  if (env.NAMECOM_USERNAME && env.NAMECOM_TOKEN) {
    const last = await db
      .prepare(`SELECT updated_at FROM meta WHERE key = 'namecom_synced_at'`)
      .first<{ updated_at: string }>();

    const stale =
      !last ||
      Date.now() - Date.parse(last.updated_at) >
        NAMECOM_RECHECK_HOURS * 3_600_000;

    if (stale || forceNamecom) {
      try {
        const ours = await fetchNamecomDomains(
          env.NAMECOM_USERNAME,
          env.NAMECOM_TOKEN,
        );

        // Walk OUR domains (~hundreds), not the account's (maybe thousands).
        const { results: mine } = await db
          .prepare(`SELECT domain FROM domains`)
          .all<{ domain: string }>();
        const matches = (mine ?? [])
          .map((r) => r.domain)
          .filter((d) => ours.has(d));

        const stmts: D1PreparedStatement[] = [
          db
            .prepare(
              `UPDATE domains SET in_namecom_account = 0, namecom_checked_at = ?1`,
            )
            .bind(now),
        ];
        for (let i = 0; i < matches.length; i += IN_CHUNK) {
          const chunk = matches.slice(i, i + IN_CHUNK);
          const placeholders = chunk.map((_, k) => `?${k + 1}`).join(",");
          stmts.push(
            db
              .prepare(
                `UPDATE domains SET in_namecom_account = 1 WHERE domain IN (${placeholders})`,
              )
              .bind(...chunk),
          );
        }
        stmts.push(
          db
            .prepare(
              `INSERT INTO meta (key, value, updated_at) VALUES ('namecom_synced_at', ?1, ?1)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .bind(now),
        );

        for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
          await db.batch(stmts.slice(i, i + BATCH_CHUNK));
        }

        result.namecom = {
          synced: true,
          accountDomains: ours.size,
          portfolioDomains: (mine ?? []).length,
          matchedInPortfolio: matches.length,
        };
      } catch (err) {
        result.namecom = {
          synced: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      result.namecom = {
        synced: false,
        reason: "fresh",
        lastSync: last?.updated_at,
      };
    }
  } else {
    result.namecom = {
      synced: false,
      reason: "NAMECOM_USERNAME / NAMECOM_TOKEN not set",
    };
  }

  // ---- 2. RDAP registrar lookups ------------------------------------------
  const staleBefore = new Date(
    Date.now() - RDAP_RECHECK_DAYS * 86_400_000,
  ).toISOString();

  let checked = 0;
  let okCount = 0;
  let errCount = 0;
  const sample: { domain: string; registrar: string | null; status: string }[] = [];

  if (limit > 0) {
    const staleClause = forceAll
      ? `1 = 1`
      : `(rdap_checked_at IS NULL OR rdap_checked_at < ?1)`;

    const { results } = await db
      .prepare(
        `SELECT domain FROM domains
          WHERE ${staleClause}
          ORDER BY (rdap_checked_at IS NOT NULL), domain
          LIMIT ${forceAll ? "?1" : "?2"}`,
      )
      .bind(...(forceAll ? [limit] : [staleBefore, limit]))
      .all<{ domain: string }>();

    const targets: string[] = (results ?? []).map((r) => r.domain);

    if (targets.length > 0) {
      const bootstrap = await loadRdapBootstrap(db);

      // Concurrency 3 + a short pause keeps us under registry rate limits.
      const outcomes = await mapWithConcurrency(targets, 3, async (apex) => {
        const r = await rdapLookup(apex, bootstrap);
        await new Promise((res) => setTimeout(res, 100));
        return { apex, r };
      });

      const stmts: D1PreparedStatement[] = [];
      for (const { apex, r } of outcomes) {
        checked++;
        if (r.status === "ok") okCount++;
        if (r.status === "error") errCount++;
        if (sample.length < 5) {
          sample.push({ domain: apex, registrar: r.registrarName, status: r.status });
        }
        stmts.push(
          db
            .prepare(
              `UPDATE domains
                  SET registrar_name    = ?2,
                      registrar_iana_id = ?3,
                      rdap_status       = ?4,
                      rdap_error        = ?5,
                      rdap_checked_at   = ?6
                WHERE domain = ?1`,
            )
            .bind(
              apex,
              r.registrarName,
              r.registrarIanaId,
              r.status,
              r.error ? r.error.slice(0, 300) : null,
              now,
            ),
        );
      }
      for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
        await db.batch(stmts.slice(i, i + BATCH_CHUNK));
      }
    }
  }

  const counts = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN rdap_checked_at IS NULL OR rdap_checked_at < ?1 THEN 1 ELSE 0 END) AS remaining
       FROM domains`,
    )
    .bind(staleBefore)
    .first<{ total: number; remaining: number }>();

  const remaining = counts?.remaining ?? 0;

  result.rdap = {
    checked,
    ok: okCount,
    errors: errCount,
    remaining,
    totalDomains: counts?.total ?? 0,
    sample,
  };
  result.done = remaining === 0;

  return NextResponse.json(result);
}
