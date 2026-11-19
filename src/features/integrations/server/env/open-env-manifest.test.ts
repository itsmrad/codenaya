import { afterEach, describe, expect, it, vi } from "vitest";

import { createEnvSealer } from "../crypto/env-sealer";
import { createAwsKmsEnvKek } from "../crypto/kek/aws-kms";
import { ARN_A, createFakeKms, keySet } from "../crypto/kek/fake-kms.fixture";
import { openEnvManifest } from "./open-env-manifest";

const PROJECT = "project_1";

async function setup(keys: string[]) {
  const kms = createFakeKms();
  const sealer = createEnvSealer({ kms: () => createAwsKmsEnvKek(keySet(ARN_A), kms.factory) });
  const records = await Promise.all(
    keys.map(async (key, index) => ({
      _id: `row_${index}`,
      projectId: PROJECT,
      key,
      visibility: "secret" as const,
      secretRef: `ref_${index}`,
      ...(await sealer.seal(`canary-not-secret-${index}`, `ref_${index}`, {
        projectId: PROJECT,
        envKey: key,
      })),
    })),
  );
  return { kms, sealer, records };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openEnvManifest", () => {
  it("opens every secret, skipping public rows", async () => {
    const { sealer, records } = await setup(["DB_URL", "API_KEY", "A", "B", "C"]);
    const publicRow = {
      _id: "row_p",
      projectId: PROJECT,
      key: "NEXT_PUBLIC_X",
      visibility: "public" as const,
      plainValue: "x",
    };

    const manifest = await openEnvManifest(PROJECT, [...records, publicRow], sealer);
    expect(manifest).toEqual({
      ok: true,
      secretEntries: ["DB_URL", "API_KEY", "A", "B", "C"].map((key, index) => ({
        key,
        value: `canary-not-secret-${index}`,
      })),
    });
  });

  it("fails the whole manifest on a KMS outage and returns names only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { kms, sealer, records } = await setup(["DB_URL", "API_KEY"]);
    kms.state.down = true;

    const manifest = await openEnvManifest(PROJECT, records, sealer);
    expect(manifest).toEqual({ ok: false, keys: ["DB_URL", "API_KEY"] });
    expect(JSON.stringify(manifest)).not.toContain("canary");
  });

  it("fails the whole manifest when one row is swapped onto another key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sealer, records } = await setup(["DB_URL", "API_KEY"]);
    const [db, api] = records;
    const swapped = [db, { ...db, _id: api._id, key: api.key }];

    expect(await openEnvManifest(PROJECT, swapped, sealer)).toEqual({
      ok: false,
      keys: ["DB_URL", "API_KEY"],
    });
  });

  it("refuses rows from another project", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { kms, sealer, records } = await setup(["DB_URL"]);

    expect(await openEnvManifest("project_2", records, sealer)).toEqual({
      ok: false,
      keys: ["DB_URL"],
    });
    expect(kms.state.decrypts).toHaveLength(0);
  });
});
