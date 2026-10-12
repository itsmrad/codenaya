/**
 * Helpers and fallback static server script for projects without package.json (Issue #262).
 * Enables static HTML projects to run seamlessly on both E2B and WebContainer engines.
 */

export const STATIC_SERVER_SCRIPT = `
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = req.url ? req.url.split('?')[0] : '/';
  if (reqPath === '/') reqPath = '/index.html';
  let filePath = path.join(process.cwd(), reqPath);

  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    } else {
      filePath = path.join(process.cwd(), 'index.html');
    }
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Static server listening on port ' + PORT);
});
`.trim();

/** Check whether a files list contains a root or workspace package.json. */
export function hasPackageJson(paths: string[]): boolean {
  return paths.some((p) => {
    const norm = p.replace(/^\/+/, "");
    return norm === "package.json" || norm.endsWith("/package.json");
  });
}

/** Check whether a files list contains a root index.html or index.htm. */
export function hasIndexHtml(paths: string[]): boolean {
  return paths.some((p) => {
    const norm = p.replace(/^\/+/, "");
    return norm === "index.html" || norm === "index.htm";
  });
}
