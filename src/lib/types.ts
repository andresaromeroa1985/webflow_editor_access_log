export interface WebflowCustomDomain {
  id: string;
  url?: string | null;
  /** Null means the domain is attached but has never been published to. */
  lastPublished?: string | null;
}

export interface WebflowSite {
  id: string;
  displayName: string;
  shortName?: string | null;
  workspaceId?: string | null;
  lastPublished?: string | null;
  customDomains?: WebflowCustomDomain[] | null;
}

/** How a site relates to a custom domain. */
export type DomainState = "none" | "unpublished" | "live";

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
  domain_state: DomainState;
  custom_domain_count: number;
}

export interface DomainSiteRow {
  id: string;
  display_name: string;
  short_name: string | null;
  domain_state: DomainState;
  custom_domain_count: number;
  custom_domains_json: string | null;
  domain_last_published: string | null;
  last_published: string | null;
}

export interface DomainOverview {
  totalSites: number;
  none: number;
  unpublished: number;
  live: number;
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
