import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SandboxInstance } from "@blaxel/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertExactExecStream, createBlaxelProvider } from "./blaxel";
import { SandboxConfigError } from "./types";

// The real SDK (not mocked) against a local stand-in for sandbox-api, through `forceUrl`:
// execWithStreaming's NDJSON branch and its legacy plain-JSON one.
let server: Server | undefined;

const sandboxApi = async (contentType: string, body: string) => {
  server = createServer((request, response) => {
    request.resume().on("end", () => response.writeHead(200, { "Content-Type": contentType }).end(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endAt = new Date(Date.now() + 60_000).toISOString();
  return new SandboxInstance({
    metadata: { name: "cn-local" },
    status: "DEPLOYED",
    spec: { lifecycle: { expirationPolicies: [{ type: "date", value: endAt, action: "delete" }] } },
    forceUrl: `http://127.0.0.1:${port}`,
  } as ConstructorParameters<typeof SandboxInstance>[0]);
};

const ndjson = (stdout: string[], tail: string) =>
  [...stdout.map((data) => ({ type: "stdout", data })), { type: "result", data: JSON.stringify({ status: "completed", exitCode: 0, stdout: tail, stderr: "" }) }]
    .map((event) => `${JSON.stringify(event)}\n`)
    .join("");

describe("Blaxel adapter over the real SDK", () => {
  afterEach(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  it("NDJSON: run joins chunks split mid-line byte-exact, and the image guard passes", async () => {
    vi.spyOn(SandboxInstance, "get").mockResolvedValue(await sandboxApi("application/x-ndjson", ndjson(["a\n\nb", "c\n29", "9\n"], "9\n")));
    const onStdout = vi.fn();

    const sandbox = await createBlaxelProvider().connect("cn-local");
    expect(await sandbox.run("seq", { onStdout })).toEqual({ exitCode: 0, stdout: "a\n\nbc\n299\n", stderr: "" });
    expect(onStdout.mock.calls).toEqual([["a\n\nb"], ["c\n29"], ["9\n"]]);

    server?.close();
    await expect(assertExactExecStream(await sandboxApi("application/x-ndjson", ndjson(["a\n", "\nb"], "\nb")))).resolves.toBeUndefined();
  });

  it("legacy JSON: the SDK hands over stripped lines, which the image guard rejects", async () => {
    const instance = await sandboxApi("application/json", JSON.stringify({ status: "completed", exitCode: 0, stdout: "a\n\nb", stderr: "" }));
    const onStdout = vi.fn();

    // Why NDJSON is a prerequisite: the blank line and the separators are gone before the adapter sees them.
    await instance.process.exec({ command: "printf", waitForCompletion: true, onStdout });
    expect(onStdout.mock.calls).toEqual([["a"], ["b"]]);
    await expect(assertExactExecStream(instance)).rejects.toBeInstanceOf(SandboxConfigError);
  });
});
