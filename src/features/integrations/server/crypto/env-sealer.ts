/**
 * Sealer for project environment variables under AWS KMS.
 *
 * Unlike `getSecretSealer()` it keeps NO DEK or plaintext cache: every `open`
 * unwraps through KMS, so a KMS outage or a revoked key takes effect on the
 * next read. It reuses the same AES-256-GCM envelope and `secretContext` AAD.
 *
 * Versioned reader: `kekProvider` on the row picks the path.
 * - `aws-kms`: the key-set provider bound to the row's destination.
 * - anything else: the legacy provider configured by `CODENAYA_KEK_PROVIDER`,
 *   so rows sealed before the move still open.
 * New writes always use AWS KMS. If its config is missing, `seal` and AWS
 * reads throw; they never fall back to the legacy key.
 *
 * Not wired into any route yet: the env-vars route and sandbox boot still use
 * the legacy path until the activation stage switches them over.
 */

import { decryptWithDek, encryptWithDek, generateDek } from "./envelope";
import { createKekProvider, resolveKekProviderId } from "./index";
import {
  AWS_KMS_PROVIDER_ID,
  createAwsKmsEnvKek,
  type EnvDestination,
  type EnvKek,
  readEnvKmsKeySetFromEnv,
} from "./kek/aws-kms";
import { secretContext, type KekProvider, type SealedSecret } from "./types";

export type { EnvDestination } from "./kek/aws-kms";

export interface EnvSealer {
  seal(value: string, secretRef: string, destination: EnvDestination): Promise<SealedSecret>;
  open(sealed: SealedSecret, secretRef: string, destination: EnvDestination): Promise<string>;
}

export interface EnvSealerDeps {
  /** Defaults to the key set read from host env. */
  kms?: () => EnvKek;
  /** Defaults to the provider `CODENAYA_KEK_PROVIDER` selects. */
  legacy?: () => KekProvider;
}

const envAad = (secretRef: string) => secretContext("projectEnvVars", secretRef, "value");

/**
 * Build one per request. Config is read lazily, so a manifest of only legacy
 * rows opens without AWS config.
 */
export function createEnvSealer(deps: EnvSealerDeps = {}): EnvSealer {
  let kms: EnvKek | undefined;
  let legacy: KekProvider | undefined;
  const kmsFor = (destination: EnvDestination) =>
    (kms ??= (deps.kms ?? (() => createAwsKmsEnvKek(readEnvKmsKeySetFromEnv())))())(
      destination,
    );

  return {
    async seal(value, secretRef, destination) {
      const provider = kmsFor(destination);
      const dek = generateDek();
      try {
        const wrappedDek = await provider.wrapDek(dek);
        return {
          kekProvider: provider.id,
          kekKeyId: provider.activeKeyId,
          wrappedDek,
          ...encryptWithDek(value, dek, envAad(secretRef)),
        };
      } finally {
        dek.fill(0);
      }
    },

    async open(sealed, secretRef, destination) {
      let provider: KekProvider;
      if (sealed.kekProvider === AWS_KMS_PROVIDER_ID) {
        provider = kmsFor(destination);
      } else {
        provider = legacy ??= (deps.legacy ?? (() => createKekProvider(resolveKekProviderId())))();
        if (sealed.kekProvider !== provider.id) {
          throw new Error(
            `Env var was sealed with KEK provider "${sealed.kekProvider}" but "${provider.id}" is configured.`,
          );
        }
      }

      const dek = await provider.unwrapDek(sealed.wrappedDek, sealed.kekKeyId);
      try {
        return decryptWithDek(sealed, dek, envAad(secretRef));
      } finally {
        dek.fill(0);
      }
    },
  };
}
