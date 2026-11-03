import { z } from "zod";
import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/server/require-user-id";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";
import { scanStoredProject } from "@/features/security/server/scan-stored-project";
import { parseJsonBody } from "@/lib/parse-json-body";
import {
  SECURITY_SCAN_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/lib/rate-limit";

const requestSchema = z.object({ projectId: z.string().min(1) });

/**
 * POST /api/projects/security-scan
 *
 * Checks a project for secrets before it leaves Codenaya (#300). Returns
 * `{ findings }` with file, line and rule only, never the matched values.
 */
export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;

  const rateLimit = checkRateLimit(userId, SECURITY_SCAN_RATE_LIMIT);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const { data, invalid } = await parseJsonBody(request, requestSchema);
  if (invalid) return invalid;

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { found: project, notFound } = await requireOwnedProject({
    internalKey,
    userId,
    projectId: data.projectId,
  });
  if (notFound) return notFound;

  return NextResponse.json({
    findings: await scanStoredProject(internalKey, project._id),
  });
}
