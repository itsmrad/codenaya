/**
 * In-memory stand-in for AWS KMS, for tests only. Like the real service it
 * refuses a Decrypt whose key or encryption context differs from the Encrypt,
 * and it can be switched off to simulate an outage or timeout.
 */

import { randomBytes } from "node:crypto";

import type { DecryptCommandInput, EncryptCommandInput } from "@aws-sdk/client-kms";

import type { EnvKmsKeySet, KmsClient, KmsClientFactory } from "./aws-kms";

export const ARN_A = "arn:aws:kms:ap-south-1:111111111111:key/aaaaaaaa-0000-4000-8000-000000000001";
export const ARN_B = "arn:aws:kms:eu-west-1:222222222222:key/bbbbbbbb-0000-4000-8000-000000000002";
export const ARN_UNKNOWN =
  "arn:aws:kms:ap-south-1:333333333333:key/cccccccc-0000-4000-8000-000000000003";

export function keySet(currentArn: string, previousArns: string[] = []): EnvKmsKeySet {
  return {
    currentArn,
    previousArns,
    credentials: { accessKeyId: "dummy-access-key-id", secretAccessKey: "dummy-secret" },
  };
}

const contextKey = (context: Record<string, string> | undefined) =>
  JSON.stringify(Object.entries(context ?? {}).sort());

export function createFakeKms() {
  const wraps = new Map<string, { keyId: string; context: string; plaintext: Buffer }>();
  const state = {
    down: false,
    encrypts: [] as EncryptCommandInput[],
    decrypts: [] as DecryptCommandInput[],
    regions: [] as string[],
  };

  const client: KmsClient = {
    async encrypt(input) {
      state.encrypts.push(input);
      if (state.down) throw new Error("fake KMS: request timed out");
      const blob = randomBytes(48);
      wraps.set(blob.toString("base64"), {
        keyId: input.KeyId!,
        context: contextKey(input.EncryptionContext),
        plaintext: Buffer.from(input.Plaintext!),
      });
      return { KeyId: input.KeyId, CiphertextBlob: blob };
    },
    async decrypt(input) {
      state.decrypts.push(input);
      if (state.down) throw new Error("fake KMS: request timed out");
      const wrap = wraps.get(Buffer.from(input.CiphertextBlob!).toString("base64"));
      if (
        !wrap ||
        wrap.keyId !== input.KeyId ||
        wrap.context !== contextKey(input.EncryptionContext)
      ) {
        throw new Error("fake KMS: InvalidCiphertextException");
      }
      return { KeyId: wrap.keyId, Plaintext: Buffer.from(wrap.plaintext) };
    },
  };

  const factory: KmsClientFactory = (region) => {
    state.regions.push(region);
    return client;
  };

  return { state, factory };
}
