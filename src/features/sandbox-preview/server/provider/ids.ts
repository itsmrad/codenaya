import { PROVIDER_IDS, type ProviderId } from "./types";

/** What a provider's own id may contain: E2B ids are lowercase alphanumeric. */
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value);

/** The prefixed form of a sandbox id; also the canonical key servers cache it under. */
export const toPublicSandboxId = (provider: ProviderId, nativeId: string) => `${provider}:${nativeId}`;

/**
 * The id the client gets and round-trips (DELETE, PATCH sync, resumeSandboxId).
 * E2B's stays unprefixed while E2B is the only provider, so nothing client-visible changes.
 */
export const clientSandboxId = (sandbox: { provider: ProviderId; id: string }, multiProvider: boolean) =>
  sandbox.provider === "e2b" && !multiProvider ? sandbox.id : toPublicSandboxId(sandbox.provider, sandbox.id);

/**
 * The provider and native id of a client-supplied sandbox id, or null when it is
 * malformed or names an unknown provider. An unprefixed id is E2B's, so previews
 * opened before the seam keep working. Routing by the prefix proves nothing about
 * ownership: callers still check `info().metadata.userId`.
 */
export const parsePublicSandboxIdOrNull = (publicId: string): { provider: ProviderId; nativeId: string } | null => {
  const separator = publicId.indexOf(":");
  const provider = separator === -1 ? "e2b" : publicId.slice(0, separator);
  const nativeId = separator === -1 ? publicId : publicId.slice(separator + 1);
  if (!isProviderId(provider) || !NATIVE_ID.test(nativeId)) return null;
  return { provider, nativeId };
};

/** One key per sandbox whether or not the client sent the prefix ("abc" and "e2b:abc"); null when malformed. */
export const canonicalSandboxIdOrNull = (publicId: string) => {
  const parsed = parsePublicSandboxIdOrNull(publicId);
  return parsed && toPublicSandboxId(parsed.provider, parsed.nativeId);
};
