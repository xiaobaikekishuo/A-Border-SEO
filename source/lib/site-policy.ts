/*
 * The rules for adding and removing sites. The default policy allows
 * every site a user can see in Search Console and does nothing after a site
 * is added or deleted. A deployment that limits sites, or keeps something in
 * step with them, registers its own policy with setSitePolicy (from
 * extensions/index.ts) instead of editing the site routes.
 *
 * Two requests adding a site at the same moment can both pass canAdd: a
 * policy that counts sites should tolerate one site over its limit, or check
 * again in afterCreate.
 */

export type SitePermission = { ok: true } | { ok: false; reason: string; status: number };

export type SitePolicy = {
  /**
   * Whether this user may add this site. `status` is the HTTP status a
   * refusal maps to. Also asked about an edited site when there is no
   * canUpdate; `siteId` is set then, so a rule that counts sites can leave
   * that one out.
   */
  canAdd?: (
    user: { id: string },
    site: { domain: string; gscProperty: string | null; siteId?: string }
  ) => Promise<SitePermission>;
  /**
   * Whether this user may point an existing site at another domain or Search
   * Console property (PUT /api/sites/[siteId]). Asked only when one of them
   * really changes, with the values after the change. Without it, canAdd is
   * asked instead, so a policy that only checks new sites cannot be bypassed
   * by editing one.
   */
  canUpdate?: (
    user: { id: string },
    site: { id: string; domain: string; gscProperty: string | null }
  ) => Promise<SitePermission>;
  /** After the site row exists and its first sync is queued. Errors are logged, never shown to the user. */
  afterCreate?: (site: { id: string; userId: string; domain: string; gscProperty: string | null }) => Promise<void>;
  /** After the site row is deleted. Not called when a whole account is deleted. Errors are logged. */
  afterDelete?: (site: { id: string; userId: string; domain: string }) => Promise<void>;
};

/** On globalThis like the job handler registry: a route and a server action may load separate copies of this module. */
const holder = globalThis as unknown as { aborderSitePolicy?: SitePolicy };

/** Replaces the site policy for this process. null restores the default. */
export function setSitePolicy(policy: SitePolicy | null): void {
  holder.aborderSitePolicy = policy ?? undefined;
}

export async function canAddSite(
  user: { id: string },
  site: { domain: string; gscProperty: string }
): Promise<SitePermission> {
  const canAdd = holder.aborderSitePolicy?.canAdd;
  return canAdd ? canAdd(user, site) : { ok: true };
}

/** Asked only when the domain or the Search Console property changes. */
export async function canUpdateSite(
  user: { id: string },
  site: { id: string; domain: string; gscProperty: string | null }
): Promise<SitePermission> {
  const policy = holder.aborderSitePolicy;
  if (policy?.canUpdate) return policy.canUpdate(user, site);
  if (policy?.canAdd) return policy.canAdd(user, { domain: site.domain, gscProperty: site.gscProperty, siteId: site.id });
  return { ok: true };
}

export async function siteCreated(site: Parameters<NonNullable<SitePolicy["afterCreate"]>>[0]): Promise<void> {
  try {
    await holder.aborderSitePolicy?.afterCreate?.(site);
  } catch (err) {
    console.error(`[sites] after-create hook failed for site ${site.id}:`, err);
  }
}

export async function siteDeleted(site: Parameters<NonNullable<SitePolicy["afterDelete"]>>[0]): Promise<void> {
  try {
    await holder.aborderSitePolicy?.afterDelete?.(site);
  } catch (err) {
    console.error(`[sites] after-delete hook failed for site ${site.id}:`, err);
  }
}
