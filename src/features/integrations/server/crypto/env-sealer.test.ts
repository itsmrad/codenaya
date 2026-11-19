import { randomBytes } from "node:crypto";

import { KMSClient } from "@aws-sdk/client-kms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvSealer } from "./env-sealer";
import { getSecretSealer, resetSecretSealer } from "./index";
import { createAwsKmsEnvKek } from "./kek/aws-kms";
import { ARN_A, ARN_B, createFakeKms, keySet } from "./kek/fake-kms.fixture";
import { createLocalKekProvider } from "./kek/local";
import { secretContext } from "./types";

const CANARY = "canary-not-secret-value";
const DB_URL = { projectId: "project_1", envKey: "DB_URL" };
const API_KEY = { projectId: "project_1", envKey: "API_KEY" };
const OTHER_PROJECT = { projectId: "project_2", envKey: "DB_URL" };

function sealerWith(kms: ReturnType<typeof createFakeKms>, current = ARN_A, previous: string[] = []) {
  return createEnvSealer({ kms: () => createAwsKmsEnvKek(keySet(current, previous), kms.factory) });
}

function clearKmsEnv() {
  for (const name of [
    "ENV_VARS_KMS_KEY_ARN",
    "ENV_VARS_KMS_PREVIOUS_KEY_ARNS",
    "ENV_VARS_KMS_ACCESS_KEY_ID",
    "ENV_VARS_KMS_SECRET_ACCESS_KEY",
  ]) {
    vi.stubEnv(name, "");
  }
}

beforeEach(() => {
  resetSecretSealer();
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
  vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSecretSealer();
});

describe("createEnvSealer with AWS KMS", () => {
  it("seals under the current key and records provider + ARN", async () => {
    const kms = createFakeKms();
    const sealer = sealerWith(kms);

    const sealed = await sealer.seal(CANARY, "ref_1", DB_URL);
    expect(sealed).toMatchObject({ kekProvider: "aws-kms", kekKeyId: ARN_A });
    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(await sealer.open(sealed, "ref_1", DB_URL)).toBe(CANARY);
  });

  it("refuses an envelope + secretRef swapped to another key of the same project", async () => {
    const sealer = sealerWith(createFakeKms());
    const sealed = await sealer.seal(CANARY, "ref_1", DB_URL);
    await expect(sealer.open(sealed, "ref_1", API_KEY)).rejects.toThrow(/InvalidCiphertext/);
  });

  it("refuses an envelope + secretRef swapped to another project", async () => {
    const sealer = sealerWith(createFakeKms());
    const sealed = await sealer.seal(CANARY, "ref_1", DB_URL);
    await expect(sealer.open(sealed, "ref_1", OTHER_PROJECT)).rejects.toThrow(/InvalidCiphertext/);
  });

  it("opens rows under a previous key and always writes with the current key", async () => {
    const kms = createFakeKms();
    const old = await sealerWith(kms, ARN_B).seal(CANARY, "ref_1", DB_URL);

    const sealer = sealerWith(kms, ARN_A, [ARN_B]);
    expect(await sealer.open(old, "ref_1", DB_URL)).toBe(CANARY);
    expect((await sealer.seal(CANARY, "ref_2", DB_URL)).kekKeyId).toBe(ARN_A);
  });

  it("refuses a row whose ARN left the key set", async () => {
    const kms = createFakeKms();
    const old = await sealerWith(kms, ARN_B).seal(CANARY, "ref_1", DB_URL);
    await expect(sealerWith(kms, ARN_A).open(old, "ref_1", DB_URL)).rejects.toThrow(
      /not in the configured/,
    );
  });

  it("calls KMS on every open and fails once KMS is down (no cache)", async () => {
    const kms = createFakeKms();
    const sealer = sealerWith(kms);
    const sealed = await sealer.seal(CANARY, "ref_1", DB_URL);

    await sealer.open(sealed, "ref_1", DB_URL);
    await sealer.open(sealed, "ref_1", DB_URL);
    expect(kms.state.decrypts).toHaveLength(2);

    kms.state.down = true;
    await expect(sealer.open(sealed, "ref_1", DB_URL)).rejects.toThrow(/timed out/);
  });

  it("fails closed on seal and AWS reads when config is missing; legacy rows still open", async () => {
    clearKmsEnv();
    const legacySealed = await getSecretSealer().seal(
      CANARY,
      secretContext("projectEnvVars", "ref_legacy", "value"),
    );
    const awsSealed = await sealerWith(createFakeKms()).seal(CANARY, "ref_1", DB_URL);

    const sealer = createEnvSealer();
    await expect(sealer.seal(CANARY, "ref_2", DB_URL)).rejects.toThrow(/not configured/);
    await expect(sealer.open(awsSealed, "ref_1", DB_URL)).rejects.toThrow(/not configured/);
    expect(await sealer.open(legacySealed, "ref_legacy", DB_URL)).toBe(CANARY);
  });

  it("refuses a legacy row from a provider that is not configured", async () => {
    const legacy = createLocalKekProvider({ activeKek: randomBytes(32).toString("base64") });
    const sealer = createEnvSealer({ legacy: () => legacy });
    await expect(
      sealer.open(
        { kekProvider: "gcp-kms", kekKeyId: "k", wrappedDek: "", ciphertext: "", iv: "", authTag: "" },
        "ref_1",
        DB_URL,
      ),
    ).rejects.toThrow(/sealed with KEK provider "gcp-kms" but "local"/);
  });
});

describe("BYOK / MCP sealing is unchanged", () => {
  it("keeps sealing with the legacy provider and never calls KMS", async () => {
    const send = vi.spyOn(KMSClient.prototype, "send");
    const sealer = getSecretSealer();
    for (const aad of [
      secretContext("userProviderKeys", "key_1", "apiKey"),
      secretContext("mcpEnvRefs", "ref_1", "value"),
      secretContext("userConnections", "conn_1", "accessToken"),
    ]) {
      const sealed = await sealer.seal(CANARY, aad);
      expect(sealed.kekProvider).toBe("local");
      expect(await sealer.open(sealed, aad)).toBe(CANARY);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("does not open AWS env rows through the shared sealer", async () => {
    const sealed = await sealerWith(createFakeKms()).seal(CANARY, "ref_1", DB_URL);
    await expect(
      getSecretSealer().open(sealed, secretContext("projectEnvVars", "ref_1", "value")),
    ).rejects.toThrow(/sealed with KEK provider "aws-kms"/);
  });

  it("does not accept aws-kms as the global provider", () => {
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "aws-kms");
    expect(() => getSecretSealer()).toThrow(/Unknown CODENAYA_KEK_PROVIDER/);
  });
});
