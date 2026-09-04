/**
 * Domain registrar enrichment: apex extraction, RDAP lookups, name.com account
 * membership.
 *
 * Why RDAP and not WHOIS: RDAP is ICANN's mandated replacement. It's JSON over
 * HTTPS, so it works from a Cloudflare Worker with plain `fetch`, and the
 * registrar is a structured field rather than freeform text that differs per
 * TLD. WHOIS would need raw port-43 sockets and a regex per registry.
 */

// ---------------------------------------------------------------------------
// Apex (registrable domain) extraction
// ---------------------------------------------------------------------------

/**
 * Public suffixes that are two labels long. A domain under one of these keeps
 * three labels: "shop.co.uk" -> "shop.co.uk", not "co.uk".
 *
 * Deliberately a short list, not the full Public Suffix List — the portfolio is
 * overwhelmingly US restaurants on .com. Extend if a client turns up on
 * something exotic.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "org.nz",
  "com.mx", "org.mx",
  "com.br", "com.ar", "com.co", "com.pe", "com.ec",
  "co.za", "co.in", "co.jp", "co.kr",
  "com.sg", "com.hk", "com.my", "com.ph", "com.tr",
]);

/**
 * Collapse any hostname Webflow hands us to its registrable apex.
 *
 *   "www.peros.com"          -> "peros.com"
 *   "https://order.peros.com" -> "peros.com"
 *   "shop.example.co.uk"     -> "example.co.uk"
 *   "peros-pizza.webflow.io" -> null   (Webflow's own subdomain, not a client domain)
 */
export function toApexDomain(input: string | null | undefined): string | null {
  if (!input) return null;

  let host = input.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  host = host.split("/")[0].split("?")[0].split(":")[0];
  host = host.replace(/\.+$/, "");

  if (!host || !host.includes(".")) return null;
  if (host.endsWith(".webflow.io")) return null;

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.length === 2) return host;

  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** The label RDAP bootstrap keys on: "peros.com" -> "com", "x.co.uk" -> "uk". */
export function tldOf(apex: string): string {
  return apex.split(".").pop() ?? "";
}

// ---------------------------------------------------------------------------
// RDAP bootstrap (which server answers for which TLD)
// ---------------------------------------------------------------------------

const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 7 * 86_400_000;

interface IanaBootstrap {
  services: [string[], string[]][];
}

/**
 * Map of TLD -> RDAP base URL, cached in the `meta` table for a week.
 * The file is ~70KB; we don't want to pull it on every batch.
 */
export async function loadRdapBootstrap(
  db: D1Database,
): Promise<Map<string, string>> {
  const cached = await db
    .prepare(`SELECT value, updated_at FROM meta WHERE key = 'rdap_bootstrap'`)
    .first<{ value: string; updated_at: string }>();

  let json: IanaBootstrap | null = null;

  if (
    cached?.value &&
    Date.now() - Date.parse(cached.updated_at) < BOOTSTRAP_TTL_MS
  ) {
    try {
      json = JSON.parse(cached.value) as IanaBootstrap;
    } catch {
      json = null;
    }
  }

  if (!json) {
    const res = await fetch(IANA_BOOTSTRAP_URL, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`IANA RDAP bootstrap fetch failed: HTTP ${res.status}`);
    }
    json = (await res.json()) as IanaBootstrap;
    await db
      .prepare(
        `INSERT INTO meta (key, value, updated_at)
         VALUES ('rdap_bootstrap', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(json), new Date().toISOString())
      .run();
  }

  const map = new Map<string, string>();
  for (const [tlds, urls] of json.services ?? []) {
    const base = urls.find((u) => u.startsWith("https://")) ?? urls[0];
    if (!base) continue;
    const normalized = base.endsWith("/") ? base : `${base}/`;
    for (const tld of tlds) map.set(tld.toLowerCase(), normalized);
  }
  return map;
}

// ---------------------------------------------------------------------------
// RDAP lookup
// ---------------------------------------------------------------------------

export type RdapStatus = "ok" | "not_found" | "unsupported_tld" | "error";

export interface RdapResult {
  status: RdapStatus;
  registrarName: string | null;
  registrarIanaId: string | null;
  error: string | null;
}

interface RdapEntity {
  roles?: string[];
  handle?: string;
  vcardArray?: [string, unknown[][]];
  publicIds?: { type?: string; identifier?: string }[];
  entities?: RdapEntity[];
}

interface RdapDomain {
  entities?: RdapEntity[];
}

/** Depth-first search for the first entity carrying the `registrar` role. */
function findRegistrar(entities: RdapEntity[] | undefined): RdapEntity | null {
  for (const e of entities ?? []) {
    if ((e.roles ?? []).includes("registrar")) return e;
    const nested = findRegistrar(e.entities);
    if (nested) return nested;
  }
  return null;
}

/** Pull the `fn` (formatted name) out of a jCard. */
function vcardName(entity: RdapEntity): string | null {
  const props = entity.vcardArray?.[1];
  if (!Array.isArray(props)) return null;
  for (const prop of props) {
    if (Array.isArray(prop) && prop[0] === "fn" && typeof prop[3] === "string") {
      const v = prop[3].trim();
      if (v) return v;
    }
  }
  return null;
}

export async function rdapLookup(
  apex: string,
  bootstrap: Map<string, string>,
): Promise<RdapResult> {
  const base = bootstrap.get(tldOf(apex));
  if (!base) {
    return {
      status: "unsupported_tld",
      registrarName: null,
      registrarIanaId: null,
      error: `No RDAP server registered for .${tldOf(apex)}`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}domain/${encodeURIComponent(apex)}`, {
      headers: { accept: "application/rdap+json, application/json" },
      redirect: "follow",
    });
  } catch (err) {
    return {
      status: "error",
      registrarName: null,
      registrarIanaId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 404) {
    return { status: "not_found", registrarName: null, registrarIanaId: null, error: null };
  }
  if (!res.ok) {
    return {
      status: "error",
      registrarName: null,
      registrarIanaId: null,
      error: `HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`,
    };
  }

  let data: RdapDomain;
  try {
    data = (await res.json()) as RdapDomain;
  } catch {
    return { status: "error", registrarName: null, registrarIanaId: null, error: "Invalid JSON" };
  }

  const registrar = findRegistrar(data.entities);
  if (!registrar) {
    return { status: "ok", registrarName: null, registrarIanaId: null, error: null };
  }

  const ianaId =
    registrar.publicIds?.find((p) => (p.type ?? "").toUpperCase().includes("IANA"))
      ?.identifier ?? null;

  return {
    status: "ok",
    registrarName: vcardName(registrar) ?? registrar.handle ?? null,
    registrarIanaId: ianaId,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// name.com account membership
// ---------------------------------------------------------------------------

const NAMECOM_API = "https://api.name.com/core/v1";

/**
 * Every domain in the SpotOn name.com account, lowercased.
 *
 * This answers the one question RDAP can't: RDAP will say "Name.com, Inc." for
 * any domain registered there, including a client's own name.com account. Only
 * the account API can say whether it's in *ours*.
 */
export async function fetchNamecomDomains(
  username: string,
  token: string,
): Promise<Set<string>> {
  const auth = "Basic " + btoa(`${username}:${token}`);
  const out = new Set<string>();
  let page = 1;

  for (let guard = 0; guard < 100; guard++) {
    const res = await fetch(
      `${NAMECOM_API}/domains?perPage=1000&page=${page}&includeRenewalPrice=false`,
      { headers: { Authorization: auth, accept: "application/json" } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`name.com HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      domains?: { domainName?: string }[];
      nextPage?: number;
    };

    for (const d of data.domains ?? []) {
      if (d.domainName) out.add(d.domainName.toLowerCase());
    }

    if (!data.nextPage) break;
    page = data.nextPage;
  }

  return out;
}
