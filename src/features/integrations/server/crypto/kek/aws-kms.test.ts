import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AWS_KMS_PROVIDER_ID,
  createAwsKmsEnvKek,
  ENV_KMS_PURPOSE,
  kmsClientConfig,
  readEnvKmsKeySetFromEnv,
  regionOfKeyArn,
} from "./aws-kms";
import { ARN_A, ARN_B, ARN_UNKNOWN, createFakeKms, keySet } from "./fake-kms.fixture";

const DEST = { projectId: "project_1", envKey: "DB_URL" };
const DEK = Buffer.alloc(32, 7);

function stubConfig(env: Record<string, string>) {
  for (const name of [
    "ENV_VARS_KMS_KEY_ARN",
    "ENV_VARS_KMS_PREVIOUS_KEY_ARNS",
    "ENV_VARS_KMS_ACCESS_KEY_ID",
    "ENV_VARS_KMS_SECRET_ACCESS_KEY",
    "ENV_VARS_KMS_REGION",
  ]) {
    vi.stubEnv(name, env[name] ?? "");
  }
}

const CREDS = {
  ENV_VARS_KMS_ACCESS_KEY_ID: "dummy-access-key-id",
  ENV_VARS_KMS_SECRET_ACCESS_KEY: "dummy-secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readEnvKmsKeySetFromEnv", () => {
  it("reads the current key and reader-only previous keys", () => {
    stubConfig({
      ...CREDS,
      ENV_VARS_KMS_KEY_ARN: ARN_A,
      ENV_VARS_KMS_PREVIOUS_KEY_ARNS: ` ${ARN_B} ,`,
      ENV_VARS_KMS_REGION: "ap-south-1",
    });
    expect(readEnvKmsKeySetFromEnv()).toEqual({
      currentArn: ARN_A,
      previousArns: [ARN_B],
      credentials: { accessKeyId: "dummy-access-key-id", secretAccessKey: "dummy-secret" },
    });
  });

  it.each([
    ["the key ARN", { ...CREDS }],
    ["credentials", { ENV_VARS_KMS_KEY_ARN: ARN_A }],
  ])("fails closed when %s is missing", (_label, env) => {
    stubConfig(env);
    expect(() => readEnvKmsKeySetFromEnv()).toThrow(/not configured/);
  });

  it("rejects aliases and malformed ARNs", () => {
    stubConfig({ ...CREDS, ENV_VARS_KMS_KEY_ARN: "arn:aws:kms:ap-south-1:111111111111:alias/env" });
    expect(() => readEnvKmsKeySetFromEnv()).toThrow(/not a full AWS KMS key ARN/);

    stubConfig({ ...CREDS, ENV_VARS_KMS_KEY_ARN: ARN_A, ENV_VARS_KMS_PREVIOUS_KEY_ARNS: "key-id-only" });
    expect(() => readEnvKmsKeySetFromEnv()).toThrow(/not a full AWS KMS key ARN/);
  });

  it("rejects a region that disagrees with the current key's ARN", () => {
    stubConfig({ ...CREDS, ENV_VARS_KMS_KEY_ARN: ARN_A, ENV_VARS_KMS_REGION: "us-east-1" });
    expect(() => readEnvKmsKeySetFromEnv()).toThrow(/does not match/);
  });

  it("rejects the current key in the previous list", () => {
    stubConfig({ ...CREDS, ENV_VARS_KMS_KEY_ARN: ARN_A, ENV_VARS_KMS_PREVIOUS_KEY_ARNS: ARN_A });
    expect(() => readEnvKmsKeySetFromEnv()).toThrow(/contains the current key/);
  });
});

describe("createAwsKmsEnvKek", () => {
  it("passes the destination context on Encrypt and Decrypt", async () => {
    const kms = createFakeKms();
    const provider = createAwsKmsEnvKek(keySet(ARN_A), kms.factory)(DEST);
    expect(provider.id).toBe(AWS_KMS_PROVIDER_ID);
    expect(provider.activeKeyId).toBe(ARN_A);

    const wrapped = await provider.wrapDek(DEK);
    expect(await provider.unwrapDek(wrapped, ARN_A)).toEqual(DEK);

    const context = { projectId: "project_1", envKey: "DB_URL", purpose: ENV_KMS_PURPOSE };
    expect(kms.state.encrypts[0]).toMatchObject({ KeyId: ARN_A, EncryptionContext: context });
    expect(kms.state.decrypts[0]).toMatchObject({ KeyId: ARN_A, EncryptionContext: context });
  });

  it("refuses an ARN outside the key set without calling KMS", async () => {
    const kms = createFakeKms();
    const provider = createAwsKmsEnvKek(keySet(ARN_A, [ARN_B]), kms.factory)(DEST);
    await expect(provider.unwrapDek("AAAA", ARN_UNKNOWN)).rejects.toThrow(/not in the configured/);
    await expect(provider.unwrapDek("AAAA", "alias/env")).rejects.toThrow(/not in the configured/);
    expect(kms.state.decrypts).toHaveLength(0);
  });

  it("reads under a previous key in that key's own region; writes use the current key", async () => {
    const kms = createFakeKms();
    const old = await createAwsKmsEnvKek(keySet(ARN_B), kms.factory)(DEST).wrapDek(DEK);

    const provider = createAwsKmsEnvKek(keySet(ARN_A, [ARN_B]), kms.factory)(DEST);
    expect(await provider.unwrapDek(old, ARN_B)).toEqual(DEK);
    await provider.wrapDek(DEK);

    expect(kms.state.encrypts.map((input) => input.KeyId)).toEqual([ARN_B, ARN_A]);
    expect(kms.state.regions).toEqual(["eu-west-1", "eu-west-1", "ap-south-1"]);
  });

  it("refuses an Encrypt response from a different key", async () => {
    const provider = createAwsKmsEnvKek(keySet(ARN_A), () => ({
      encrypt: async () => ({ KeyId: ARN_B, CiphertextBlob: Buffer.alloc(8) }),
      decrypt: async () => ({}),
    }))(DEST);
    await expect(provider.wrapDek(DEK)).rejects.toThrow(/current key/);
  });

  it("requires a destination", () => {
    const kek = createAwsKmsEnvKek(keySet(ARN_A), createFakeKms().factory);
    expect(() => kek({ projectId: "", envKey: "DB_URL" })).toThrow(/projectId and an envKey/);
  });

  it("sends narrow SDK commands to the ARN's region with bounded retries", async () => {
    const send = vi
      .spyOn(KMSClient.prototype, "send")
      // `send` is overloaded per command; the cast keeps the stub readable.
      .mockImplementation((async (command: unknown) =>
        command instanceof EncryptCommand
          ? { KeyId: ARN_A, CiphertextBlob: Buffer.from("wrapped") }
          : { KeyId: ARN_A, Plaintext: Buffer.from(DEK) }) as never);
    const provider = createAwsKmsEnvKek(keySet(ARN_A))(DEST);

    const wrapped = await provider.wrapDek(DEK);
    expect(await provider.unwrapDek(wrapped, ARN_A)).toEqual(DEK);

    expect(send.mock.calls[0][0]).toBeInstanceOf(EncryptCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DecryptCommand);
    const client = send.mock.contexts[0] as KMSClient;
    expect(await client.config.region()).toBe("ap-south-1");
    expect(await client.config.maxAttempts()).toBe(2);
  });
});

describe("helpers", () => {
  it("parses the region from a key ARN", () => {
    expect(regionOfKeyArn(ARN_B)).toBe("eu-west-1");
  });

  it("configures explicit credentials and a 5 s deadline", () => {
    const config = kmsClientConfig("ap-south-1", { accessKeyId: "a", secretAccessKey: "b" });
    expect(config).toMatchObject({
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      maxAttempts: 2,
      requestHandler: { requestTimeout: 5000, connectionTimeout: 5000 },
    });
  });
});
