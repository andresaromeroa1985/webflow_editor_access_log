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

/**
 * Registrar enrichment, batched like /api/sync.
 *
 *   GET /api/domains/enrich?limit=25      -> { remaining: 528, ... }
 *   GET /api/domains/enrich?limit=25      -> { remaining: 503, ... }
 *   ...                                   -> { remaining: 0 }
 *
 * Two independent jobs run here:
 *
 * 1. name.com account sync (whole account, at most once per 24h). One paginated
 *    call returns every domain SpotOn holds; we flag matches. Cheap.
 *
 * 2. RDAP registrar lookups for domains never checked, or checked more than
 *    30 days ago. One HTTP request per domain against the registry, so this is
 *    the part that's batched. Registrars rarely change; monthly is plenty.
 *
 * Query params:
 *   limit     RDAP lookups per call (default 25, max 100)
 *   namecom=1 force a name.com resync regardless of the 24h window
 *   force=1   treat every domain as stale (full RDAP recheck)
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
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? "25") || 25),
  );
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

        // Reset everyone to "not ours", then flag the matches.
        await db
          .prepare(
            `UPDATE domains SET in_namecom_account = 0, namecom_checked_at = ?1`,
          )
          .bind(now)
          .run();

        const list = [...ours];
        let flagged = 0;
        for (let i = 0; i < list.length; i += 50) {
          const chunk = list.slice(i, i + 50);
          const placeholders = chunk.map((_, k) => `?${k + 2}`).join(",");
          const r = await db
            .prepare(
              `UPDATE domains SET in_namecom_account = 1, namecom_checked_at = ?1
                WHERE domain IN (${placeholders})`,
            )
            .bind(now, ...chunk)
            .run();
          flagged += r.meta.changes ?? 0;
        }

        await db
          .prepare(
            `INSERT INTO meta (key, value, updated_at) VALUES ('namecom_synced_at', ?1, ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(now)
          .run();

        result.namecom = {
          synced: true,
          accountDomains: ours.size,
          matchedInPortfolio: flagged,
        };
      } catch (err) {
        result.namecom = {
          synced: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      result.namecom = { synced: false, reason: "fresh", lastSync: last?.updated_at };
    }
  } else {
    result.namecom = { synced: false, reason: "NAMECOM_USERNAME / NAMECOM_TOKEN not set" };
  }

  // ---- 2. RDAP registrar lookups ------------------------------------------
  const staleBefore = new Date(
    Date.now() - RDAP_RECHECK_DAYS * 86_400_000,
  ).toISOString();

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
  let checked = 0;
  let okCount = 0;
  let errCount = 0;
  const sample: { domain: string; registrar: string | null; status: string }[] = [];

  if (targets.length > 0) {
    const bootstrap = await loadRdapBootstrap(db);

    // Concurrency 2 + a short pause keeps us well under registry rate limits.
    const outcomes = await mapWithConcurrency(targets, 2, async (apex) => {
      const r = await rdapLookup(apex, bootstrap);
      await new Promise((res) => setTimeout(res, 150));
      return { apex, r };
    });

    for (const { apex, r } of outcomes) {
      checked++;
      if (r.status === "ok") okCount++;
      if (r.status === "error") errCount++;
      if (sample.length < 5) {
        sample.push({ domain: apex, registrar: r.registrarName, status: r.status });
      }

      await db
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
        )
        .run();
    }
  }

  const remainingRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM domains
        WHERE rdap_checked_at IS NULL OR rdap_checked_at < ?1`,
    )
    .bind(staleBefore)
    .first<{ n: number }>();

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM domains`)
    .first<{ n: number }>();

  result.rdap = {
    checked,
    ok: okCount,
    errors: errCount,
    remaining: remainingRow?.n ?? 0,
    totalDomains: totalRow?.n ?? 0,
    sample,
  };
  result.done = (remainingRow?.n ?? 0) === 0;

  return NextResponse.json(result);
}
