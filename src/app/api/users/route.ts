import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/db";
import { getUsers } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getEnv().DB;
  return NextResponse.json({ users: await getUsers(db) });
}

/**
 * Toggle a Webflow user on/off the internal allowlist.
 * Body: { userId: string, displayName?: string, internal: boolean }
 *
 * Because classification is resolved at query time, flipping a user here
 * retroactively corrects every figure on the dashboard — no re-sync needed.
 */
export async function POST(req: NextRequest) {
  const db = getEnv().DB;

  let body: { userId?: string; displayName?: string; internal?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { userId, displayName, internal } = body;
  if (!userId || typeof internal !== "boolean") {
    return NextResponse.json(
      { error: "userId (string) and internal (boolean) are required" },
      { status: 400 },
    );
  }

  if (internal) {
    await db
      .prepare(
        `INSERT INTO internal_users (user_id, display_name)
         VALUES (?1, ?2)
         ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name`,
      )
      .bind(userId, displayName ?? null)
      .run();
  } else {
    await db
      .prepare(`DELETE FROM internal_users WHERE user_id = ?1`)
      .bind(userId)
      .run();
  }

  return NextResponse.json({ ok: true, userId, internal });
}
