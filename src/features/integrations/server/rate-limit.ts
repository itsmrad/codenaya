/**
 * In-memory rate limiting for integration routes.
 *
 * ## Why these routes need it
 *
 * `/api/integrations/connect` and `/api/integrations/oauth/start` both make
 * **outbound network requests** on our behalf before doing anything else — an MCP
 * handshake, or OAuth discovery plus dynamic client registration. That makes them
 * more abusable than an ordinary endpoint:
 *
 * - A loop against `connect` with a custom server URL turns Codenaya into a request
 *   amplifier pointed wherever the caller likes. The SSRF guard restricts *where*,
 *   but not *how often*.
 * - Repeated `oauth/start` calls register a fresh OAuth client with the provider
 *   each time, which is both slow and something a provider may throttle or flag
 *   against our account rather than the user's.
 * - Each attempt writes a row, so an unthrottled loop also consumes the Convex free
 *   tier's storage and function-call budget.
 *
 * ## Honest limitations
 *
 * This is per-instance memory, so it does not coordinate across serverless
 * instances: with N concurrent instances the effective limit is N times the
 * configured one. It is also reset by a cold start.
 *
 * That is a deliberate trade. A correct distributed limiter needs shared state, and
 * the obvious store here is Convex — which would mean adding writes to the exact
 * path we are trying to protect from excess writes. The purpose is to stop runaway
 * loops and accidental retry storms, not to withstand a determined distributed
 * attacker. If that becomes the threat, this should move behind a real gateway
 * limiter rather than grow more clever here.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Keyed by `${scope}:${userId}` — per user, not per IP.
 *
 * Both protected routes require a Clerk session, so a user id is available and is a
 * far better key than an IP: it is not shared by everyone behind a NAT and cannot be
 * rotated by the caller.
 */
const buckets = new Map<string, Bucket>();

/**
 * Bound on distinct keys held.
 *
 * Without it the map grows with every user who ever hits these routes and never
 * shrinks — a slow leak in a long-lived server process.
 */
const MAX_BUCKETS = 10_000;

export interface RateLimitConfig {
  /** Distinguishes independent limits, e.g. "connect" vs "oauth-start". */
  scope: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window resets. For a `Retry-After` header. */
  retryAfterSeconds: number;
}

/**
 * Drop expired buckets, and if still over the cap, the ones expiring soonest.
 *
 * Evicting soonest-expiring first means the keys discarded are the ones closest to
 * being reset anyway, so eviction gives away the least enforcement.
 */
function evictIfNeeded(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  if (buckets.size < MAX_BUCKETS) return;

  const sorted = [...buckets.entries()].sort(
    (a, b) => a[1].resetAt - b[1].resetAt,
  );
  for (const [key] of sorted.slice(0, Math.ceil(MAX_BUCKETS / 10))) {
    buckets.delete(key);
  }
}

/**
 * Record an attempt and report whether it is allowed.
 *
 * Counts the attempt even when denied, so a caller hammering the endpoint does not
 * keep the window rolling open — it stays closed until the window genuinely elapses.
 */
export function checkRateLimit(
  userId: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();
  const key = `${config.scope}:${userId}`;

  evictIfNeeded(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + config.windowMs });
    return {
      allowed: true,
      remaining: config.limit - 1,
      retryAfterSeconds: Math.ceil(config.windowMs / 1000),
    };
  }

  existing.count += 1;

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((existing.resetAt - now) / 1000),
  );

  if (existing.count > config.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return {
    allowed: true,
    remaining: config.limit - existing.count,
    retryAfterSeconds,
  };
}

/** Reset all state. For tests. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Creating a connection probes a remote MCP server, so this is the tighter limit.
 * Ten per minute is far above normal use — a person adds a connection every few
 * minutes at most — while stopping a scripted loop.
 */
export const CONNECT_RATE_LIMIT: RateLimitConfig = {
  scope: "integrations-connect",
  limit: 10,
  windowMs: 60_000,
};

/**
 * Starting OAuth performs discovery and dynamic client registration against the
 * provider. Slightly tighter, because each attempt creates a client registration on
 * their side.
 */
export const OAUTH_START_RATE_LIMIT: RateLimitConfig = {
  scope: "integrations-oauth-start",
  limit: 8,
  windowMs: 60_000,
};

/** Standard 429 response with a `Retry-After` header. */
export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    {
      ok: false,
      error: `Too many requests. Try again in ${result.retryAfterSeconds} second(s).`,
    },
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    },
  );
}
