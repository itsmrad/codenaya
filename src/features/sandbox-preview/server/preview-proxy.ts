/** Self-contained: serialized into the proxy for HTTP and websocket upgrades. */
export function rewriteProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
  port: number,
): Record<string, string | string[] | undefined> {
  const target = "localhost:" + port;
  const rewritten: Record<string, string | string[] | undefined> = { ...headers, host: target };
  if (headers.origin !== undefined) rewritten.origin = "http://" + target;
  return rewritten;
}
