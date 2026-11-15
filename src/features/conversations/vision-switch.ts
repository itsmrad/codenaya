import { AUTO_MODEL_ID, autoRouteModel } from "@/features/ai-providers/auto-route";
import { pickableModels } from "@/features/ai-providers/catalog";
import type { PlatformModels } from "@/features/ai-providers/hooks/use-ai-providers";
import { type AiProviderId, keyModels, modelAcceptsImages } from "@/features/ai-providers/registry";

import type { AgentModelChoice } from "./agent-models";

export interface VisionSwitch {
  choice: AgentModelChoice;
  name: string;
  /** Who pays for the send, shown before the switch. */
  billing: string;
}

/**
 * The image-capable model the composer offers when the picked one can't read
 * images (#562): a vision model on the same key (no change of payer), else the
 * platform model Auto routes images to, else the first platform model that
 * reads images. Undefined when the user can pick none.
 */
export function visionSwitchTarget(
  choice: AgentModelChoice,
  platform: Pick<PlatformModels, "models" | "autoModelIds">,
  key?: { _id: string; provider: AiProviderId; label: string; modelIds?: readonly string[] },
): VisionSwitch | undefined {
  const keyModel = key && choice.keyId && keyModels(key).find((model) => modelAcceptsImages(model.id, key));
  if (key && keyModel) {
    return {
      choice: { keyId: key._id, modelId: keyModel.id },
      name: keyModel.label,
      billing: `Billed to your ${key.label} key`,
    };
  }
  // Auto is not a switch target: it would also re-route the text sends after this one.
  const models = pickableModels(platform.models).filter((model) => model.id !== AUTO_MODEL_ID);
  const model =
    autoRouteModel(models, "vision", platform.autoModelIds) ?? models.find((m) => m.vision);
  return model && { choice: { modelId: model.id }, name: model.name, billing: "Uses your credits" };
}
