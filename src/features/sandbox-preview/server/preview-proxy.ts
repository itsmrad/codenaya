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

/** Self-contained: serialized into the sandbox, with at most 16 KiB of carry. */
export function createBridgeInjector(bridge: string) {
  const limit = 16 * 1024;
  const script = Buffer.from(bridge);
  let carry = Buffer.alloc(0);
  let injected = false;
  const head = /<head(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>/i;

  // Like insertBridge: after <head>, else <html>, else the doctype (never before it: quirks mode), else the start.
  // An already-bridged page (marker within the carried bytes) is left alone.
  const place = (rest: Buffer): Buffer[] => {
    const text = carry.toString("latin1");
    const anchor = head.exec(text) || /<html(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(text) || /<!doctype[^>]*>/i.exec(text);
    const end = anchor ? anchor.index + anchor[0].length : 0;
    const output = text.includes("data-codenaya-preview")
      ? [carry, rest]
      : [carry.subarray(0, end), script, carry.subarray(end), rest];
    carry = Buffer.alloc(0);
    injected = true;
    return output;
  };

  return {
    push(chunk: Buffer): Buffer[] {
      if (injected) return [chunk];
      const taken = Math.min(chunk.length, limit - carry.length);
      carry = Buffer.concat([carry, chunk.subarray(0, taken)]);
      // Latin-1 gives ASCII tag matches byte offsets; UTF-8 bytes are never decoded/re-encoded.
      if (carry.length < limit && !head.test(carry.toString("latin1"))) return [];
      return place(chunk.subarray(taken));
    },
    flush(): Buffer[] {
      return injected ? [] : place(Buffer.alloc(0));
    },
  };
}
