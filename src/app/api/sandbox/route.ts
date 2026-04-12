import { Sandbox } from "e2b";
import { auth } from "@clerk/nextjs/server";

/**
 * POST /api/sandbox
 *
 * Creates an E2B sandbox, writes project files, installs dependencies,
 * and starts the dev server. Streams terminal output back as NDJSON so
 * the client can render it in real-time.
 *
 * Response format (NDJSON – one JSON object per line):
 *   { "type": "status", "status": "installing" | "running" }
 *   { "type": "output", "data": "..." }
 *   { "type": "ready",  "sandboxId": "...", "previewUrl": "..." }
 *   { "type": "error",  "message": "..." }
 */

const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour (E2B free plan max)
const WORK_DIR = "/home/user/app";

/**
 * Environment variables that force dev servers to bind to 0.0.0.0
 * instead of localhost. E2B port forwarding only works when the
 * server listens on all interfaces.
 */
const DEV_SERVER_ENVS: Record<string, string> = {
  HOST: "0.0.0.0",           // Create React App, Vite (some versions)
  HOSTNAME: "0.0.0.0",       // Next.js
};

/**
 * Regex patterns to detect the port from dev server stdout.
 * Matches URLs like:
 *   http://localhost:5173/
 *   http://0.0.0.0:3000/
 *   http://127.0.0.1:8080
 *   https://localhost:4321/
 *   ➜  Local:   http://localhost:5173/
 *   ➜  Network: http://169.254.0.21:5173/
 */
const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[\d.]+):(\d+)/,
  /port\s+(\d+)/i,
  /listening\s+(?:on\s+)?(?:port\s+)?(\d+)/i,
];

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const {
    files,
    settings,
  } = body as {
    files: { path: string; content: string }[];
    settings?: { installCommand?: string; devCommand?: string };
  };

  if (!files || files.length === 0) {
    return Response.json({ error: "No files provided" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        } catch {
          // Controller may already be closed — ignore
        }
      };

      let sandbox: Sandbox | null = null;

      try {
        // --- Boot sandbox ---
        send({ type: "status", status: "booting" });
        send({ type: "output", data: "Creating E2B sandbox...\n" });

        sandbox = await Sandbox.create({
          timeoutMs: SANDBOX_TIMEOUT_MS,
          metadata: { userId },
          network: {
            maskRequestHost: "localhost:${PORT}",
          },
        });

        send({
          type: "output",
          data: `Sandbox ${sandbox.sandboxId} created.\n`,
        });

        // --- Verify Node.js is available ---
        send({ type: "output", data: "Checking Node.js...\n" });
        const nodeCheck = await sandbox.commands.run("node --version", {
          timeoutMs: 10_000,
        });

        if (nodeCheck.exitCode !== 0) {
          throw new Error(
            "Node.js is not available in this sandbox. " +
              `stderr: ${nodeCheck.stderr}`
          );
        }

        send({
          type: "output",
          data: `Node ${nodeCheck.stdout.trim()} available.\n\n`,
        });

        // --- Write project files ---
        send({ type: "output", data: "Writing project files...\n" });

        await sandbox.files.makeDir(WORK_DIR);

        for (const file of files) {
          await sandbox.files.write(
            `${WORK_DIR}/${file.path}`,
            file.content
          );
        }

        send({
          type: "output",
          data: `Wrote ${files.length} file(s) to sandbox.\n\n`,
        });

        // --- Install dependencies ---
        const installCmd = settings?.installCommand || "npm install";
        send({ type: "status", status: "installing" });
        send({ type: "output", data: `$ ${installCmd}\n` });

        const installResult = await sandbox.commands.run(installCmd, {
          cwd: WORK_DIR,
          timeoutMs: 5 * 60 * 1000,
          onStdout: (data) => send({ type: "output", data }),
          onStderr: (data) => send({ type: "output", data }),
        });

        if (installResult.exitCode !== 0) {
          throw new Error(
            `${installCmd} failed with exit code ${installResult.exitCode}\n` +
              installResult.stderr
          );
        }

        send({ type: "output", data: "\nDependencies installed.\n\n" });

        // --- Start dev server directly without hacking configs ---
        const devCmd = settings?.devCommand || "npm run dev";
        const devCmdWithHost = appendHostFlag(devCmd);
        
        send({ type: "output", data: `$ ${devCmdWithHost}\n` });

        // Track the port detected from dev server output
        let detectedPort: number | null = null;

        await sandbox.commands.run(devCmdWithHost, {
          cwd: WORK_DIR,
          background: true,
          timeoutMs: 0, // Prevent E2B from killing the dev server after the default 60s timeout
          envs: DEV_SERVER_ENVS,
          onStdout: (data) => {
            send({ type: "output", data });
            if (!detectedPort) {
              detectedPort = parsePortFromOutput(data);
            }
          },
          onStderr: (data) => {
            send({ type: "output", data });
            if (!detectedPort) {
              detectedPort = parsePortFromOutput(data);
            }
          },
        });

        // Wait for the port to be detected from stdout, or fall back
        // to polling common ports
        send({ type: "output", data: "\nWaiting for dev server...\n" });

        const localPort = await waitForServerPort(sandbox, () => detectedPort);

        if (!localPort) {
          throw new Error(
            "Could not detect dev server port. " +
              "Check the terminal output above for errors."
          );
        }

        // Start the proxy to bypass Vite allowedHosts and bind issues
        const proxyPort = await startE2bProxy(sandbox, localPort);

        const host = sandbox.getHost(proxyPort);
        const previewUrl = `https://${host}`;

        // Give E2B's external networking edge enough time to correctly map
        // the newly opened 4000 port to the public domain before mounting iframe
        send({ type: "output", data: "\nConfiguring external network routing...\n" });
        await new Promise((resolve) => setTimeout(resolve, 3000));

        send({ type: "output", data: `\nServer ready at ${previewUrl}\n` });
        send({ type: "status", status: "running" });
        send({
          type: "ready",
          sandboxId: sandbox.sandboxId,
          previewUrl,
        });

        // Keep the NDJSON stream alive indefinitely until the client disconnects!
        // This ensures the E2B sandbox isn't prematurely garbage collected,
        // and allows us to stream continuous logs from the dev server to the UI.
        await new Promise((resolve) => {
          request.signal.addEventListener("abort", () => {
            resolve(null);
          });
        });

      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        send({ type: "output", data: `\nError: ${message}\n` });
        send({ type: "error", message });

        // Kill sandbox on error to free up the slot
        if (sandbox) {
          try {
            await sandbox.kill();
          } catch {
            // Best-effort cleanup
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Parse a port number from dev server stdout/stderr.
 * Handles Vite, Next.js, CRA, Express, etc.
 */
function parsePortFromOutput(output: string): number | null {
  for (const pattern of PORT_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[1]) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) {
        return port;
      }
    }
  }
  return null;
}

/**
 * Wait for the dev server port to become available.
 *
 * Strategy:
 * 1. Check if the port was already detected from stdout
 * 2. If not, poll common dev server ports
 *
 * Returns the port number, or null if nothing found.
 */
async function waitForServerPort(
  sandbox: Sandbox,
  getDetectedPort: () => number | null,
  maxWaitMs = 60_000
): Promise<number | null> {
  const start = Date.now();
  const checkInterval = 1500;
  const commonPorts = [5173, 3000, 3001, 4321, 8080, 8000];

  while (Date.now() - start < maxWaitMs) {
    // First, check if stdout already told us the port
    const detected = getDetectedPort();
    if (detected) {
      // Verify the port is actually responding
      const isOpen = await isPortOpen(sandbox, detected);
      if (isOpen) return detected;
    }

    // Fall back to scanning common ports
    for (const port of commonPorts) {
      if (port === 4000) continue; // Skip proxy port
      const isOpen = await isPortOpen(sandbox, port);
      if (isOpen) return port;
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  // Last resort: return the detected port even if we couldn't verify
  // (the server might be slow to respond to curl but is actually running)
  return getDetectedPort();
}

/**
 * Append --host 0.0.0.0 to the dev command so the server binds to all
 * interfaces. E2B port forwarding requires this.
 */
function appendHostFlag(devCmd: string): string {
  if (devCmd.includes("--host") || devCmd.includes("-H ")) {
    return devCmd;
  }

  if (/^(npm|yarn|pnpm)\s+run\s+/.test(devCmd)) {
    return `${devCmd} -- --host 0.0.0.0`;
  }

  if (devCmd.includes("vite")) {
    return `${devCmd} --host 0.0.0.0`;
  }

  if (devCmd.includes("next")) {
    return `${devCmd} -H 0.0.0.0`;
  }

  return devCmd;
}

/**
 * Run a native Node.js reverse proxy inside the sandbox that listens on 0.0.0.0
 * and forwards traffic to 127.0.0.1, rewriting the Host header.
 * This completely avoids the Vite `allowedHosts` block and requires ZERO changes
 * to the user's config files or package.json!
 */
async function startE2bProxy(sandbox: Sandbox, targetPort: number): Promise<number> {
  const proxyPort = 4000;
  const proxyCode = `
const http = require('http');
const net = require('net');

process.on('uncaughtException', (err) => console.error('E2B Proxy Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('E2B Proxy Unhandled Rejection:', reason));

const TARGET_PORT = parseInt(process.env.TARGET_PORT || "${targetPort}", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "${proxyPort}", 10);

const server = http.createServer((req, res) => {
  const options = {
    hostname: 'localhost', // use localhost to support both IPv4 and IPv6 bindings
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  options.headers['host'] = 'localhost:' + TARGET_PORT;

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('E2B Proxy Error: ' + err.message);
    } else {
      res.end();
    }
  });

  req.on('error', (err) => {
    console.error('E2B Proxy Client Request Error:', err);
  });

  req.pipe(proxyReq, { end: true });
});

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
});

server.on('upgrade', (req, socket, head) => {
  const options = {
    port: TARGET_PORT,
    host: 'localhost',
  };

  const proxySocket = net.connect(options, () => {
    const headers = Object.keys(req.headers).map(k => {
      let v = req.headers[k];
      if (k.toLowerCase() === 'host') v = 'localhost:' + TARGET_PORT;
      return \`\${k}: \${v}\`;
    });
    const reqStr = \`\${req.method} \${req.url} HTTP/\${req.httpVersion}\\r\\n\` + headers.join('\\r\\n') + '\\r\\n\\r\\n';
    proxySocket.write(reqStr);
    proxySocket.write(head);
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on('error', () => {
    if (!socket.destroyed) socket.end();
  });
  socket.on('error', () => {
    if (!proxySocket.destroyed) proxySocket.end();
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(\`E2B Proxy: 0.0.0.0:\${PROXY_PORT} -> localhost:\${TARGET_PORT}\`);
});
  `;

  await sandbox.files.write("/home/user/e2b-proxy.js", proxyCode);
  
  await sandbox.commands.run("node /home/user/e2b-proxy.js", {
    background: true,
    timeoutMs: 0, // Prevent E2B from killing the proxy after the default 60s timeout
  });

  // Give proxy a split second to bind
  await new Promise((resolve) => setTimeout(resolve, 500));
  
  return proxyPort;
}

/**
 * Check if a port is open and accepting connections.
 */
async function isPortOpen(
  sandbox: Sandbox,
  port: number
): Promise<boolean> {
  try {
    const result = await sandbox.commands.run(
      `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ 2>/dev/null || true`,
      { timeoutMs: 3000 }
    );

    const code = result.stdout.trim();
    // Any HTTP response (even 404) means the server is running
    return code !== "" && code !== "000";
  } catch {
    return false;
  }
}

