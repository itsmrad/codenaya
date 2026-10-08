import type { FileUIPart } from "ai";
import { useMutation } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Uploads composer images to Convex storage and registers them to the
 * project, returning their storage ids for the send request. The composer
 * hands files over as data URLs.
 */
export const useUploadChatImages = (projectId: Id<"projects">) => {
  const generateUploadUrl = useMutation(api.chatImages.generateUploadUrl);
  const register = useMutation(api.chatImages.register);

  return (files: FileUIPart[]) =>
    Promise.all(
      files.map(async (file) => {
        const body = await (await fetch(file.url)).blob();
        const url = await generateUploadUrl({ projectId });
        const result = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": file.mediaType },
          body,
        });
        if (!result.ok) {
          throw new Error("Image upload failed");
        }
        const { storageId } = (await result.json()) as {
          storageId: Id<"_storage">;
        };
        const error = await register({ projectId, storageId });
        if (error) {
          throw new Error(error);
        }
        return storageId;
      }),
    );
};
