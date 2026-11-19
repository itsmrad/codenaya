// Production is served from www (the apex 308-redirects there); CSP host-sources match exact hosts.
const DEFAULT_ORIGINS = ["http://localhost:3100", "https://codenaya.tech", "https://www.codenaya.tech"];

function exactOrigin(value: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new Error("CODENAYA_PUBLIC_PREVIEW_ORIGINS must contain exact HTTPS origins or HTTP loopback origins");
  }
  return url.origin;
}

/** Defaults plus the deployment's own app origin, so a deployment never forgets itself; an invalid app URL is ignored. */
function defaultOrigins() {
  try {
    const app = process.env.NEXT_PUBLIC_APP_URL;
    if (app) return [...DEFAULT_ORIGINS, exactOrigin(new URL(app).origin)].join(",");
  } catch { /* unset, unparsable or non-HTTPS app URL: keep the fixed defaults */ }
  return DEFAULT_ORIGINS.join(",");
}

/** Deployment configuration only: never trust request Host/Origin for an embedding policy. */
export function publicPreviewOrigins(config = process.env.CODENAYA_PUBLIC_PREVIEW_ORIGINS ?? defaultOrigins()): string[] {
  return [...new Set(config.split(",").map(value => exactOrigin(value.trim())))];
}
