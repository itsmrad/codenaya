import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { nanoid } from "nanoid";

import { classifyEnvKey, isValidEnvKey, maskSecret } from "@/features/integrations/env-keys";
import {
  getSecretSealer,
  secretContext,
} from "@/features/integrations/server/crypto";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

/**
 * Agent tool for storing an environment variable.
 *
 * ## Why the agent needs this
 *
 * Provisioning is only half of making an app full-stack. When the agent creates a
 * Supabase project it receives a URL and keys, and those have to reach the running
 * preview. Without this tool the model's only option is to write the value into a
 * source file — which commits a credential to the project and shows it in the
 * editor. This gives it the correct alternative, and the system prompt points at it
 * explicitly.
 *
 * ## Classification is not the model's decision
 *
 * The tool accepts no visibility argument. Whether a value is public is determined
 * by `classifyEnvKey` from the key name, because bundlers decide that, not us: a
 * `NEXT_PUBLIC_`-prefixed variable is inlined into client JavaScript whatever we
 * label it, and anything else must be withheld from the browser preview.
 *
 * Letting the model choose would put a service-role key one hallucination away from
 * the client bundle. Defaulting unknown keys to `secret` means the failure mode is
 * a variable missing from a browser preview, not a leaked credential.
 */

interface SetEnvVarToolOptions {
  projectId: Id<"projects">;
  ownerId: string;
  internalKey: string;
}

export const createSetEnvVarTool = ({
  projectId,
  ownerId,
  internalKey,
}: SetEnvVarToolOptions) => {
  return createTool({
    name: "setEnvVar",
    description:
      "Store an environment variable for this project so the running preview can " +
      "use it. Use this for anything an integration gives you — database URLs, API " +
      "keys, project references. NEVER write a credential into a source file; store " +
      "it here and reference it with process.env.KEY in code. Keys starting with " +
      "NEXT_PUBLIC_, VITE_ or PUBLIC_ are treated as public and are visible in the " +
      "browser; everything else is encrypted and only available in the cloud sandbox.",
    parameters: z.object({
      key: z
        .string()
        .min(1)
        .describe(
          "The variable name, e.g. NEXT_PUBLIC_SUPABASE_URL or DATABASE_URL. " +
            "Letters, digits and underscores only.",
        ),
      value: z.string().describe("The value to store."),
    }),
    handler: async ({ key, value }, { step }) => {
      const trimmedKey = key.trim();

      if (!isValidEnvKey(trimmedKey)) {
        return (
          `Error: "${trimmedKey}" is not a valid environment variable name. ` +
          `Use letters, digits and underscores, starting with a letter or underscore.`
        );
      }

      const visibility = classifyEnvKey(trimmedKey);

      const run = async () => {
        if (visibility === "public") {
          // Public values need no envelope — they are destined for the client
          // bundle regardless, and encrypting them would only add a decrypt step
          // to every preview boot.
          await convex.mutation(api.system.setPublicEnvVarInternal, {
            internalKey,
            projectId,
            ownerId,
            key: trimmedKey,
            value,
          });
          return (
            `Stored public variable ${trimmedKey}. It is available in both preview ` +
            `engines. Reference it as process.env.${trimmedKey}.`
          );
        }

        // Generated before the insert so it can anchor the AAD in a single write.
        const secretRef = nanoid();
        const sealed = await getSecretSealer().seal(
          value,
          secretContext("projectEnvVars", secretRef, "value"),
        );

        await convex.mutation(api.system.setSecretEnvVar, {
          internalKey,
          projectId,
          ownerId,
          key: trimmedKey,
          secretRef,
          maskedPreview: maskSecret(value),
          source: "integration",
          ...sealed,
        });

        return (
          `Stored secret ${trimmedKey} (encrypted). Reference it as ` +
          `process.env.${trimmedKey}. It is injected into the cloud sandbox preview ` +
          `but withheld from the in-browser preview, which cannot hold secrets. ` +
          `Do not write this value into any file.`
        );
      };

      try {
        return step
          ? await step.run(`set-env-var-${trimmedKey}`, run)
          : await run();
      } catch (error) {
        // Returned as text rather than thrown, matching the other tools: a thrown
        // error makes the model report the whole system broken, whereas a readable
        // message lets it retry or explain.
        return (
          `Error storing ${trimmedKey}: ` +
          `${error instanceof Error ? error.message : "unknown error"}. ` +
          `You may retry on a later turn.`
        );
      }
    },
  });
};
