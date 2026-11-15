/** Self-contained: serialized into the proxy for HTTP and websocket upgrades. */
export function rewriteProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
  port: number,
): Record<string, string | string[] | undefined> {
  const target = "localhost:" + port;
  const rewritten: Record<string, string | string[] | undefined> = Object.assign({}, headers, { host: target });
  // Next Server Actions prefers the edge's forwarded host over Host.
  delete rewritten["x-forwarded-host"];
  delete rewritten["x-forwarded-proto"];
  if (headers.origin !== undefined) rewritten.origin = "http://" + target;
  return rewritten;
}

/** Self-contained too: redirects and bodyless responses must pass through intact. */
export function shouldInjectBridge(
  method: string | undefined,
  status: number | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return method === "GET" && status !== undefined && status >= 200 &&
    (status < 300 || status >= 400) && status !== 204 && status !== 205 &&
    String(headers["content-type"] || "").includes("text/html") && !headers["content-encoding"];
}
