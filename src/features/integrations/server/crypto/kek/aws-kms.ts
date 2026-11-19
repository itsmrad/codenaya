/**
 * AWS KMS KEK provider for project environment variables only.
 *
 * BYOK keys, OAuth tokens and MCP credentials keep using `getSecretSealer()`;
 * nothing here is selectable through `CODENAYA_KEK_PROVIDER`.
 *
 * Every wrap and unwrap passes an EncryptionContext built from the destination
 * row ({projectId, envKey, purpose}). KMS authenticates that context, so a
 * wrapped DEK copied onto another row or project fails to unwrap. The caller
 * must take the destination from the verified Convex row, never from the
 * envelope or the request.
 *
 * Keys form a SET read from host env on demand:
 * - `ENV_VARS_KMS_KEY_ARN`: the one key new wraps use.
 * - `ENV_VARS_KMS_PREVIOUS_KEY_ARNS`: optional comma list, unwrap only.
 * A row whose key ARN is outside the set is refused before KMS is called. Each
 * call goes to the region named in the key's ARN, never to a row-chosen
 * endpoint. Missing or invalid config throws: there is no local fallback.
 */

import {
  DecryptCommand,
  type DecryptCommandInput,
  type DecryptCommandOutput,
  EncryptCommand,
  type EncryptCommandInput,
  type EncryptCommandOutput,
  KMSClient,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";

import type { KekProvider } from "../types";

export const AWS_KMS_PROVIDER_ID = "aws-kms";

/** Versioned purpose in the encryption context; a new scheme gets a new label. */
export const ENV_KMS_PURPOSE = "codenaya-project-env-v1";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 2;

/** A full key ARN. Aliases are rejected because they are mutable. */
const KEY_ARN_PATTERN =
  /^arn:aws(?:-[a-z]+)*:kms:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:key\/[A-Za-z0-9-]+$/;

export interface EnvKmsKeySet {
  /** Wraps every new DEK. */
  currentArn: string;
  /** Accepted for unwrap only. */
  previousArns: readonly string[];
  credentials: { accessKeyId: string; secretAccessKey: string };
}

/** Where a value lives. Must come from the verified row, not the envelope. */
export interface EnvDestination {
  projectId: string;
  envKey: string;
}

/** The two narrow KMS operations this provider needs. */
export interface KmsClient {
  encrypt(
    input: EncryptCommandInput,
  ): Promise<Pick<EncryptCommandOutput, "KeyId" | "CiphertextBlob">>;
  decrypt(
    input: DecryptCommandInput,
  ): Promise<Pick<DecryptCommandOutput, "KeyId" | "Plaintext">>;
}

export type KmsClientFactory = (
  region: string,
  credentials: EnvKmsKeySet["credentials"],
) => KmsClient;

/** Region of a full KMS key ARN. Throws on aliases and malformed values. */
export function regionOfKeyArn(arn: string): string {
  const match = KEY_ARN_PATTERN.exec(arn);
  if (!match) {
    throw new Error(
      `"${arn}" is not a full AWS KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>).`,
    );
  }
  return match[1];
}

/** Read and validate the key set. Called per request, never at module load. */
export function readEnvKmsKeySetFromEnv(): EnvKmsKeySet {
  const currentArn = process.env.ENV_VARS_KMS_KEY_ARN?.trim();
  const accessKeyId = process.env.ENV_VARS_KMS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.ENV_VARS_KMS_SECRET_ACCESS_KEY?.trim();
  if (!currentArn || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Env var KMS is not configured: ENV_VARS_KMS_KEY_ARN, ENV_VARS_KMS_ACCESS_KEY_ID " +
        "and ENV_VARS_KMS_SECRET_ACCESS_KEY are required.",
    );
  }

  const region = regionOfKeyArn(currentArn);
  const configuredRegion = process.env.ENV_VARS_KMS_REGION?.trim();
  if (configuredRegion && configuredRegion !== region) {
    throw new Error(
      `ENV_VARS_KMS_REGION "${configuredRegion}" does not match the region of ENV_VARS_KMS_KEY_ARN "${region}".`,
    );
  }

  const previousArns = (process.env.ENV_VARS_KMS_PREVIOUS_KEY_ARNS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const arn of previousArns) {
    regionOfKeyArn(arn);
    if (arn === currentArn) {
      throw new Error(
        "ENV_VARS_KMS_PREVIOUS_KEY_ARNS contains the current key. Remove it from the previous list.",
      );
    }
  }

  return { currentArn, previousArns, credentials: { accessKeyId, secretAccessKey } };
}

/** SDK client settings: explicit credentials, bounded deadline and retries. */
export function kmsClientConfig(
  region: string,
  credentials: EnvKmsKeySet["credentials"],
): KMSClientConfig {
  return {
    region,
    // Explicit credentials so the SDK never falls back to the default chain.
    credentials,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: REQUEST_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
  };
}

const defaultKmsClient: KmsClientFactory = (region, credentials) => {
  const client = new KMSClient(kmsClientConfig(region, credentials));
  return {
    encrypt: (input) => client.send(new EncryptCommand(input)),
    decrypt: (input) => client.send(new DecryptCommand(input)),
  };
};

export type EnvKek = (destination: EnvDestination) => KekProvider;

/**
 * Bind the key set to a destination. The returned provider has the existing
 * `KekProvider` shape, with the encryption context fixed at construction.
 */
export function createAwsKmsEnvKek(
  keySet: EnvKmsKeySet,
  makeClient: KmsClientFactory = defaultKmsClient,
): EnvKek {
  const allowed = new Set([keySet.currentArn, ...keySet.previousArns]);
  // Pooling one client per region is fine; no key material is cached.
  const clients = new Map<string, KmsClient>();
  function clientFor(arn: string): KmsClient {
    const region = regionOfKeyArn(arn);
    let client = clients.get(region);
    if (!client) {
      client = makeClient(region, keySet.credentials);
      clients.set(region, client);
    }
    return client;
  }

  return ({ projectId, envKey }) => {
    if (!projectId || !envKey) {
      throw new Error("Env KMS destination needs a projectId and an envKey.");
    }
    const EncryptionContext = { projectId, envKey, purpose: ENV_KMS_PURPOSE };

    return {
      id: AWS_KMS_PROVIDER_ID,
      activeKeyId: keySet.currentArn,

      async wrapDek(dek: Buffer): Promise<string> {
        const result = await clientFor(keySet.currentArn).encrypt({
          KeyId: keySet.currentArn,
          Plaintext: dek,
          EncryptionContext,
        });
        // Persist only what the configured key actually produced.
        if (result.KeyId !== keySet.currentArn || !result.CiphertextBlob) {
          throw new Error("AWS KMS Encrypt did not return a wrap under the current key.");
        }
        return Buffer.from(result.CiphertextBlob).toString("base64");
      },

      async unwrapDek(wrappedDek: string, keyId: string): Promise<Buffer> {
        if (!allowed.has(keyId)) {
          throw new Error(
            `Env var key "${keyId}" is not in the configured KMS key set; refusing to unwrap.`,
          );
        }
        const result = await clientFor(keyId).decrypt({
          KeyId: keyId,
          CiphertextBlob: Buffer.from(wrappedDek, "base64"),
          EncryptionContext,
        });
        if (result.KeyId !== keyId || !result.Plaintext) {
          throw new Error("AWS KMS Decrypt did not return a key under the recorded ARN.");
        }
        const dek = Buffer.from(result.Plaintext);
        result.Plaintext.fill(0);
        return dek;
      },
    };
  };
}
