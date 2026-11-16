const DEFAULT_ORIGINS = "http://localhost:3100,https://codenaya.tech";

/** Deployment configuration only: never trust request Host/Origin for an embedding policy. */
export function publicPreviewOrigins(config = process.env.CODENAYA_PUBLIC_PREVIEW_ORIGINS ?? DEFAULT_ORIGINS): string[] {
  const values = config.split(",").map(value => value.trim());
  const origins = values.map(value => {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== value || url.username || url.password ||
        !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
      throw new Error("CODENAYA_PUBLIC_PREVIEW_ORIGINS must contain exact HTTPS origins or HTTP loopback origins");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}
