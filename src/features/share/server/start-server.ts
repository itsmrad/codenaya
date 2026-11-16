/** Node production adapter for Start's default fetch-handler output (no Nitro plugin). */
export const START_SERVER = `
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const root = resolve('dist/client');
const { default: entry } = await import(resolve('dist/server/server.js'));
const types = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.txt':'text/plain' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:3000');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (path.endsWith('.map') || !path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = await stat(path).catch(() => null);
      if (file?.isFile() && (await realpath(path)).startsWith(root + sep)) {
        res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
        if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res);
        return;
      }
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
    const response = await entry.fetch(new Request(url, { method: req.method, headers, body, duplex: 'half' }));
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.writeHead(response.status);
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Site unavailable'); }
}).listen(3000, '0.0.0.0');
`;
