import { isProviderVisible } from "./catalog";

/** Inside a project, `?integrations=<providerId>` opens the integrations dialog. */
export const PROJECT_INTEGRATIONS_PARAM = "integrations";
/** On the settings page, `?connect=<providerId>` opens that provider's dialog. */
export const SETTINGS_CONNECT_PARAM = "connect";

/** A visible catalog provider id from a URL value; unknown or hidden ids mean the plain catalog. */
export const linkedProviderId = (value: string | null | undefined): string | undefined =>
  value && isProviderVisible(value) ? value : undefined;

/**
 * Where to send a user to connect or manage a provider.
 *
 * With a project: its IDE, with the integrations dialog open on that provider
 * (Manage if connected, else Add). Without: the integrations settings page.
 * Unknown or hidden ids land on the plain catalog. Inside the IDE itself,
 * `useProjectIntegrations().openIntegrations(providerId)` avoids a navigation
 * that would drop the page's other query params.
 */
export const integrationLink = (providerId: string, projectId?: string): string => {
  const id = linkedProviderId(providerId);
  if (projectId) {
    const params = new URLSearchParams({ [PROJECT_INTEGRATIONS_PARAM]: id ?? "" });
    return `/projects/${encodeURIComponent(projectId)}?${params}`;
  }
  return id
    ? `/settings/integrations?${new URLSearchParams({ [SETTINGS_CONNECT_PARAM]: id })}`
    : "/settings/integrations";
};
