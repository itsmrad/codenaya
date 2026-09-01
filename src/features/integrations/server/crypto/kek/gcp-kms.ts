/**
 * Google Cloud KMS KEK provider.
 *
 * ## Why this exists now, unused
 *
 * The platform ships with the `local` provider so it runs at zero cost. This
 * module is the paid-for upgrade path, written up front so the swap is a config
 * change plus a background re-wrap rather than a design exercise under pressure.
 * `scripts/rewrap-deks.ts` performs the migration.
 *
 * ## Why REST instead of `@google-cloud/kms`
 *
 * `google-auth-library` is already a dependency (see
 * `src/features/conversations/workflow/lib/vertex-model.ts`) and the KMS
 * encrypt/decrypt surface is two endpoints. Using it directly avoids adding the
 * full Cloud client library — and its gRPC dependency tree — for two calls.
 * Credentials are the same service-account pair already used for Vertex AI, so
 * enabling this requires one extra IAM role and no new secret.
 *
 * ## Cost
 *
 * One key version bills at roughly $0.06/month, plus $0.03 per 10,000
 * cryptographic operations. Because the DEK cache in `../index.ts` means a
 * credential is unwrapped once per cache window rather than once per read,
 * realistic traffic costs pennies.
 */

import { GoogleAuth } from "google-auth-library";

import type { KekProvider } from "../types";

export const GCP_KMS_PROVIDER_ID = "gcp-kms";

const KMS_ENDPOINT = "https://cloudkms.googleapis.com/v1";
const KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";

/** Matches `projects/p/locations/l/keyRings/r/cryptoKeys/k`. */
const KEY_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

/**
 * Binds a wrapped DEK to its purpose, matching the local provider so the two
 * are behaviourally equivalent from the caller's perspective.
 */
const DEK_WRAP_AAD = "codenaya:v1:dek-wrap";

export interface GcpKmsConfig {
  /** Full crypto key resource name. */
  keyName: string;
  clientEmail: string;
  privateKey: string;
}

export function readGcpKmsConfigFromEnv(): GcpKmsConfig {
  const keyName = process.env.CODENAYA_GCP_KMS_KEY;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;

  if (!keyName) {
    throw new Error(
      "CODENAYA_GCP_KMS_KEY is not set. Expected " +
        "projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>",
    );
  }
  if (!KEY_NAME_PATTERN.test(keyName)) {
    throw new Error(
      `CODENAYA_GCP_KMS_KEY is not a valid crypto key resource name: "${keyName}". ` +
        "It must reference the key itself, not a key version.",
    );
  }
  if (!clientEmail) {
    throw new Error("GOOGLE_CLIENT_EMAIL is not configured.");
  }
  if (!privateKeyRaw) {
    throw new Error("GOOGLE_PRIVATE_KEY is not configured.");
  }

  return {
    keyName,
    clientEmail,
    // Env-provided keys usually carry literal "\n" rather than real newlines,
    // the same normalisation vertex-model.ts performs.
    privateKey: privateKeyRaw.replace(/\\n/g, "\n"),
  };
}

interface EncryptResponse {
  ciphertext?: string;
}

interface DecryptResponse {
  plaintext?: string;
}

export function createGcpKmsProvider(config: GcpKmsConfig): KekProvider {
  const auth = new GoogleAuth({
    scopes: [KMS_SCOPE],
    credentials: {
      client_email: config.clientEmail,
      private_key: config.privateKey,
    },
  });

  async function callKms<T>(
    keyName: string,
    action: "encrypt" | "decrypt",
    body: Record<string, string>,
  ): Promise<T> {
    // GoogleAuth caches and refreshes tokens internally, so requesting a client
    // per call is cheap and avoids holding a token past its expiry.
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) {
      throw new Error("Could not obtain a Google access token for Cloud KMS.");
    }

    const response = await fetch(`${KMS_ENDPOINT}/${keyName}:${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // The response body carries the actual reason (missing IAM role, disabled
      // key, wrong location). Surfacing it turns an opaque 403 into something
      // an operator can act on. It contains no key material.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Cloud KMS ${action} failed with ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    return (await response.json()) as T;
  }

  return {
    id: GCP_KMS_PROVIDER_ID,

    /**
     * The crypto key name, not a version. Cloud KMS selects the correct version
     * for decryption automatically, so rotating the key inside GCP needs no
     * change here and no re-wrap.
     */
    activeKeyId: config.keyName,

    async wrapDek(dek: Buffer): Promise<string> {
      const result = await callKms<EncryptResponse>(config.keyName, "encrypt", {
        plaintext: dek.toString("base64"),
        additionalAuthenticatedData: Buffer.from(DEK_WRAP_AAD, "utf8").toString(
          "base64",
        ),
      });

      if (!result.ciphertext) {
        throw new Error("Cloud KMS encrypt returned no ciphertext.");
      }
      return result.ciphertext;
    },

    async unwrapDek(wrappedDek: string, keyId: string): Promise<Buffer> {
      // Decrypt against the key recorded on the row rather than the currently
      // configured one. If the configured key is later repointed, existing rows
      // must still resolve through the key that sealed them.
      if (!KEY_NAME_PATTERN.test(keyId)) {
        throw new Error(
          `Stored kekKeyId is not a valid Cloud KMS key name: "${keyId}".`,
        );
      }

      const result = await callKms<DecryptResponse>(keyId, "decrypt", {
        ciphertext: wrappedDek,
        additionalAuthenticatedData: Buffer.from(DEK_WRAP_AAD, "utf8").toString(
          "base64",
        ),
      });

      if (!result.plaintext) {
        throw new Error("Cloud KMS decrypt returned no plaintext.");
      }
      return Buffer.from(result.plaintext, "base64");
    },
  };
}
