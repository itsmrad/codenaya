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
    expect(kms.state.encrypts[0].KeyId).toBe(ARN_A);
    expect(kms.state.encrypts[0].EncryptionContext).toEqual(context);
    expect(kms.state.decrypts[0].KeyId).toBe(ARN_A);
    expect(kms.state.decrypts[0].EncryptionContext).toEqual(context);
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

describe("SDK client", () => {
  it("fails a stalled KMS call at the deadline without exposing the DEK", async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .spyOn(KMSClient.prototype, "send")
        .mockImplementation((() => new Promise(() => {})) as never);
      const result = createAwsKmsEnvKek(keySet(ARN_A))(DEST)
        .wrapDek(DEK)
        .catch((error: Error) => error);

      await vi.advanceTimersByTimeAsync(10_000);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("TimeoutError");
      expect(String(error)).not.toContain(DEK.toString("base64"));
      const options = send.mock.calls[0][1] as { abortSignal: AbortSignal };
      expect(options.abortSignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins the endpoint to the ARN's region despite ambient endpoint env", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL", "https://attacker.example");
    vi.stubEnv("AWS_ENDPOINT_URL_KMS", "https://attacker.example");
    const send = vi
      .spyOn(KMSClient.prototype, "send")
      .mockImplementation((async () => ({ KeyId: ARN_B, CiphertextBlob: Buffer.from("w") })) as never);

    await createAwsKmsEnvKek(keySet(ARN_B))(DEST).wrapDek(DEK);
    const client = send.mock.contexts[0] as KMSClient;
    expect((await client.config.endpoint!()).hostname).toBe("kms.eu-west-1.amazonaws.com");
  });

  it("throws on request timeout instead of only warning", () => {
    const config = kmsClientConfig("ap-south-1", { accessKeyId: "a", secretAccessKey: "b" });
    expect(config).toMatchObject({
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      maxAttempts: 2,
      requestHandler: { requestTimeout: 5000, connectionTimeout: 5000, throwOnRequestTimeout: true },
    });
  });
});

describe("regionOfKeyArn", () => {
  it.each([
    [ARN_B, "eu-west-1"],
    [`arn:aws:kms:us-east-1:111111111111:key/mrk-${"0123456789abcdef".repeat(2)}`, "us-east-1"],
  ])("accepts %s", (arn, region) => {
    expect(regionOfKeyArn(arn)).toBe(region);
  });

  it.each([
    "arn:aws:kms:ap-south-1:111111111111:alias/env",
    ARN_A.replace("arn:aws:", "arn:aws-cn:"),
    ARN_A.replace("aaaaaaaa", "AAAAAAAA"),
    "arn:aws:kms:ap-south-1:111111111111:key/---",
    ` ${ARN_A}`,
    "",
  ])("rejects %j", (arn) => {
    expect(() => regionOfKeyArn(arn)).toThrow(/not a full AWS KMS key ARN/);
  });

  it("trims the configured current ARN and drops empty list entries", () => {
    stubConfig({ ...CREDS, ENV_VARS_KMS_KEY_ARN: ` ${ARN_A} `, ENV_VARS_KMS_PREVIOUS_KEY_ARNS: `,,${ARN_B},` });
    expect(readEnvKmsKeySetFromEnv()).toMatchObject({ currentArn: ARN_A, previousArns: [ARN_B] });
  });
});
