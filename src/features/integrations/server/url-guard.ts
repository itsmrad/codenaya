/**
 * SSRF protection for user-supplied MCP server URLs.
 *
 * ## Why this exists
 *
 * Users can register custom MCP servers by URL. Codenia's *server* is what
 * opens that connection, so a hostile URL borrows our network position and our
 * outbound credentials. The canonical attack is the cloud metadata endpoint:
 *
 *     http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *
 * A naive fetch of that URL from a hosting provider can return live IAM
 * credentials. Private-range addresses (`10.0.0.0/8`, `192.168.0.0/16`) are
 * equally dangerous: they reach internal services that assume network-level
 * trust.
 *
 * Every user-supplied URL must pass `assertSafeMcpUrl` before any request is
 * made to it.
 *
 * ## Residual risk: DNS rebinding (TOCTOU)
 *
 * We resolve the hostname and validate the resulting addresses, but the
 * subsequent `fetch` performs its own lookup. A DNS server that returns a
 * public address on the first query and `169.254.169.254` on the second can
 * slip past a one-time check. Narrowing this properly requires pinning the
 * validated address at connection time via a custom `undici` lookup hook,
 * which belongs with the code that constructs the MCP transport. Until then we
 * re-validate immediately before every call rather than caching a verdict,
 * which shrinks but does not eliminate the window.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

interface Cidr {
  family: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
  label: string;
}

interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array;
}

/**
 * IPv4 ranges that must never be reachable from a user-supplied URL.
 * Sourced from the IANA IPv4 Special-Purpose Address Registry.
 */
const BLOCKED_IPV4: ReadonlyArray<[string, string]> = [
  ["0.0.0.0/8", "current network"],
  ["10.0.0.0/8", "private network"],
  ["100.64.0.0/10", "carrier-grade NAT"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local (cloud metadata)"],
  ["172.16.0.0/12", "private network"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.0.2.0/24", "documentation range"],
  ["192.88.99.0/24", "6to4 relay anycast"],
  ["192.168.0.0/16", "private network"],
  ["198.18.0.0/15", "benchmarking range"],
  ["198.51.100.0/24", "documentation range"],
  ["203.0.113.0/24", "documentation range"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved"],
];

/**
 * IPv6 ranges that must never be reachable.
 *
 * Note that `::ffff:0:0/96` (IPv4-mapped) is deliberately absent: such
 * addresses are normalised down to IPv4 during parsing so the IPv4 rules above
 * apply. Without that normalisation, `::ffff:169.254.169.254` would bypass the
 * link-local block entirely — a well-known filter evasion.
 */
const BLOCKED_IPV6: ReadonlyArray<[string, string]> = [
  ["::/128", "unspecified address"],
  ["::1/128", "loopback"],
  ["64:ff9b::/96", "NAT64 translation"],
  ["100::/64", "discard-only range"],
  ["2001:db8::/32", "documentation range"],
  ["fc00::/7", "unique local address"],
  ["fe80::/10", "link-local"],
  ["ff00::/8", "multicast"],
];

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    // Reject empty, non-numeric, and zero-padded octets. Padding matters:
    // some resolvers read a leading zero as octal, so "0177.0.0.1" and
    // "127.0.0.1" can denote the same host while comparing as different
    // strings.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  let head = value;
  let embeddedIpv4: Uint8Array | null = null;

  // An IPv6 address may end with dotted-quad notation, e.g. "::ffff:127.0.0.1".
  const lastColon = head.lastIndexOf(":");
  const tail = head.slice(lastColon + 1);
  if (tail.includes(".")) {
    embeddedIpv4 = parseIpv4(tail);
    if (!embeddedIpv4) return null;
    head = head.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColonCount = (head.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let groups: string[];
  if (doubleColonCount === 1) {
    const [left, right] = head.split("::");
    const leftGroups = left === "" ? [] : left.split(":");
    const rightGroups = right === "" ? [] : right.split(":");
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    groups = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    groups = head.split(":");
  }

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const n = Number.parseInt(group, 16);
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }

  if (embeddedIpv4) {
    bytes[12] = embeddedIpv4[0];
    bytes[13] = embeddedIpv4[1];
    bytes[14] = embeddedIpv4[2];
    bytes[15] = embeddedIpv4[3];
  }

  return bytes;
}

/** True when a 16-byte IPv6 address is an IPv4-mapped address (`::ffff:a.b.c.d`). */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Parse an IP literal into bytes.
 *
 * IPv4-mapped IPv6 addresses are folded down to their 4-byte IPv4 form so that
 * IPv4 blocklist rules apply to them.
 */
export function parseIp(value: string): ParsedIp | null {
  const trimmed = value.trim().replace(/^\[|\]$/g, "");

  if (trimmed.includes(":")) {
    const bytes = parseIpv6(trimmed);
    if (!bytes) return null;
    if (isIpv4Mapped(bytes)) {
      return { family: 4, bytes: bytes.slice(12, 16) };
    }
    return { family: 6, bytes };
  }

  const bytes = parseIpv4(trimmed);
  return bytes ? { family: 4, bytes } : null;
}

function parseCidr(cidr: string, label: string): Cidr {
  const [address, prefixText] = cidr.split("/");
  const parsed = parseIp(address);
  if (!parsed) {
    throw new Error(`Invalid CIDR in blocklist: ${cidr}`);
  }
  return {
    family: parsed.family,
    bytes: parsed.bytes,
    prefix: Number(prefixText),
    label,
  };
}

const BLOCKLIST: ReadonlyArray<Cidr> = [
  ...BLOCKED_IPV4.map(([cidr, label]) => parseCidr(cidr, label)),
  ...BLOCKED_IPV6.map(([cidr, label]) => parseCidr(cidr, label)),
];

function withinCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.family !== cidr.family) return false;

  const fullBytes = Math.floor(cidr.prefix / 8);
  const remainingBits = cidr.prefix % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (ip.bytes[i] !== cidr.bytes[i]) return false;
  }

  if (remainingBits > 0) {
    const mask = (0xff << (8 - remainingBits)) & 0xff;
    if ((ip.bytes[fullBytes] & mask) !== (cidr.bytes[fullBytes] & mask)) {
      return false;
    }
  }

  return true;
}

/**
 * Check a single IP address against the blocklist.
 *
 * Exported so it can be unit-tested exhaustively without DNS, and reused at
 * connection time once transport-level address pinning lands.
 */
export function checkIp(value: string): { blocked: boolean; reason?: string } {
  const parsed = parseIp(value);
  if (!parsed) {
    return { blocked: true, reason: `unparseable IP address: ${value}` };
  }

  for (const cidr of BLOCKLIST) {
    if (withinCidr(parsed, cidr)) {
      return { blocked: true, reason: `${cidr.label} address is not allowed` };
    }
  }

  return { blocked: false };
}

/**
 * Insecure (`http:`) MCP URLs are permitted only outside production and only
 * when explicitly opted into. Gating on NODE_ENV as well as the flag means a
 * stray environment variable in production cannot widen the guard.
 */
function allowsInsecureScheme(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.CODENAYA_ALLOW_INSECURE_MCP_URLS === "1"
  );
}

export interface AssertSafeMcpUrlOptions {
  /**
   * Hostnames from the curated provider catalog. These are operator-controlled
   * rather than user-supplied, so they skip DNS validation — we already trust
   * `mcp.supabase.com` to resolve wherever Supabase points it, and resolving it
   * ourselves would only add a failure mode.
   */
  trustedHosts?: readonly string[];
}

/**
 * Validate a user-supplied MCP server URL.
 *
 * Returns a discriminated result rather than throwing, because every caller
 * needs to surface the reason to the user or the model instead of producing a
 * 500.
 */
export async function assertSafeMcpUrl(
  raw: string,
  options: AssertSafeMcpUrlOptions = {},
): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }

  if (url.protocol !== "https:") {
    if (url.protocol === "http:" && allowsInsecureScheme()) {
      // Permitted for local development only.
    } else {
      return {
        ok: false,
        reason: "MCP server URLs must use https.",
      };
    }
  }

  // Embedded credentials are a redirect-laundering trick and are never needed
  // for MCP, which authenticates via headers.
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "URLs must not embed credentials. Use an API key or OAuth instead.",
    };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "") {
    return { ok: false, reason: "URL is missing a hostname." };
  }

  if (options.trustedHosts?.includes(url.hostname)) {
    return { ok: true, url };
  }

  // A literal IP needs no lookup; check it directly.
  if (isIP(hostname) !== 0) {
    const verdict = checkIp(hostname);
    return verdict.blocked
      ? { ok: false, reason: `Blocked: ${verdict.reason}` }
      : { ok: true, url };
  }

  // Reject hostnames that resolve only inside a private network.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "Blocked: loopback hostname is not allowed." };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return {
      ok: false,
      reason: `Could not resolve host "${hostname}".`,
    };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `Host "${hostname}" resolved to no addresses.` };
  }

  // Every resolved address must be safe. A single private answer among public
  // ones is enough to reject: we cannot control which one `fetch` picks.
  for (const { address } of addresses) {
    const verdict = checkIp(address);
    if (verdict.blocked) {
      return {
        ok: false,
        reason: `Blocked: "${hostname}" resolves to a ${verdict.reason}`,
      };
    }
  }

  return { ok: true, url };
}
