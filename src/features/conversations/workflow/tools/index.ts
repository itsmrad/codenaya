import { z } from "zod";
import { tool } from "ai";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

interface ToolFactoryOptions {
  internalKey: string;
  projectId: Id<"projects">;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step functions
// Each "use step" function is a durable, retryable, observable workflow step.
// ─────────────────────────────────────────────────────────────────────────────

async function listFilesStep(opts: {
  internalKey: string;
  projectId: Id<"projects">;
}) {
  "use step";

  const files = await convex.query(api.system.getProjectFiles, {
    internalKey: opts.internalKey,
    projectId: opts.projectId,
  });

  const sorted = files.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return sorted.map((f) => ({
    id: f._id,
    name: f.name,
    type: f.type,
    parentId: f.parentId ?? null,
  }));
}

async function readFilesStep(opts: {
  internalKey: string;
  fileIds: string[];
}) {
  "use step";

  const results: { id: string; name: string; content: string }[] = [];

  for (const fileId of opts.fileIds) {
    const file = await convex.query(api.system.getFileById, {
      internalKey: opts.internalKey,
      fileId: fileId as Id<"files">,
    });

    // Treat empty string as a valid (zero-byte) file. Only skip when the
    // file row is missing or content is null/undefined.
    if (file && file.content !== null && file.content !== undefined) {
      results.push({
        id: file._id,
        name: file.name,
        content: file.content,
      });
    }
  }

  return results;
}

async function updateFileStep(opts: {
  internalKey: string;
  fileId: string;
  content: string;
}) {
  "use step";

  const file = await convex.query(api.system.getFileById, {
    internalKey: opts.internalKey,
    fileId: opts.fileId as Id<"files">,
  });

  if (!file) {
    return {
      ok: false as const,
      error: `File with ID "${opts.fileId}" not found. Use listFiles to get valid file IDs.`,
    };
  }

  if (file.type === "folder") {
    return {
      ok: false as const,
      error: `"${opts.fileId}" is a folder, not a file. You can only update file contents.`,
    };
  }

  await convex.mutation(api.system.updateFile, {
    internalKey: opts.internalKey,
    fileId: opts.fileId as Id<"files">,
    content: opts.content,
  });

  return {
    ok: true as const,
    message: `File "${file.name}" updated successfully`,
  };
}

async function createFilesStep(opts: {
  internalKey: string;
  projectId: Id<"projects">;
  parentId: string;
  files: { name: string; content: string }[];
}) {
  "use step";

  let resolvedParentId: Id<"files"> | undefined;

  if (opts.parentId && opts.parentId !== "") {
    resolvedParentId = opts.parentId as Id<"files">;
    const parentFolder = await convex.query(api.system.getFileById, {
      internalKey: opts.internalKey,
      fileId: resolvedParentId,
    });
    if (!parentFolder) {
      return {
        ok: false as const,
        error: `Parent folder with ID "${opts.parentId}" not found. Use listFiles to get valid folder IDs.`,
      };
    }
    if (parentFolder.type !== "folder") {
      return {
        ok: false as const,
        error: `The ID "${opts.parentId}" is a file, not a folder. Use a folder ID as parentId.`,
      };
    }
  }

  const results = await convex.mutation(api.system.createFiles, {
    internalKey: opts.internalKey,
    projectId: opts.projectId,
    parentId: resolvedParentId,
    files: opts.files,
  });

  return { ok: true as const, results };
}

async function createFolderStep(opts: {
  internalKey: string;
  projectId: Id<"projects">;
  name: string;
  parentId: string;
}) {
  "use step";

  if (opts.parentId) {
    const parentFolder = await convex.query(api.system.getFileById, {
      internalKey: opts.internalKey,
      fileId: opts.parentId as Id<"files">,
    });
    if (!parentFolder) {
      return {
        ok: false as const,
        error: `Parent folder with ID "${opts.parentId}" not found. Use listFiles to get valid folder IDs.`,
      };
    }
    if (parentFolder.type !== "folder") {
      return {
        ok: false as const,
        error: `The ID "${opts.parentId}" is a file, not a folder. Use a folder ID as parentId.`,
      };
    }
  }

  const folderId = await convex.mutation(api.system.createFolder, {
    internalKey: opts.internalKey,
    projectId: opts.projectId,
    name: opts.name,
    parentId: opts.parentId ? (opts.parentId as Id<"files">) : undefined,
  });

  return { ok: true as const, folderId };
}

async function renameFileStep(opts: {
  internalKey: string;
  fileId: string;
  newName: string;
}) {
  "use step";

  const file = await convex.query(api.system.getFileById, {
    internalKey: opts.internalKey,
    fileId: opts.fileId as Id<"files">,
  });

  if (!file) {
    return {
      ok: false as const,
      error: `File with ID "${opts.fileId}" not found. Use listFiles to get valid file IDs.`,
    };
  }

  await convex.mutation(api.system.renameFile, {
    internalKey: opts.internalKey,
    fileId: opts.fileId as Id<"files">,
    newName: opts.newName,
  });

  return {
    ok: true as const,
    message: `Renamed "${file.name}" to "${opts.newName}" successfully`,
  };
}

async function deleteFilesStep(opts: {
  internalKey: string;
  fileIds: string[];
}) {
  "use step";

  const targets: { id: string; name: string; type: string }[] = [];
  for (const fileId of opts.fileIds) {
    const file = await convex.query(api.system.getFileById, {
      internalKey: opts.internalKey,
      fileId: fileId as Id<"files">,
    });
    if (!file) {
      return {
        ok: false as const,
        error: `File with ID "${fileId}" not found. Use listFiles to get valid file IDs.`,
      };
    }
    targets.push({ id: file._id, name: file.name, type: file.type });
  }

  const messages: string[] = [];
  for (const file of targets) {
    await convex.mutation(api.system.deleteFile, {
      internalKey: opts.internalKey,
      fileId: file.id as Id<"files">,
    });
    messages.push(`Deleted ${file.type} "${file.name}" successfully`);
  }

  return { ok: true as const, messages };
}

async function scrapeUrlsStep(opts: { urls: string[] }) {
  "use step";

  // Lazy import: firecrawl is a Node.js client and only runs in step context.
  const { firecrawl } = await import("@/lib/firecrawl");

  const results: { url: string; content: string }[] = [];

  for (const url of opts.urls) {
    try {
      const result = await firecrawl.scrape(url, { formats: ["markdown"] });
      if (result.markdown) {
        results.push({ url, content: result.markdown });
      } else {
        results.push({ url, content: `No markdown returned for ${url}` });
      }
    } catch (error) {
      results.push({
        url,
        content: `Failed to scrape: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// Returns the AI SDK ToolSet shape consumed by DurableAgent.
//
// Why we wrap step calls in try/catch at the tool level:
// - "use step" functions are auto-retried up to 3 times by the Workflow SDK.
// - If all retries fail (e.g. a long network blip on Convex), the step throws.
// - Without a catch here, the throw becomes a FatalError surfaced to the
//   model as a tool failure, and the agent typically gives up and reports
//   the failure to the user instead of trying again.
// - By converting failures into a readable error string, the model treats it
//   as a recoverable tool result and can retry the same call on the next
//   iteration of its loop, matching the Inngest implementation's behavior.
// ─────────────────────────────────────────────────────────────────────────────

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

async function safeExecute<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<T | string> {
  try {
    return await fn();
  } catch (error) {
    return `Error: ${toolName} failed transiently (${describeError(error)}). The underlying step exhausted its retries. You may try this tool again on the next turn.`;
  }
}

export function createCodingTools({ internalKey, projectId }: ToolFactoryOptions) {
  return {
    listFiles: tool({
      description:
        "List all files and folders in the project. Returns names, IDs, types, and parentId for each item. Items with parentId: null are at root level. Use the parentId to understand the folder structure - items with the same parentId are in the same folder.",
      inputSchema: z.object({}),
      execute: async () =>
        safeExecute("listFiles", async () => {
          const list = await listFilesStep({ internalKey, projectId });
          return JSON.stringify(list);
        }),
    }),

    readFiles: tool({
      description:
        "Read the content of files from the project. Returns file contents.",
      inputSchema: z.object({
        fileIds: z
          .array(z.string().min(1, "File ID cannot be empty"))
          .min(1, "Provide at least one file ID")
          .describe("Array of file IDs to read"),
      }),
      execute: async ({ fileIds }) =>
        safeExecute("readFiles", async () => {
          const files = await readFilesStep({ internalKey, fileIds });
          if (files.length === 0) {
            return "Error: No files found with provided IDs. Use listFiles to get valid fileIDs.";
          }
          return JSON.stringify(files);
        }),
    }),

    updateFile: tool({
      description: "Update the content of an existing file",
      inputSchema: z.object({
        fileId: z.string().min(1, "File ID is required").describe("The ID of the file to update"),
        content: z.string().describe("The new content for the file"),
      }),
      execute: async ({ fileId, content }) =>
        safeExecute("updateFile", async () => {
          const result = await updateFileStep({ internalKey, fileId, content });
          return result.ok ? result.message : `Error: ${result.error}`;
        }),
    }),

    createFiles: tool({
      description:
        "Create multiple files at once in the same folder. Use this to batch create files that share the same parent folder. More efficient than creating files one by one.",
      inputSchema: z.object({
        parentId: z
          .string()
          .describe(
            "The ID of the parent folder. Use empty string for root level. Must be a valid folder ID from listFiles."
          ),
        files: z
          .array(
            z.object({
              name: z.string().min(1, "File name cannot be empty").describe("The file name including extension"),
              content: z.string().describe("The file content"),
            })
          )
          .min(1, "Provide at least one file to create")
          .describe("Array of files to create"),
      }),
      execute: async ({ parentId, files }) =>
        safeExecute("createFiles", async () => {
          const result = await createFilesStep({ internalKey, projectId, parentId, files });
          if (!result.ok) return `Error: ${result.error}`;

          const created = result.results.filter((r) => !r.error);
          const failed = result.results.filter((r) => r.error);
          let response = `Created ${created.length} file(s)`;
          if (created.length > 0) {
            response += `: ${created.map((r) => r.name).join(", ")}`;
          }
          if (failed.length > 0) {
            response += `. Failed: ${failed.map((r) => `${r.name} (${r.error})`).join(", ")}`;
          }
          return response;
        }),
    }),

    createFolder: tool({
      description: "Create a new folder in the project",
      inputSchema: z.object({
        name: z.string().min(1, "Folder name is required").describe("The name of the folder to create"),
        parentId: z
          .string()
          .describe(
            "The ID (not name!) of the parent folder from listFiles, or empty string for root level"
          ),
      }),
      execute: async ({ name, parentId }) =>
        safeExecute("createFolder", async () => {
          const result = await createFolderStep({ internalKey, projectId, name, parentId });
          return result.ok ? `Folder created with ID: ${result.folderId}` : `Error: ${result.error}`;
        }),
    }),

    renameFile: tool({
      description: "Rename a file or folder",
      inputSchema: z.object({
        fileId: z.string().min(1, "File ID is required").describe("The ID of the file or folder to rename"),
        newName: z.string().min(1, "New name is required").describe("The new name for the file or folder"),
      }),
      execute: async ({ fileId, newName }) =>
        safeExecute("renameFile", async () => {
          const result = await renameFileStep({ internalKey, fileId, newName });
          return result.ok ? result.message : `Error: ${result.error}`;
        }),
    }),

    deleteFiles: tool({
      description:
        "Delete files or folders from the project. If deleting a folder, all contents will be deleted recursively.",
      inputSchema: z.object({
        fileIds: z
          .array(z.string().min(1, "File ID cannot be empty"))
          .min(1, "Provide at least one file ID")
          .describe("Array of file or folder IDs to delete"),
      }),
      execute: async ({ fileIds }) =>
        safeExecute("deleteFiles", async () => {
          const result = await deleteFilesStep({ internalKey, fileIds });
          return result.ok ? result.messages.join("\n") : `Error: ${result.error}`;
        }),
    }),

    scrapeUrls: tool({
      description:
        "Scrape content from URLs to get documentation or reference material. Use this when the user provides URLs or references external documentation. Returns markdown content from the scraped pages.",
      inputSchema: z.object({
        urls: z
          .array(z.url("Invalid URL format"))
          .min(1, "Provide at least one URL to scrape")
          .describe("Array of URLs to scrape for content"),
      }),
      execute: async ({ urls }) =>
        safeExecute("scrapeUrls", async () => {
          const results = await scrapeUrlsStep({ urls });
          if (results.length === 0) {
            return "No content could be scraped from the provided URLs.";
          }
          return JSON.stringify(results);
        }),
    }),
  };
}
