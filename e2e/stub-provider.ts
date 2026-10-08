import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local OpenAI-compatible provider for agent-run and editor AI specs,
 * registered as a custom BYOK key (`next dev` allows a localhost endpoint).
 */

export const STUB_MODEL = "stub-model";
export const STUB_TITLE = "Stub chat title";

export interface StubChatRequest {
  model: string;
  tools?: Array<{ function: { name: string } }>;
  /** Set by AI SDK `generateObject` calls (the editor AI routes). */
  response_format?: unknown;
  messages: Array<{ role: string; content?: unknown }>;
}

interface StubOptions {
  /** The coding agent's final text reply. */
  reply?: string;
  /** The one tool call the coding agent makes before replying. */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** The JSON object returned to a structured-output request. */
  object?: (request: StubChatRequest) => unknown;
}

const readJson = async (request: IncomingMessage) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}") as StubChatRequest;
};

/**
 * Accepts one key until `reject()` is called. The coding agent first gets
 * `toolCall` (so the run block has a step to show), then `reply`; the title
 * agent (no tools) gets a fixed title. A structured-output request gets
 * `object` as JSON.
 */
export const startStubProvider = async (
  apiKey: string,
  { reply = "", toolCall = { name: "listFiles", arguments: {} }, object }: StubOptions,
) => {
  let rejecting = false;
  const requests: StubChatRequest[] = [];

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (rejecting || request.headers.authorization !== `Bearer ${apiKey}`) {
      return send(401, {
        error: { message: "Incorrect API key provided", code: "invalid_api_key" },
      });
    }
    if (request.method === "GET") {
      return send(200, { data: [{ id: STUB_MODEL }] });
    }

    const body = await readJson(request);
    requests.push(body);
    const message =
      body.response_format && object
        ? { role: "assistant", content: JSON.stringify(object(body)) }
        : !body.tools?.length
          ? { role: "assistant", content: STUB_TITLE }
          : body.messages.some((m) => m.role === "tool")
            ? { role: "assistant", content: reply }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${Date.now()}`,
                    type: "function",
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.arguments),
                    },
                  },
                ],
              };
    send(200, {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.content ? "stop" : "tool_calls",
        },
      ],
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get models() {
      return requests.map((request) => request.model);
    },
    reject: () => {
      rejecting = true;
    },
  };
};
