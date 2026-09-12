import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { nanoid } from "nanoid";

import { getProvider } from "../../catalog";
import { maskCredential } from "../../env-keys";
import { getSecretSealer, secretContext } from "../crypto";
import { refreshOAuthTokens, tokenExpiryFrom } from "./flow";

export const OAUTH_REFRESH_SKEW_MS = 60_000;
const OAUTH_REFRESH_LEASE_MS = 2 * 60_000;

interface StoredOAuthCredential {
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  clientInformation?: OAuthClientInformationFull;
  authorizationServerMetadata?: AuthorizationServerMetadata;
}

export interface RefreshableConnection {
  _id: string;
  providerId: string;
  label: string;
  authMode: "oauth" | "api_key";
  credentialRef: string;
  kekProvider: string;
  kekKeyId: string;
  wrappedDek: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  scopes: string[];
  tokenExpiresAt?: number;
  authServerUrl?: string;
}

type RefreshClaim = "acquired" | "busy" | "not_needed" | "missing";

interface SealedCredential {
  kekProvider: string;
  kekKeyId: string;
  wrappedDek: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface OAuthRefreshDependencies {
  claim(args: {
    connectionId: string;
    leaseId: string;
    refreshSkewMs: number;
    leaseDurationMs: number;
  }): Promise<RefreshClaim>;
  complete(args: {
    connectionId: string;
    leaseId: string;
    maskedPreview: string;
    scopes: string[];
    tokenExpiresAt: number | null;
    sealed: SealedCredential;
  }): Promise<boolean>;
  fail(args: {
    connectionId: string;
    leaseId: string;
    reauthRequired: boolean;
  }): Promise<boolean>;
}

export interface OAuthRefreshReport {
  refreshedConnectionIds: string[];
  warnings: string[];
}

/** OAuth errors that cannot succeed on retry without a new authorization. */
export function refreshFailureNeedsReauth(error: string): boolean {
  return /\b(?:invalid_grant|invalid_client|unauthorized|access_denied|401)\b/i.test(
    error,
  );
}

export function oauthConnectionNeedsRefresh(
  connection: Pick<RefreshableConnection, "authMode" | "tokenExpiresAt">,
  now = Date.now(),
): boolean {
  return (
    connection.authMode === "oauth" &&
    typeof connection.tokenExpiresAt === "number" &&
    connection.tokenExpiresAt - OAUTH_REFRESH_SKEW_MS <= now
  );
}

/**
 * Refresh every expired OAuth credential before MCP discovery.
 *
 * Plaintext tokens exist only in this server-side function. Its return value and
 * warnings contain identifiers and status text only, so workflow checkpoints,
 * logs, and the model never receive a credential.
 */
export async function refreshExpiredOAuthConnections(
  connections: readonly RefreshableConnection[],
  dependencies: OAuthRefreshDependencies,
): Promise<OAuthRefreshReport> {
  const refreshedConnectionIds: string[] = [];
  const warnings: string[] = [];
  const now = Date.now();

  for (const connection of connections) {
    if (!oauthConnectionNeedsRefresh(connection, now)) continue;

    const leaseId = nanoid();
    const claim = await dependencies.claim({
      connectionId: connection._id,
      leaseId,
      refreshSkewMs: OAUTH_REFRESH_SKEW_MS,
      leaseDurationMs: OAUTH_REFRESH_LEASE_MS,
    });

    if (claim === "not_needed") continue;
    if (claim === "missing") {
      warnings.push(`${connection.label}: the saved connection no longer exists.`);
      continue;
    }
    if (claim === "busy") {
      warnings.push(
        `${connection.label}: OAuth is already being refreshed by another run. ` +
          "Retry this request shortly.",
      );
      continue;
    }

    const fail = async (reauthRequired: boolean, warning: string) => {
      await dependencies.fail({
        connectionId: connection._id,
        leaseId,
        reauthRequired,
      });
      warnings.push(`${connection.label}: ${warning}`);
    };

    const provider = getProvider(connection.providerId);
    if (!provider || !connection.authServerUrl) {
      await fail(true, "OAuth metadata is incomplete. Reconnect this integration.");
      continue;
    }

    let credential: StoredOAuthCredential;
    try {
      const opened = await getSecretSealer().open(
        {
          kekProvider: connection.kekProvider,
          kekKeyId: connection.kekKeyId,
          wrappedDek: connection.wrappedDek,
          ciphertext: connection.ciphertext,
          iv: connection.iv,
          authTag: connection.authTag,
        },
        secretContext(
          "userConnections",
          connection.credentialRef,
          "credential",
        ),
      );
      credential = JSON.parse(opened) as StoredOAuthCredential;
    } catch {
      await fail(true, "The saved authorization cannot be opened. Reconnect it.");
      continue;
    }

    if (
      credential.type !== "oauth" ||
      !credential.refreshToken ||
      !credential.clientInformation
    ) {
      await fail(true, "The authorization cannot be refreshed. Reconnect it.");
      continue;
    }

    const refreshed = await refreshOAuthTokens({
      provider,
      authorizationServerUrl: connection.authServerUrl,
      authorizationServerMetadata: credential.authorizationServerMetadata,
      refreshToken: credential.refreshToken,
      clientInformation: credential.clientInformation,
    });

    if (!refreshed.ok) {
      const reauthRequired = refreshFailureNeedsReauth(refreshed.error);
      await fail(
        reauthRequired,
        reauthRequired
          ? "OAuth authorization expired. Reconnect this integration."
          : "OAuth refresh temporarily failed and will be retried.",
      );
      continue;
    }

    const { tokens } = refreshed;
    const nextCredential: StoredOAuthCredential = {
      ...credential,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? credential.refreshToken,
      tokenType: tokens.token_type ?? credential.tokenType,
    };

    let sealed: SealedCredential;
    try {
      sealed = await getSecretSealer().seal(
        JSON.stringify(nextCredential),
        secretContext(
          "userConnections",
          connection.credentialRef,
          "credential",
        ),
      );
    } catch {
      await fail(false, "The refreshed authorization could not be stored safely.");
      continue;
    }

    const committed = await dependencies.complete({
      connectionId: connection._id,
      leaseId,
      maskedPreview: maskCredential(tokens.access_token),
      scopes: tokens.scope
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : connection.scopes,
      tokenExpiresAt: tokenExpiryFrom(tokens) ?? null,
      sealed,
    });

    if (!committed) {
      warnings.push(
        `${connection.label}: OAuth was refreshed by another run. Retry this request shortly.`,
      );
      continue;
    }

    refreshedConnectionIds.push(connection._id);
  }

  return { refreshedConnectionIds, warnings };
}
