"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UnclassifiedUserRow } from "@/lib/types";

const basePath = process.env.NEXT_PUBLIC_BASE_URL || "";

function fmt(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export default function UserTable({ users }: { users: UnclassifiedUserRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(u: UnclassifiedUserRow) {
    setBusy(u.user_id);
    setError(null);
    try {
      const res = await fetch(`${basePath}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: u.user_id,
          displayName: u.user_name,
          internal: u.is_internal !== 1,
        }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>
        Webflow users<span className="count">{users.length}</span>
      </h2>
      {error && (
        <div style={{ padding: "10px 18px", color: "var(--red)" }}>{error}</div>
      )}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Sites</th>
              <th className="num">Events</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Counted as</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id}>
                <td>
                  {u.user_name ?? <span className="muted">(no name)</span>}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {u.user_id}
                  </div>
                </td>
                <td className="num">{u.site_count}</td>
                <td className="num">{u.event_count.toLocaleString()}</td>
                <td className="muted">{fmt(u.first_seen)}</td>
                <td className="muted">{fmt(u.last_seen)}</td>
                <td>
                  {u.is_internal === 1 ? (
                    <span className="pill internal">SpotOn</span>
                  ) : (
                    <span className="pill client">Client</span>
                  )}
                </td>
                <td>
                  <button
                    className="toggle"
                    onClick={() => toggle(u)}
                    disabled={busy === u.user_id || pending}
                  >
                    {busy === u.user_id
                      ? "…"
                      : u.is_internal === 1
                        ? "Mark client"
                        : "Mark SpotOn"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="empty">No users seen yet — run a sync.</div>
        )}
      </div>
    </div>
  );
}
