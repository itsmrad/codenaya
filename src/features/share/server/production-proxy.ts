/** Self-contained: serialized into the public sandbox, without the IDE preview bridge. */
export function publicFrameHeaders(headers: Record<string, string | string[] | undefined>, origin: string) {
  const result = { ...headers };
  delete result["x-frame-options"];
  // Preserve the site's other CSP restrictions; replace only its embedding policy.
  const policies = [headers["content-security-policy"] ?? []].flat();
  result["content-security-policy"] = (policies.length ? policies : [""]).map(policy =>
    [...policy.split(";").map(part => part.trim()).filter(part => part && !/^frame-ancestors(?:\s|$)/i.test(part)),
      `frame-ancestors ${origin}`].join("; "));
  return result;
}

export function productionProxy(origin: string) {
  return `
import http from 'node:http';
const frameHeaders = ${publicFrameHeaders.toString()};
http.createServer((req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: 3000, path: req.url, method: req.method,
    headers: { ...req.headers, host: 'localhost:3000' } }, incoming => {
    res.writeHead(incoming.statusCode || 502, frameHeaders(incoming.headers, ${JSON.stringify(origin)}));
    incoming.pipe(res);
    incoming.on('error', () => res.destroy());
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Site unavailable'); });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}).listen(4000, '0.0.0.0');
`;
}
