import { getEnvAsync } from "@/lib/db";
import { getUsers } from "@/lib/queries";
import UserTable from "./UserTable";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const env = await getEnvAsync();

  let users;
  try {
    users = await getUsers(env.DB);
  } catch {
    return (
      <div className="notice">
        <strong>Database not ready.</strong> Run a sync first.
      </div>
    );
  }

  const internal = users.filter((u) => u.is_internal === 1).length;
  const clients = users.length - internal;

  return (
    <>
      <div className="notice">
        <strong>This page defines the metric.</strong> The activity log gives us
        a user&apos;s ID and display name but never their email or role, so
        &quot;client edit&quot; means <em>an edit by someone not on this
        allowlist</em>. Mark every SpotOn designer as internal. A user appearing
        across many sites is almost certainly staff; a user on exactly one site
        is almost certainly that client.
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Users seen</div>
          <div className="value">{users.length}</div>
        </div>
        <div className="stat">
          <div className="label">Marked internal</div>
          <div className="value">{internal}</div>
        </div>
        <div className="stat">
          <div className="label">Counted as clients</div>
          <div className="value warn">{clients}</div>
        </div>
      </div>

      <UserTable users={users} />
    </>
  );
}
