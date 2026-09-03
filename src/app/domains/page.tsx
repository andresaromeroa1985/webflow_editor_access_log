import { getEnvAsync, fmtDate } from "@/lib/db";
import { getDomainOverview, getDomainSites } from "@/lib/queries";
import type { DomainSiteRow, DomainState, WebflowCustomDomain } from "@/lib/types";

export const dynamic = "force-dynamic";

const basePath = process.env.BASE_URL || "";

const STATES: { key: DomainState | "all"; label: string }[] = [
  { key: "all", label: "All sites" },
  { key: "unpublished", label: "Attached, not published" },
  { key: "none", label: "No domain" },
  { key: "live", label: "Live" },
];

function StatePill({ state }: { state: DomainState }) {
  if (state === "live") return <span className="pill active">Live</span>;
  if (state === "unpublished")
    return <span className="pill client">Not published</span>;
  return <span className="pill never">No domain</span>;
}

function domainList(row: DomainSiteRow): string {
  if (!row.custom_domains_json) return "—";
  try {
    const parsed = JSON.parse(row.custom_domains_json) as WebflowCustomDomain[];
    const urls = parsed.map((d) => d.url).filter(Boolean);
    return urls.length > 0 ? urls.join(", ") : "—";
  } catch {
    return "—";
  }
}

export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const params = await searchParams;
  const raw = params.state;
  const filter: DomainState | undefined =
    raw === "none" || raw === "unpublished" || raw === "live" ? raw : undefined;

  const env = await getEnvAsync();

  let overview;
  let sites: DomainSiteRow[] = [];
  try {
    [overview, sites] = await Promise.all([
      getDomainOverview(env.DB),
      getDomainSites(env.DB, filter),
    ]);
  } catch (err) {
    return (
      <div className="notice">
        <strong>Domain data not available.</strong> This needs migration{" "}
        <code>0002_domains.sql</code> applied and one sync run to populate it.
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {err instanceof Error ? err.message : String(err)}
        </div>
      </div>
    );
  }

  const { totalSites, none, unpublished, live, activitySupported, unpopulated } =
    overview;
  const pct = (n: number) =>
    totalSites > 0 ? Math.round((n / totalSites) * 100) : 0;

  if (totalSites === 0) {
    return (
      <div className="notice">
        <strong>No sites yet.</strong> Run a sync first.
      </div>
    );
  }

  // Every site defaulting to 'none' means the roster refresh hasn't run since
  // migration 0002 — not that nobody has a domain.
  const looksUnpopulated = unpopulated === totalSites;

  return (
    <>
      {looksUnpopulated && (
        <div className="notice">
          <strong>Domain data hasn&apos;t been collected yet.</strong> All{" "}
          {totalSites} sites are showing the migration default. Run a sync at{" "}
          <code>/api/sync?offset=0</code> — the roster refresh is what populates
          these columns — then reload.
        </div>
      )}

      <div className="headline">
        <div className="big">
          <span className="accent">{live}</span> of {totalSites} sites are live
          on a custom domain
        </div>
        <div className="sub">
          {pct(live)}% of the portfolio. {unpublished} have a domain attached but
          have never published to it, and {none} are still on a{" "}
          <code>.webflow.io</code> subdomain.
        </div>
        <div className="bar">
          <span style={{ width: `${pct(live)}%` }} />
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Live on domain</div>
          <div className="value">{live.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Attached, not published</div>
          <div className="value warn">{unpublished.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">No custom domain</div>
          <div className="value bad">{none.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Total sites</div>
          <div className="value">{totalSites.toLocaleString()}</div>
        </div>
      </div>

      {activitySupported !== totalSites && (
        <p className="muted" style={{ fontSize: 12, marginTop: -12 }}>
          This page counts all {totalSites} sites in the workspace. The
          dashboard shows {activitySupported} because{" "}
          {totalSites - activitySupported} sites return an error on the activity
          log endpoint — their domain status is still accurate here.
        </p>
      )}

      {unpublished > 0 && (
        <div className="notice">
          <strong>{unpublished} sites have a domain attached that was never
          published to.</strong> These are usually half-finished launches — DNS
          was configured but the site was never pushed live on it.
        </div>
      )}

      <div className="windows">
        {STATES.map((s) => {
          const href =
            s.key === "all"
              ? `${basePath}/domains`
              : `${basePath}/domains?state=${s.key}`;
          const active = s.key === "all" ? !filter : filter === s.key;
          return (
            <a key={s.key} href={href} className={active ? "on" : ""}>
              {s.label}
            </a>
          );
        })}
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
                <th>Custom domain</th>
                <th className="num">Domains</th>
                <th>Domain last published</th>
                <th>Site last published</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td>{s.display_name}</td>
                  <td className={s.custom_domain_count ? "" : "muted"}>
                    {domainList(s)}
                  </td>
                  <td className="num">
                    {s.custom_domain_count > 0 ? (
                      s.custom_domain_count
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td>{fmtDate(s.domain_last_published)}</td>
                  <td className="muted">{fmtDate(s.last_published)}</td>
                  <td>
                    <StatePill state={s.domain_state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sites.length === 0 && (
            <div className="empty">No sites in this category.</div>
          )}
        </div>
      </div>
    </>
  );
}
