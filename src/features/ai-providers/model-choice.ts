import type { AgentModelChoice } from "../conversations/agent-models";

/**
 * Select values pair a key with a model as `<keyId>:<modelId>`. Convex ids
 * never contain `:`, so the first one splits them; model ids may contain more.
 */
const PLATFORM_VALUE = "codenaya";

export const toChoiceValue = ({ keyId, modelId }: AgentModelChoice) =>
  `${keyId ?? PLATFORM_VALUE}:${modelId}`;

export const fromChoiceValue = (value: string): AgentModelChoice => {
  const separator = value.indexOf(":");
  const keyId = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  return keyId === PLATFORM_VALUE ? { modelId } : { keyId, modelId };
};
