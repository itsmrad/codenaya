import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { nanoid } from "nanoid";

import { classifyEnvKey, isValidEnvKey, maskSecret } from "@/features/integrations/env-keys";
import { getSecretSealer, secretContext } from "@/features/integrations/server/crypto";
import { killOutdatedPreviews } from "@/features/sandbox-preview/server/runtime-fence";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

/**
 * Agent tool: store an env var from an env ref (`[env-ref:ref_… public|secret]`
 * in an MCP tool result), so the agent can finish integration setup without
 * ever seeing a value.
 *
 * The value exists only inside the step below: unsealed from the ref, written
 * through the same writers the env panel uses, and never returned, logged or
 * put in an error. The step returns only a status string. Visibility comes
 * from the ref (decided server-side) and the name (`classifyEnvKey`), never the
 * model: a secret ref may not go under a browser-exposed name.
 */

interface SetEnvVarFromRefToolOptions {
  projectId: Id<"projects">;
  ownerId: string;
  /** The run the refs must belong to. */
  messageId: Id<"messages">;
  internalKey: string;
}

const paramsSchema = z.object({
  name: z.string().trim().min(1, "Variable name is required"),
  ref: z.string().trim().min(1, "ref is required"),
  overwrite: z.boolean().optional(),
});

const REF_ID = /\bref_[0-9a-f]{32}\b/;

/** Every unexpected failure looks like this, so no error text can carry a value. */
const GENERIC_ERROR = "Error: could not set the variable. You may retry on a later turn.";

export const createSetEnvVarFromRefTool = ({
  projectId,
  ownerId,
  messageId,
  internalKey,
}: SetEnvVarFromRefToolOptions) =>
  createTool({
    name: "setEnvVarFromRef",
    description:
      "Store a value from an integration tool result as a project environment variable, " +
      "without seeing it. Tool results show such values as [env-ref:ref_<id> public|secret]; " +
      "pass that ref id and the variable name the app reads. A secret ref cannot use a " +
      "browser-exposed name (NEXT_PUBLIC_, VITE_, PUBLIC_ ...). An existing variable is " +
      "only replaced with overwrite: true.",
    parameters: z.object({
      name: z.string().describe("Variable name, e.g. VITE_SUPABASE_URL. Letters, digits and underscores."),
      ref: z.string().describe("The ref id from the tool result, e.g. ref_0123abcd..."),
      overwrite: z.boolean().optional().describe("Replace an existing variable. Only when the user wants it replaced."),
    }),
    handler: async (params, { step }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) return `Error: ${parsed.error.issues[0].message}`;

      const { name, overwrite = false } = parsed.data;
      if (!isValidEnvKey(name)) {
        return (
          `Error: "${name}" is not a valid environment variable name. ` +
          `Use letters, digits and underscores, starting with a letter or underscore.`
        );
      }
      // Accept the whole [env-ref:…] token too; models often pass it verbatim.
      const ref = REF_ID.exec(parsed.data.ref)?.[0];
      if (!ref) return "Error: ref must look like ref_ followed by 32 hex characters.";
      const visibility = classifyEnvKey(name);

      const run = async (): Promise<string> => {
        try {
          const found = await convex.mutation(api.envRefs.resolveEnvRef, {
            internalKey,
            refId: ref,
            projectId,
            ownerId,
            messageId,
            key: name,
          });
          if (!found) {
            return `Error: ref ${ref} is unknown or expired. Call the integration tool again for a fresh ref.`;
          }
          if (found.visibility === "secret" && visibility === "public") {
            return (
              `Error: not stored. ${name} is published in the browser bundle and this ref is a secret. ` +
              `Use a name without a public prefix and read it only from server code.`
            );
          }
          if (found.keyExists && !overwrite) {
            return `Error: ${name} is already set. Pass overwrite: true only if the user wants it replaced.`;
          }

          const sealer = getSecretSealer();
          const value = await sealer.open(found, secretContext("mcpEnvRefs", ref, "value"));
          const scope = { internalKey, projectId, ownerId, key: name };

          if (visibility === "public") {
            await convex.mutation(api.system.setPublicEnvVarInternal, { ...scope, value });
          } else {
            // Generated before the insert so it can anchor the AAD in a single write.
            const secretRef = nanoid();
            const sealed = await sealer.seal(value, secretContext("projectEnvVars", secretRef, "value"));
            await convex.mutation(api.system.setSecretEnvVar, {
              ...scope,
              secretRef,
              maskedPreview: maskSecret(value),
              source: "integration",
              ...sealed,
            });
          }

          // Previews still holding the old value stop now, not at the next sweep.
          await killOutdatedPreviews(internalKey, projectId);
          if (found.keyExists) {
            console.info("[env-refs] overwrote env var", JSON.stringify({ key: name, projectId, refId: ref }));
          }
          return `Set ${name} (${visibility})`;
        } catch (error) {
          // A Convex validation error can echo arguments, the value among them: log the name only.
          console.error("[env-refs] setEnvVarFromRef failed", error instanceof Error ? error.name : "unknown");
          return GENERIC_ERROR;
        }
      };

      try {
        return step ? await step.run(`set-env-var-from-ref-${name}`, run) : await run();
      } catch {
        // run() never throws; this covers the step machinery, kept generic like everything else.
        return GENERIC_ERROR;
      }
    },
  });
