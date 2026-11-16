import { z } from "zod";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";
import {
  SANDBOX_CREATE_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/lib/rate-limit";

import {
  serialiseDotenv,
  toProcessEnv,
} from "@/features/integrations/dotenv";
import {
  resolveProjectEnv,
  secretValuesFrom,
} from "@/features/integrations/server/env/resolve-env";
import { createStreamRedactor } from "@/features/integrations/server/env/stream-redactor";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";
import {
  DEFAULT_INSTALL_COMMAND,
  MAX_LIVE_SANDBOXES,
  WORK_DIR,
  atLiveSandboxCap,
  killProjectPreviews,
  projectFileEntries,
  projectFilesSchema,
  stopSandboxCommands,
} from "@/features/sandbox-preview/server/project-sandbox";
import { runOrThrow } from "@/features/sandbox-preview/server/provider/helpers";
import { parseProviderConfig } from "@/features/sandbox-preview/server/provider/config";
import { clientSandboxId, toPublicSandboxId } from "@/features/sandbox-preview/server/provider/ids";
import {
  createSandbox,
  getConfiguredProviders,
  isMultiProvider,
} from "@/features/sandbox-preview/server/provider/registry";
import {
  type Sandbox,
  SandboxConfigError,
  SandboxRateLimitError,
} from "@/features/sandbox-preview/server/provider/types";
import { recordSandboxRunning } from "@/features/sandbox-preview/server/record-sandbox-running";
import {
  forgetSandbox,
  getOwnedSandbox,
  rememberSandbox,
} from "@/features/sandbox-preview/server/sandbox-registry";
import {
  REINSTALL_DEBOUNCE_MS,
  debounceSerial,
} from "@/features/sandbox-preview/server/debounce-serial";
import {
  boundedTimeout,
  streamBudget,
} from "@/features/sandbox-preview/server/stream-budget";
import {
  DEV_COMMAND_ENV,
  PROXY_TARGET_ENV,
  BOOT_INSTALL_ENVS,
  DEV_SERVER_ENVS,
  DevServerStartError,
  PROXY_SCRIPT_PATH,
  installWithDevServerStopped,
  isPortOpen,
  runDevServer,
  type DevStart,
} from "@/features/sandbox-preview/server/dev-server";
import {
  createBridgeInjector,
  rewriteProxyHeaders,
  shouldInjectBridge,
} from "@/features/sandbox-preview/server/preview-proxy";
import { appendHostFlag, detectFrameworkFromFiles } from "@/features/sandbox-preview/utils/dev-command";
import {
  missingReferencedFiles,
  undeclaredPackages,
} from "@/features/sandbox-preview/utils/missing-references";
import { nodeIncompatibility } from "@/features/sandbox-preview/utils/node-compat";
import { PREVIEW_BRIDGE_SCRIPT } from "@/features/sandbox-preview/utils/preview-bridge";
import type { SandboxErrorKind } from "@/features/sandbox-preview/utils/sandbox-error";
import {
  recordBootPhase,
  type BootHistory,
  type BootPhase,
} from "@/features/sandbox-preview/utils/boot-phase";
import {
  NOTHING_TO_PREVIEW,
  STATIC_SERVE_COMMAND,
  bootPlan,
} from "@/features/sandbox-preview/utils/boot-plan";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * POST /api/sandbox
 *
 * Creates an E2B sandbox, writes project files, installs dependencies,
 * and starts the dev server. Streams terminal output back as NDJSON so
 * the client can render it in real-time.
 *
 * Response format (NDJSON – one JSON object per line):
 *   { "type": "status", "status": "installing" | "running" }
 *   { "type": "phase",  "phase": BootPhase, "at": <epoch ms> }
 *   { "type": "output", "data": "..." }
 *   { "type": "ready",  "sandboxId": "...", "previewUrl": "..." }
 *   { "type": "resume", "sandboxId": "..." }
 *   { "type": "error",  "message": "...", "code": SandboxErrorKind }
 *
 * The stream ends itself before Vercel's limit (#492). After `ready` it just
 * closes and the preview keeps running. Before `ready` it sends `resume`, and
 * the client boots again on that sandbox by posting it as `resumeSandboxId`.
 */

/** Vercel Hobby's maximum; the stream ends itself before it (stream-budget.ts). */
export const maxDuration = 300;

const requestSchema = z.object({
  files: projectFilesSchema,
  settings: z
    .object({ installCommand: z.string().optional(), devCommand: z.string().optional() })
    .optional(),
  projectId: z.string().optional(),
  /** A sandbox this user's earlier boot ran out of time on (#492). */
  resumeSandboxId: z.string().optional(),
});

const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour (E2B free plan max)
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

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
  const budget = streamBudget(Date.now());
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const rateLimit = checkRateLimit(userId, SANDBOX_CREATE_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  // Read per request: the cap, the kill and the lookup span every configured provider.
  const providerConfig = parseProviderConfig();
  const providers = getConfiguredProviders(providerConfig);

  if (!providers.length) {
    return Response.json(
      {
        error:
          "E2B_API_KEY is not configured on the Codenaya server. Add it to the " +
          "hosting environment and restart or redeploy the app.",
        code: "config" satisfies SandboxErrorKind,
      },
      { status: 503 },
    );
  }

  const { data: body, invalid } = await parseJsonBody(request, requestSchema);

  if (invalid) {
    return invalid;
  }

  const { files, settings, resumeSandboxId } = body;
  const projectId = body.projectId as Id<"projects"> | undefined;

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  // The project's decrypted secrets go into this sandbox, which runs the
  // caller's files and commands, so only its owner may name it (#208).
  if (projectId) {
    if (!internalKey) {
      return Response.json(
        { error: "Server configuration error", code: "config" satisfies SandboxErrorKind },
        { status: 500 },
      );
    }

    const { notFound } = await requireOwnedProject({
      internalKey,
      userId,
      projectId,
    });

    if (notFound) {
      return notFound;
    }
  }

  // A new boot replaces this project's earlier preview, which may be an orphan.
  if (projectId && !resumeSandboxId) {
    const killed = await killProjectPreviews(providers, userId, projectId);
    killed.forEach(forgetSandbox);
  }

  // A resumed boot reuses a sandbox the cap already counts.
  if (!resumeSandboxId && (await atLiveSandboxCap(providers, userId))) {
    return Response.json(
      {
        error:
          `You already have ${MAX_LIVE_SANDBOXES} cloud previews running. ` +
          "Close one, or wait for it to expire, then try again.",
        code: "rate_limit" satisfies SandboxErrorKind,
      },
      { status: 429 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // ─── Environment variables ───
      //
      // Resolved before the redactor is created, because the redactor needs the
      // secret values in order to strip them from the output stream.
      //
      // Non-fatal: a project whose integrations are broken should still get a
      // preview, just without those variables. `envWarnings` tells the user which.
      let envEntries: Array<{ key: string; value: string }> = [];
      let secretValues: string[] = [];
      const envWarnings: string[] = [];

      if (projectId && internalKey) {
        try {
          const records = await convex.query(api.system.getEnvVarsForSandbox, {
            internalKey,
            projectId,
          });

          const resolved = await resolveProjectEnv(records);

          // E2B runs server-side, so both public and secret values are safe here.
          // This is the difference from the WebContainer path, which gets public
          // values only.
          envEntries = [...resolved.publicEntries, ...resolved.secretEntries];
          secretValues = secretValuesFrom(resolved);

          if (resolved.failedKeys.length > 0) {
            envWarnings.push(
              `Could not decrypt ${resolved.failedKeys.length} variable(s): ` +
                `${resolved.failedKeys.join(", ")}. They were not injected.`,
            );
          }
        } catch (error) {
          console.error("[sandbox] env resolution failed", error);
          envWarnings.push(
            "Environment variables could not be loaded for this preview.",
          );
        }
      }

      // Every byte written to the client passes through this. Install and dev
      // output routinely echoes configuration, and a stack trace from a failed
      // connection commonly embeds a full DSN — without redaction, injecting
      // secrets into the sandbox would deliver them straight to the browser.
      const redactor = createStreamRedactor(secretValues);

      const send = (data: Record<string, unknown>) => {
        try {
          // Only the free-text `data` field can contain process output; status and
          // url fields are ours. Redacting just that field keeps JSON structure
          // intact, which redacting the serialised envelope would not.
          const safe =
            typeof data.data === "string"
              ? { ...data, data: redactor.push(data.data) }
              : data;

          // A fully-redacted chunk can reduce to an empty string, which is not
          // worth a frame.
          if (typeof safe.data === "string" && safe.data === "") return;

          controller.enqueue(encoder.encode(JSON.stringify(safe) + "\n"));
        } catch {
          // Controller may already be closed — ignore
        }
      };

      /** Drives the preview's boot checklist (#254); kept for activation events (#339). */
      let bootHistory: BootHistory = {};
      const sendPhase = (phase: BootPhase) => {
        const at = Date.now();
        bootHistory = recordBootPhase(bootHistory, phase, at);
        send({ type: "phase", phase, at });
      };

      /** Release anything the redactor is holding back. */
      const flushRedactor = () => {
        const tail = redactor.flush();
        if (tail === "") return;
        try {
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: "output", data: tail }) + "\n"),
          );
        } catch {
          // Stream already closed.
        }
      };

      let sandbox: Sandbox | null = null;
      /** Started again by a reinstall when no dev server is found running (#486). */
      let devStart: DevStart | undefined;
      const installCmd = settings?.installCommand || DEFAULT_INSTALL_COMMAND;

      // A non-zero exit resolves; the callers report it as an install
      // failure, which the preview offers to fix (#491).
      const runInstall = (target: Sandbox, timeoutMs: number) =>
        target.run(installCmd, {
          cwd: WORK_DIR,
          timeoutMs,
          // Install may run postinstall scripts or a build that needs config.
          envs: { ...toProcessEnv(envEntries), ...BOOT_INSTALL_ENVS },
          onStdout: (data) => send({ type: "output", data }),
          onStderr: (data) => send({ type: "output", data }),
        });

      // The first build boots the preview from its starter while the agent is
      // still writing, so dependencies it adds to package.json later have to be
      // installed here, with the output on this stream (#254).
      let reinstallStartError: DevServerStartError | null = null;
      const reinstall = debounceSerial(async () => {
        reinstallStartError = null;
        if (!sandbox) return;
        send({ type: "output", data: `\npackage.json changed.\n$ ${installCmd}\n` });
        try {
          const target = sandbox;
          const result = await installWithDevServerStopped(
            target,
            // May run past the stream budget, so it is bounded by the close.
            () => runInstall(target, boundedTimeout(INSTALL_TIMEOUT_MS, budget.closeLeft())),
            {
              onStdout: (data) => send({ type: "output", data }),
              onStderr: (data) => send({ type: "output", data }),
            },
            devStart,
          );
          if (result.exitCode !== 0) {
            throw new Error(`${installCmd} failed with exit code ${result.exitCode}`);
          }
          send({ type: "output", data: "\nDependencies installed.\n" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          send({ type: "output", data: `\nError: ${message}\n` });
          if (error instanceof DevServerStartError) {
            reinstallStartError = error;
            send({ type: "error", message, code: "transient" });
          }
        }
      }, REINSTALL_DEBOUNCE_MS);

      /** The sandbox outlives this stream: don't kill or forget it (#492). */
      let handedOff = false;

      try {
        // Name the missing file now rather than leave Vite's overlay to (#190).
        const missing = missingReferencedFiles(files);
        if (missing.length > 0) {
          throw new Error(
            `The project's config points at files that don't exist: ${missing.join(", ")}. ` +
              "Ask the agent to create them, or remove the references.",
          );
        }
        const undeclared = undeclaredPackages(files);
        if (undeclared.length > 0) {
          throw new Error(
            `The project imports packages missing from package.json: ${undeclared.join(", ")}. ` +
              "Ask the agent to add them to package.json.",
          );
        }
        const plan = bootPlan(
          files.map((file) => file.path),
          settings?.devCommand,
        );
        if (plan === "none") {
          throw new Error(NOTHING_TO_PREVIEW);
        }

        // --- Boot sandbox ---
        send({ type: "status", status: "booting" });
        sendPhase("create");

        if (resumeSandboxId) {
          send({ type: "output", data: "\nContinuing on the same sandbox...\n" });
          sandbox = await getOwnedSandbox(resumeSandboxId, userId);
          if (!sandbox) throw new Error("Sandbox not found");
          await stopSandboxCommands(sandbox);
        } else {
          send({ type: "output", data: "Creating E2B sandbox...\n" });
          sandbox = await createSandbox({
            timeoutMs: SANDBOX_TIMEOUT_MS,
            // checkBuild finds the project's warm preview by these tags (#465).
            metadata: projectId ? { userId, projectId } : { userId },
            localHostHeader: true,
          }, (notice) => send({ type: "output", data: `${notice}\n` }), providerConfig);
        }

        // File syncs reuse this handle instead of reconnecting (#179).
        rememberSandbox(sandbox, userId, reinstall.schedule, async () => {
          await reinstall.idle();
          if (reinstallStartError) throw reinstallStartError;
        });

        send({
          type: "output",
          data: `Sandbox ${sandbox.id} ${resumeSandboxId ? "connected" : "created"}.\n`,
        });

        // --- Verify Node.js is available ---
        send({ type: "output", data: "Checking Node.js...\n" });
        const nodeCheck = await runOrThrow(sandbox, "node --version", {
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

        // Fail with the reason now rather than with Vite's crash after a full install.
        const incompatibility = nodeIncompatibility(
          nodeCheck.stdout,
          files.find((file) => file.path === "package.json")?.content,
        );
        if (incompatibility) {
          throw new Error(incompatibility);
        }

        // --- Write project files ---
        sendPhase("files");
        send({ type: "output", data: "Writing project files...\n" });

        await sandbox.writeFiles(projectFileEntries(files));

        send({
          type: "output",
          data: `Wrote ${files.length} file(s) to sandbox.\n\n`,
        });

        // --- Write environment variables ---
        //
        // Before install, because a postinstall script or a build step may read
        // them. Both filenames are written: frameworks disagree about which they
        // load, and `.env.local` takes precedence in Next.js while Vite reads
        // `.env`. Writing both means the app works whichever it expects.
        //
        // Not for a static site: nothing there reads them, and the static
        // server would hand the secrets to anyone requesting /.env (#262).
        if (envEntries.length > 0 && plan !== "static") {
          const dotenv = serialiseDotenv(envEntries);
          await sandbox.writeFiles([{ path: `${WORK_DIR}/.env`, data: dotenv }]);
          await sandbox.writeFiles([{ path: `${WORK_DIR}/.env.local`, data: dotenv }]);

          // Keys only. Naming the values here would print them to the terminal the
          // user is watching, which is exactly what the redactor exists to prevent.
          send({
            type: "output",
            data:
              `Injected ${envEntries.length} environment variable(s): ` +
              `${envEntries.map((e) => e.key).join(", ")}\n\n`,
          });
        }

        for (const warning of envWarnings) {
          send({ type: "output", data: `Warning: ${warning}\n` });
        }

        // --- Install dependencies ---
        send({ type: "status", status: "installing" });
        sendPhase("install");

        if (plan === "static") {
          send({
            type: "output",
            data: "No package.json found, serving index.html statically.\n\n",
          });
        } else {
          send({ type: "output", data: `$ ${installCmd}\n` });

          const installResult = await runInstall(
            sandbox,
            boundedTimeout(INSTALL_TIMEOUT_MS, budget.left()),
          );

          // Not the stderr: it was already streamed through the redactor, and
          // the error event's message is not redacted (#491).
          if (installResult.exitCode !== 0) {
            throw new Error(`${installCmd} failed with exit code ${installResult.exitCode}`);
          }

          send({ type: "output", data: "\nDependencies installed.\n\n" });
        }

        // --- Start dev server directly without hacking configs ---
        const devCmdWithHost =
          plan === "static"
            ? STATIC_SERVE_COMMAND
            : appendHostFlag(settings?.devCommand || "npm run dev", detectFrameworkFromFiles(files));
        sendPhase("start");
        
        send({ type: "output", data: `$ ${devCmdWithHost}\n` });

        // Track the port detected from dev server output
        let detectedPort: number | null = null;

        devStart = {
          command: devCmdWithHost,
          cwd: WORK_DIR,
          // Project variables first so DEV_SERVER_ENVS wins: HOST/HOSTNAME must
          // stay 0.0.0.0 for E2B port forwarding, and a user variable overriding
          // them would break the preview in a way that looks like a broken app.
          envs: {
            ...toProcessEnv(envEntries),
            ...DEV_SERVER_ENVS,
            // A reinstall stops this and starts it again (#486).
            [DEV_COMMAND_ENV]: devCmdWithHost,
          },
        };
        await runDevServer(sandbox, devStart, {
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

        const localPort = await waitForServerPort(
          sandbox,
          () => detectedPort,
          Math.min(60_000, budget.left()),
        );

        if (!localPort) {
          throw new Error(
            "Could not detect dev server port. " +
              "Check the terminal output above for errors."
          );
        }

        devStart.readyPort = localPort;

        // Start the proxy to bypass Vite allowedHosts and bind issues
        const proxyPort = await startE2bProxy(sandbox, localPort);

        const previewUrl = await sandbox.previewUrl(proxyPort);

        // E2B's edge needs a moment to route the newly opened port 4000 to the
        // public domain before the iframe can load it.
        send({ type: "output", data: "\nConfiguring external network routing...\n" });
        await waitForPublicUrl(previewUrl);

        send({ type: "output", data: `\nServer ready at ${previewUrl}\n` });
        send({ type: "status", status: "running" });
        sendPhase("ready");
        if (projectId && internalKey) void recordSandboxRunning(internalKey, projectId, bootHistory);
        send({
          type: "ready",
          sandboxId: clientSandboxId(sandbox, isMultiProvider(providerConfig)),
          previewUrl,
        });

        // The client gave up before it could know the sandbox, so nothing else
        // would kill it.
        if (request.signal.aborted) {
          // If already aborted, short-circuit and throw so finally kills the sandbox
          throw new Error("Client aborted request");
        }

        // Keep streaming dev server logs until the client disconnects or the
        // budget runs out. Either way the sandbox keeps running: the client
        // has its id and kills it with DELETE when the preview closes (#492).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, budget.left()));
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });

        // Syncs keep going through the serial queue until it drains, so a
        // PATCH install can't overlap one from here. Then they install through PATCH.
        handedOff = true;
        const booted = sandbox;
        await reinstall.flush(() => rememberSandbox(booted, userId));
        send({
          type: "output",
          data: "\nLog stream closed to stay within the server time limit. The preview keeps running.\n",
        });
      } catch (error) {
        // Out of time, not broken: the client boots again on this sandbox.
        if (sandbox && !handedOff && !request.signal.aborted && budget.left() <= 0) {
          handedOff = true;
          rememberSandbox(sandbox, userId);
          send({ type: "resume", sandboxId: clientSandboxId(sandbox, isMultiProvider(providerConfig)) });
          return;
        }

        const message =
          error instanceof Error ? error.message : "Unknown error";

        const code: SandboxErrorKind =
          error instanceof SandboxConfigError
            ? "config"
            : error instanceof SandboxRateLimitError
              ? "rate_limit"
              : "transient";

        send({ type: "output", data: `\nError: ${message}\n` });
        // The client stops reading at the error event, so held-back output goes first.
        flushRedactor();
        send({ type: "error", message, code });

        // Kill sandbox on error to free up the slot
        if (sandbox) {
          try {
            await sandbox.kill();
          } catch {
            // Best-effort cleanup
          }
        }
      } finally {
        reinstall.cancel();
        if (sandbox && !handedOff) {
          forgetSandbox(toPublicSandboxId(sandbox.provider, sandbox.id));
        }

        // Release any output the redactor is holding back, otherwise the last
        // partial line would never reach the terminal.
        flushRedactor();
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
 * Poll the public preview URL until E2B routes it (it answers 5xx before
 * that), up to `maxWaitMs`. Replaces a fixed 3s wait.
 */
async function waitForPublicUrl(url: string, maxWaitMs = 3000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // Not reachable yet, or the attempt ran out of time.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
const { Transform, pipeline } = require('stream');

process.on('uncaughtException', (err) => console.error('E2B Proxy Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('E2B Proxy Unhandled Rejection:', reason));

const TARGET_PORT = parseInt(process.env.TARGET_PORT || "${targetPort}", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "${proxyPort}", 10);
const BRIDGE = ${JSON.stringify(PREVIEW_BRIDGE_SCRIPT)};
const createBridgeInjector = ${String(createBridgeInjector)};
const rewriteProxyHeaders = ${String(rewriteProxyHeaders)};
const shouldInjectBridge = ${String(shouldInjectBridge)};

const server = http.createServer((req, res) => {
  const options = {
    hostname: 'localhost', // use localhost to support both IPv4 and IPv6 bindings
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: rewriteProxyHeaders(req.headers, TARGET_PORT),
  };
  // Plain HTML from the dev server, so the error bridge can go in (#223).
  delete options.headers['accept-encoding'];

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = Object.assign({}, proxyRes.headers);
    const isPage = shouldInjectBridge(req.method, proxyRes.statusCode, headers);
    if (!isPage) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });
      return;
    }
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    res.writeHead(proxyRes.statusCode, headers);
    const injector = createBridgeInjector(BRIDGE);
    pipeline(proxyRes, new Transform({
      transform(chunk, encoding, callback) {
        for (const part of injector.push(chunk)) this.push(part);
        callback();
      },
      flush(callback) {
        for (const part of injector.flush()) this.push(part);
        callback();
      },
    }), res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('E2B Proxy Response Error:', err);
      }
    });
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
    const rewritten = rewriteProxyHeaders(req.headers, TARGET_PORT);
    const headers = Object.keys(rewritten).map(k => {
      return \`\${k}: \${rewritten[k]}\`;
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

  await sandbox.writeFiles([{ path: PROXY_SCRIPT_PATH, data: proxyCode }]);
  
  // In the background with no time limit, so the provider doesn't stop the proxy.
  await sandbox.start(`node ${PROXY_SCRIPT_PATH}`, {
    // Also listed with the process, so checkBuild can tell whether the dev server is still up.
    envs: { [PROXY_TARGET_ENV]: String(targetPort) },
  });

  // Give proxy a split second to bind
  await new Promise((resolve) => setTimeout(resolve, 500));
  
  return proxyPort;
}
