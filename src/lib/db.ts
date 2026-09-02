import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Access the D1 binding + env vars. Must be called inside a request handler. */
export function getEnv(): CloudflareEnv {
  const { env } = getCloudflareContext();
  return env as CloudflareEnv;
}

export async function getEnvAsync(): Promise<CloudflareEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as CloudflareEnv;
}

export function getDb(): D1Database {
  return getEnv().DB;
}

/**
 * SQL fragment shared by every "is this a client edit?" query.
 *
 * An event counts as a client edit when it has a user attached AND that user is
 * absent from the internal_users allowlist. System events (NULL user_id, e.g.
 * automatic backups) are excluded — they are not attributable to anyone.
 */
export const CLIENT_EVENT_PREDICATE = `
  e.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM internal_users iu WHERE iu.user_id = e.user_id)
`;

/** ISO timestamp N days before now, for window filters. */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}
