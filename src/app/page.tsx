import { getEnvAsync, daysSince, fmtDate } from "@/lib/db";
import { getOverview, getSiteSummaries } from "@/lib/queries";
import type { DomainState, SiteSummaryRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const WINDOWS = [7, 30, 90, 365];
const basePath = process.env.BASE_URL || "";

function DomainPill({ state }: { state: DomainState }) {
  if (state === "live") return <span className="pill active">Live</span>;
  if (state === "unpublished")
    return <span className="pill client">Not published</span>;
  return <span className="pill never">None</span>;
}

function ActivityPill({ row }: { row: SiteSummaryRow }) {
  if (!row.last_client_edit) {
    return <span className="pill never">Never</span>;
  }
  const d = daysSince(row.last_client_edit);
  if (d !== null && d <= 90) {
    return <span className="pill active">{d === 0 ? "Today" : `${d}d ago`}</span>;
  }
  return <span className="pill dormant">{d}d ago</span>;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const requested = Number(params.days ?? "30");
  const windowDays = WINDOWS.includes(requested) ? requested : 30;

  const env = await getEnvAsync();
  const db = env.DB;

  let overview;
  let sites: SiteSummaryRow[] = [];
  let fatal: string | null = null;

  try {
    [overview, sites] = await Promise.all([
      getOverview(db, windowDays),
      getSiteSummaries(db, windowDays),
    ]);
  } catch (err) {
    fatal = err instanceof Error ? err.message : String(err);
  }

  if (fatal || !overview) {
    return (
      <div className="notice">
        <strong>Database not ready.</strong> Run the first sync, or check that
        the D1 migration has been applied.
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {fatal}
        </div>
      </div>
    );
  }

  const {
    totalSites,
    sitesWithClientEdits,
    sitesNeverEdited,
    totalClientEvents,
    distinctClientEditors,
    lastSyncAt,
    sitesWithErrors,
    unclassifiedUsers,
    eventsStored,
  } = overview;

  const pct =
    totalSites > 0 ? Math.round((sitesWithClientEdits / totalSites) * 100) : 0;

  if (totalSites === 0) {
    return (
      <div className="notice">
        <strong>No sites synced yet.</strong> Trigger the first run:
        <code style={{ display: "block", marginTop: 8, color: "var(--text-2)" }}>
          curl -H &quot;Authorization: Bearer $CRON_SECRET&quot;
          &quot;https://your-app/api/sync?offset=0&quot;
        </code>
      </div>
    );
  }

  return (
    <>
      {unclassifiedUsers > 0 && eventsStored > 0 && (
        <div className="notice">
          <strong>{unclassifiedUsers} users</strong> are currently counted as
          clients because they are not on the internal allowlist. If any of them
          are SpotOn designers, these numbers are overstated —{" "}
          <a href={`${basePath}/users`}>classify them</a>.
        </div>
      )}

      <div className="headline">
        <div className="big">
          <span className="accent">{sitesWithClientEdits}</span> of {totalSites}{" "}
          sites had a client edit
        </div>
        <div className="sub">
          in the last {windowDays} days — {pct}% of the portfolio.{" "}
          {totalClientEvents.toLocaleString()} edits by {distinctClientEditors}{" "}
          distinct client users.
        </div>
        <div className="bar">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="windows">
        {WINDOWS.map((d) => (
          <a
            key={d}
            href={`${basePath}/?days=${d}`}
            className={d === windowDays ? "on" : ""}
          >
            {d === 365 ? "1 year" : `${d} days`}
          </a>
        ))}
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Sites tracked</div>
          <div className="value">{totalSites.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Never client-edited</div>
          <div className="value warn">{sitesNeverEdited.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Events stored</div>
          <div className="value">{eventsStored.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Sync errors</div>
          <div className={`value ${sitesWithErrors > 0 ? "bad" : ""}`}>
            {sitesWithErrors}
          </div>
        </div>
        <div className="stat">
          <div className="label">Last sync</div>
          <div className="value" style={{ fontSize: 16 }}>
            {fmtDate(lastSyncAt)}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>
          Sites<span className="count">{sites.length} shown</span>
        </h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th className="num">Client edits ({windowDays}d)</th>
                <th className="num">Client users</th>
                <th>Last client edit</th>
                <th>Last activity</th>
                <th>Domain</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a
                      href={`https://webflow.com/design/${s.short_name ?? ""}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.display_name}
                    </a>
                    {s.sync_error && (
                      <div
                        className="muted"
                        style={{ fontSize: 11, marginTop: 2 }}
                      >
                        sync error
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {s.client_events > 0 ? (
                      s.client_events.toLocaleString()
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="num">
                    {s.client_editors > 0 ? (
                      s.client_editors
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td>{fmtDate(s.last_client_edit)}</td>
                  <td className="muted">{fmtDate(s.last_any_edit)}</td>
                  <td>
                    <DomainPill state={s.domain_state} />
                  </td>
                  <td>
                    <ActivityPill row={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sites.length === 0 && (
            <div className="empty">No sites yet — run a sync.</div>
          )}
        </div>
      </div>
    </>
  );
}
