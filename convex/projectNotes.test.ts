// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";
import { NOTE_CREDENTIAL_ERROR } from "../src/features/projects/notes";
import { MAX_PROJECT_NOTE_LENGTH, MAX_PROJECT_NOTES } from "../src/features/projects/notes";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    alice: t.withIdentity({ subject: "user_alice" }),
    bob: t.withIdentity({ subject: "user_bob" }),
  };
}

describe("projectNotes", () => {
  test("the owner adds, edits, lists and deletes notes", async () => {
    const { alice } = setup();
    const projectId = await alice.mutation(api.projects.create, { name: "Site" });

    await alice.mutation(api.projectNotes.add, { projectId, text: "  Prices are in EUR " });
    await alice.mutation(api.projectNotes.add, { projectId, text: "Keep the header sticky" });
    const [first, second] = await alice.query(api.projectNotes.list, { projectId });
    expect([first.text, second.text]).toEqual(["Prices are in EUR", "Keep the header sticky"]);

    await alice.mutation(api.projectNotes.update, { projectId, noteId: first.id, text: "Prices in USD" });
    await alice.mutation(api.projectNotes.remove, { projectId, noteId: second.id });
    const notes = await alice.query(api.projectNotes.list, { projectId });
    expect(notes.map((note) => note.text)).toEqual(["Prices in USD"]);
  });

  test("another user can't read or write the notes", async () => {
    const { alice, bob } = setup();
    const projectId = await alice.mutation(api.projects.create, { name: "Site" });
    await alice.mutation(api.projectNotes.add, { projectId, text: "Secret note" });
    const [note] = await alice.query(api.projectNotes.list, { projectId });

    await expect(bob.query(api.projectNotes.list, { projectId })).rejects.toThrow(/Unauthorized/);
    await expect(bob.mutation(api.projectNotes.add, { projectId, text: "x" })).rejects.toThrow(/Unauthorized/);
    await expect(
      bob.mutation(api.projectNotes.update, { projectId, noteId: note.id, text: "x" }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(bob.mutation(api.projectNotes.remove, { projectId, noteId: note.id })).rejects.toThrow(
      /Unauthorized/,
    );
    expect(await alice.query(api.projectNotes.list, { projectId })).toHaveLength(1);
  });

  test("rejects empty, too long and too many notes", async () => {
    const { alice } = setup();
    const projectId = await alice.mutation(api.projects.create, { name: "Site" });

    await expect(alice.mutation(api.projectNotes.add, { projectId, text: "  " })).rejects.toThrow(/empty/);
    await expect(
      alice.mutation(api.projectNotes.add, { projectId, text: "x".repeat(MAX_PROJECT_NOTE_LENGTH + 1) }),
    ).rejects.toThrow(/at most/);
    for (let i = 0; i < MAX_PROJECT_NOTES; i++) {
      await alice.mutation(api.projectNotes.add, { projectId, text: `note ${i}` });
    }
    await expect(alice.mutation(api.projectNotes.add, { projectId, text: "one more" })).rejects.toThrow(
      /at most/,
    );
  });

  test("refuses a note holding a credential, on add and update", async () => {
    const { alice } = setup();
    const projectId = await alice.mutation(api.projects.create, { name: "Site" });
    // Assembled so no key-shaped literal sits in the source (as credential-guard.test.ts does).
    const secret = ["sbp", "_", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");

    await expect(
      alice.mutation(api.projectNotes.add, { projectId, text: `Use ${secret} for the API` }),
    ).rejects.toThrow(NOTE_CREDENTIAL_ERROR);

    await alice.mutation(api.projectNotes.add, { projectId, text: "Prices are in EUR" });
    const [note] = await alice.query(api.projectNotes.list, { projectId });
    await expect(
      alice.mutation(api.projectNotes.update, { projectId, noteId: note.id, text: secret }),
    ).rejects.toThrow(NOTE_CREDENTIAL_ERROR);

    const notes = await alice.query(api.projectNotes.list, { projectId });
    expect(notes.map((n) => n.text)).toEqual(["Prices are in EUR"]);
  });
});
