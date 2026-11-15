import type { SandboxMeta, SandboxProvider } from "./types";

type ListQuery = Parameters<SandboxProvider["list"]>[0];

/** Supply enabled providers, including those cooling down for creates. Fail closed on list errors. */
export async function listAll(providers: readonly SandboxProvider[], query: ListQuery) {
  const lists = await Promise.all(providers.map(async (provider) =>
    (await provider.list(query)).map((sandbox) => ({ ...sandbox, provider: provider.id })),
  ));
  return lists.flat();
}

export async function countLive(providers: readonly SandboxProvider[], metadata: SandboxMeta) {
  return (await listAll(providers, { metadata })).length;
}
