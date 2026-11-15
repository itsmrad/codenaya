/**
 * Where to connect an integration: inside a project, the project URL with
 * `?integrations=<providerId>` (opens the IDE integrations dialog on it);
 * outside one, the settings catalog.
 * shortcut: local stand-in with the CONNECTORS contract's signature; switch to
 * their helper (and its unknown-id fallback) when it merges.
 */
export const integrationLink = (providerId: string, projectId?: string): string => {
  const id = encodeURIComponent(providerId);
  return projectId ? `/projects/${projectId}?integrations=${id}` : `/settings/integrations?connect=${id}`;
};
