export const supportedProviders = (models: readonly { provider: string }[]) =>
  [...new Set(models.map((model) => model.provider))];

export const formatProjectsBuilt = (count: number | undefined) =>
  count ? `${count.toLocaleString("en-US")} ${count === 1 ? "project" : "projects"} built` : null;
