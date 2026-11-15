/**
 * Community servers get no trust of their own: a remote entry is connected as
 * an ordinary custom server, so every tool it lists, including ones that claim
 * `readOnlyHint: true`, goes through the approval gate. The runtime half of
 * that gate (refusal, missing gate, approval) is exercised over the protocol by
 * the "custom servers are untrusted" cases in approval-policy.test.ts.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getProvider } from "../../catalog";
import catalogJson from "../../community-catalog.json";
import { isRemoteCapable, toCustomServerPrefill, type CommunityServer } from "../../community-catalog";
import { CUSTOM_PROVIDER_ID } from "../../components/provider-catalog";
import { clearDekCache, getSecretSealer, resetSecretSealer, secretContext } from "../crypto";
import { requiresApproval } from "./discover-tools";
import { resolveMcpServers, type ConnectionRecord } from "./resolve-servers";

const remote = (catalogJson as CommunityServer[]).filter(isRemoteCapable);

beforeEach(() => {
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
  vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
  resetSecretSealer();
  clearDekCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretSealer();
});

/** The row the connect route stores for a custom server, with a real sealed key. */
async function storedCustomConnection(label: string, serverUrl: string): Promise<ConnectionRecord> {
  const credentialRef = "community_ref";
  const sealed = await getSecretSealer().seal(
    JSON.stringify({ type: "api_key", apiKey: "community_key_1234567890" }),
    secretContext("userConnections", credentialRef, "credential"),
  );
  return {
    _id: "conn_community", providerId: CUSTOM_PROVIDER_ID, label, authMode: "api_key", serverUrl, credentialRef, ...sealed,
  } as ConnectionRecord;
}

const TOOLS = [
  { name: "list_things", annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "list_things_again", annotations: { readOnlyHint: true } },
  { name: "unannotated" },
];

describe("community remote servers", () => {
  it("are present and none of them is a vetted provider", () => {
    expect(remote.length).toBeGreaterThan(0);
    for (const server of remote) expect(getProvider(server.id)).toBeUndefined();
  });

  it.each(remote.map((server) => [server.id, server] as const))(
    "%s connects through the custom path and every tool needs approval",
    async (_id, server) => {
      const prefill = toCustomServerPrefill(server);
      expect(prefill).toEqual({ label: server.name.slice(0, 80), serverUrl: server.remoteUrl });

      const connection = await storedCustomConnection(prefill!.label, prefill!.serverUrl);
      const { servers, problems } = await resolveMcpServers([{
        link: { _id: "link_community", readOnly: true, providerScope: {}, writeApproved: false },
        connection,
      }]);

      expect(problems).toEqual([]);
      expect(servers[0]).toMatchObject({
        providerId: CUSTOM_PROVIDER_ID,
        url: server.remoteUrl,
        trustedHostnames: [],
        destructiveTools: [],
        readOnlyTools: [],
        annotationsTrusted: false,
        readOnlyEnforced: false,
      });
      for (const tool of TOOLS) expect(requiresApproval(servers[0], tool), tool.name).toBe(true);
    },
  );
});
