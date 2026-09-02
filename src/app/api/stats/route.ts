import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/db";
import { getOverview, getSiteSummaries } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * JSON / CSV feed of the same numbers the dashboard shows.
 *   /api/stats?days=30
 *   /api/stats?days=30&format=csv
 */
export async function GET(req: NextRequest) {
  const db = getEnv().DB;
  const url = new URL(req.url);
  const days = Math.min(
    3650,
    Math.max(1, Number(url.searchParams.get("days") ?? "30") || 30),
  );
  const format = url.searchParams.get("format");

  const [overview, sites] = await Promise.all([
    getOverview(db, days),
    getSiteSummaries(db, days),
  ]);

  if (format === "csv") {
    const header = [
      "site_id",
      "site_name",
      "client_events",
      "client_editors",
      "last_client_edit",
      "last_any_edit",
      "last_synced_at",
    ].join(",");

    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = sites.map((s) =>
      [
        s.id,
        s.display_name,
        s.client_events,
        s.client_editors,
        s.last_client_edit ?? "",
        s.last_any_edit ?? "",
        s.last_synced_at ?? "",
      ]
        .map(esc)
        .join(","),
    );

    return new NextResponse([header, ...rows].join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="client-edits-${days}d.csv"`,
      },
    });
  }

  return NextResponse.json({ overview, sites });
}
