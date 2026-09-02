export interface WebflowSite {
  id: string;
  displayName: string;
  shortName?: string | null;
  workspaceId?: string | null;
  lastPublished?: string | null;
}

export interface WebflowActivityUser {
  id: string;
  displayName?: string | null;
}

export interface WebflowActivityEvent {
  id: string;
  createdOn: string;
  lastUpdated?: string;
  event: string;
  resourceOperation?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  /** Absent on system-generated events such as automatic backups. */
  user?: WebflowActivityUser | null;
  source?: string | null;
  actorType?: string | null;
  payload?: unknown;
}

export interface WebflowPagination {
  limit: number;
  offset: number;
  total: number;
}

export interface SiteRow {
  id: string;
  display_name: string;
  short_name: string | null;
  last_published: string | null;
  activity_supported: number;
  last_synced_at: string | null;
  sync_error: string | null;
}

export interface SiteSummaryRow {
  id: string;
  display_name: string;
  short_name: string | null;
  last_synced_at: string | null;
  sync_error: string | null;
  activity_supported: number;
  client_events: number;
  client_editors: number;
  last_client_edit: string | null;
  last_any_edit: string | null;
}

export interface UnclassifiedUserRow {
  user_id: string;
  user_name: string | null;
  event_count: number;
  site_count: number;
  first_seen: string;
  last_seen: string;
  is_internal: number;
}
