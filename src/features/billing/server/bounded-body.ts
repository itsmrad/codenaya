// Shared by the Convex webhook receiver (a Request) and the Dodo read client (a Response).
// Pure: it must never import a Convex function module.

/** Reads at most maxBytes; null when the declared or actual body is larger. */
export async function readBoundedBody(
  message: Pick<Request, "headers" | "body">, maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(message.headers.get("content-length")) > maxBytes) return null;
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
