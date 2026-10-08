import { describe, expect, it, vi } from "vitest";

import { Id } from "../../../../convex/_generated/dataModel";

import { createProjectZip, getZipFileName, ZipSourceFile } from "./download-zip";

const file = (
  id: string,
  name: string,
  fields: Partial<ZipSourceFile> = {},
): ZipSourceFile => ({
  _id: id as Id<"files">,
  _creationTime: 0,
  projectId: "project" as Id<"projects">,
  name,
  type: "file",
  updatedAt: 0,
  storageUrl: null,
  ...fields,
});

describe("createProjectZip", () => {
  it("keeps the folder structure and writes text and binary files", async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const fetchBinary = vi.fn(async () => binary.buffer);

    const zip = await createProjectZip(
      [
        file("src", "src", { type: "folder" }),
        file("components", "components", { type: "folder", parentId: "src" as Id<"files"> }),
        file("empty", "empty", { type: "folder" }),
        file("readme", "README.md", { content: "# Hello" }),
        file("button", "button.tsx", {
          parentId: "components" as Id<"files">,
          content: "export const Button = () => null;",
        }),
        file("logo", "logo.png", {
          parentId: "src" as Id<"files">,
          storageId: "storage" as Id<"_storage">,
          storageUrl: "https://storage.example/logo",
        }),
      ],
      fetchBinary,
    );

    expect(Object.keys(zip.files).sort()).toEqual([
      "README.md",
      "empty/",
      "src/",
      "src/components/",
      "src/components/button.tsx",
      "src/logo.png",
    ]);
    expect(await zip.file("README.md")!.async("string")).toBe("# Hello");
    expect(await zip.file("src/components/button.tsx")!.async("string")).toBe(
      "export const Button = () => null;",
    );
    expect(await zip.file("src/logo.png")!.async("uint8array")).toEqual(binary);
    expect(fetchBinary).toHaveBeenCalledWith("https://storage.example/logo");
  });

  it("fails when a binary file has no download URL", async () => {
    await expect(
      createProjectZip([
        file("logo", "logo.png", { storageId: "storage" as Id<"_storage"> }),
      ]),
    ).rejects.toThrow("logo.png");
  });
});

describe("getZipFileName", () => {
  it("uses the project name", () => {
    expect(getZipFileName("my-app")).toBe("my-app.zip");
  });

  it("replaces characters that are invalid in file names", () => {
    expect(getZipFileName("a/b:c")).toBe("a-b-c.zip");
  });

  it("falls back when the name is blank", () => {
    expect(getZipFileName("  ")).toBe("project.zip");
  });
});
