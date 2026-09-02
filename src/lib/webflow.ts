import type {
  WebflowActivityEvent,
  WebflowPagination,
  WebflowSite,
} from "./types";

const API_BASE = "https://api.webflow.com/v2";
const MAX_PAGE_SIZE = 100; // Webflow's hard cap on activity_logs `limit`

export class WebflowError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebflowError";
  }
}

/** Thrown when a site's activity log is unavailable (non-Enterprise, or token not scoped to it). */
export class ActivityUnavailableError extends WebflowError {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single API call with 429 handling.
 *
 * Webflow returns `Retry-After` (usually 60s) alongside a 429. We honour it,
 * but cap the wait so one throttled site can't stall a whole batch past the
 * Worker's wall-clock budget.
 */
async function request<T>(
  path: string,
  token: string,
  opts: { maxRetries?: number; maxRetryWaitMs?: number } = {},
): Promise<T> {
  const { maxRetries = 3, maxRetryWaitMs = 15_000 } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });

    if (res.ok) return (await res.json()) as T;

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
      const waitMs = Math.min(retryAfter * 1000, maxRetryWaitMs);
      await sleep(waitMs);
      continue;
    }

    const body = await res.text().catch(() => "");
    const message = `Webflow ${res.status} on ${path}: ${body.slice(0, 300)}`;

    // 403 = plan/scope refusal, 404 = site not visible to this token.
    // Both mean "never going to work for this site", not "try again later".
    if (res.status === 403 || res.status === 404) {
      throw new ActivityUnavailableError(message, res.status);
    }
    throw new WebflowError(message, res.status);
  }

  throw new WebflowError(`Exhausted retries on ${path}`, 429);
}

/**
 * Every site the token can see.
 *
 * Note: a *site* token only ever returns the one site it was minted for.
 * Covering the whole portfolio requires a workspace-installed OAuth app token.
 * See README, "Authorizing across all sites".
 */
export async function listSites(token: string): Promise<WebflowSite[]> {
  const out: WebflowSite[] = [];
  let offset = 0;

  for (;;) {
    const data = await request<{
      sites: WebflowSite[];
      pagination?: WebflowPagination;
    }>(`/sites?limit=100&offset=${offset}`, token);

    const batch = data.sites ?? [];
    out.push(...batch);

    const p = data.pagination;
    if (!p || out.length >= p.total || batch.length === 0) break;
    offset += batch.length;
  }

  return out;
}

/**
 * Newest-first page of a site's activity log.
 * Enterprise-only endpoint; requires the `site_activity:read` scope.
 */
export async function getActivityPage(
  token: string,
  siteId: string,
  offset: number,
  limit: number = MAX_PAGE_SIZE,
): Promise<{ items: WebflowActivityEvent[]; pagination: WebflowPagination }> {
  const data = await request<{
    items?: WebflowActivityEvent[];
    pagination?: WebflowPagination;
  }>(
    `/sites/${siteId}/activity_logs?limit=${Math.min(limit, MAX_PAGE_SIZE)}&offset=${offset}`,
    token,
  );

  return {
    items: data.items ?? [],
    pagination: data.pagination ?? { limit, offset, total: 0 },
  };
}

/**
 * Pull everything new for one site.
 *
 * The endpoint offers no date filter — only limit/offset over a newest-first
 * list — so incremental sync works by walking pages until we recognise the
 * watermark event id from the previous run. On a site's first ever sync there
 * is no watermark, so we instead stop at `backfillCutoff` to bound the cost.
 */
export async function fetchNewEvents(
  token: string,
  siteId: string,
  opts: {
    knownEventId?: string | null;
    backfillCutoff?: Date;
    maxPages?: number;
  } = {},
): Promise<{ events: WebflowActivityEvent[]; reachedWatermark: boolean }> {
  const { knownEventId, backfillCutoff, maxPages = 40 } = opts;

  const events: WebflowActivityEvent[] = [];
  let reachedWatermark = false;
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const { items, pagination } = await getActivityPage(token, siteId, offset);
    if (items.length === 0) break;

    for (const item of items) {
      if (knownEventId && item.id === knownEventId) {
        reachedWatermark = true;
        break;
      }
      if (
        !knownEventId &&
        backfillCutoff &&
        new Date(item.createdOn) < backfillCutoff
      ) {
        reachedWatermark = true;
        break;
      }
      events.push(item);
    }

    if (reachedWatermark) break;

    offset += items.length;
    if (pagination.total && offset >= pagination.total) break;
  }

  return { events, reachedWatermark };
}

/** Run async work over a list with bounded concurrency, to stay inside rate limits. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
