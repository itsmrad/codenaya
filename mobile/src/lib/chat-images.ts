import { useMutation } from "convex/react";
import type { ImagePickerAsset } from "expo-image-picker";

import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { MAX_CHAT_IMAGE_BYTES, isChatImageType } from "@/lib/shared";

/**
 * Uploads picked images the way the web composer does: each goes straight to
 * Convex storage, then is registered against the project so a message may
 * reference it. Resolves to the storage ids, or the first error to show.
 */
export const useUploadChatImages = (projectId: Id<"projects">) => {
  const generateUploadUrl = useMutation(api.chatImages.generateUploadUrl);
  const register = useMutation(api.chatImages.register);

  return async (assets: ImagePickerAsset[]): Promise<{ ids: string[] } | { error: string }> => {
    const limitMb = MAX_CHAT_IMAGE_BYTES / 1024 / 1024;
    const ids: string[] = [];
    for (const asset of assets) {
      if (!isChatImageType(asset.mimeType) || (asset.fileSize ?? 0) > MAX_CHAT_IMAGE_BYTES) {
        return { error: `Images must be PNG, JPEG, WebP or GIF, up to ${limitMb} MB` };
      }
      const uploadUrl = await generateUploadUrl({ projectId });
      const blob = await (await fetch(asset.uri)).blob();
      const uploaded = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": asset.mimeType! },
        body: blob,
      });
      if (!uploaded.ok) return { error: "Couldn't upload the image." };
      const { storageId } = (await uploaded.json()) as { storageId: Id<"_storage"> };
      // The server re-checks type and size; a refusal comes back as a message.
      const refused = await register({ projectId, storageId });
      if (refused) return { error: refused };
      ids.push(storageId);
    }
    return { ids };
  };
};
