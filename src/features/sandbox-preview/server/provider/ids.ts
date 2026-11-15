import { PROVIDER_IDS, type ProviderId } from "./types";

/** What a provider's own id may contain: E2B ids are lowercase alphanumeric. */
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value);

/** The id the client round-trips (DELETE, PATCH sync, resumeSandboxId). */
export const toPublicSandboxId = (provider: ProviderId, nativeId: string) => `${provider}:${nativeId}`;

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
