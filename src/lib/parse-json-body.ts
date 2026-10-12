import { NextResponse } from "next/server";
import { type ZodType, type z } from "zod";

export type ParseJsonBodyResult<T> =
  | {
      success: true;
      ok: true;
      data: T;
      errorResponse: undefined;
      response: undefined;
    }
  | {
      success: false;
      ok: false;
      data: undefined;
      errorResponse: NextResponse;
      response: NextResponse;
    };

/**
 * Safely parses the JSON body of an incoming request and validates it against a Zod schema.
 * Returns either `{ success: true, ok: true, data }` or `{ success: false, ok: false, errorResponse, response }` with a 400 Bad Request status.
 */
export async function parseJsonBody<T extends ZodType>(
  request: Request,
  schema: T
): Promise<ParseJsonBodyResult<z.infer<T>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const errorResponse = NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
    return {
      success: false,
      ok: false,
      data: undefined,
      errorResponse,
      response: errorResponse,
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const errorResponse = NextResponse.json(
      {
        error: "Invalid request payload",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
    return {
      success: false,
      ok: false,
      data: undefined,
      errorResponse,
      response: errorResponse,
    };
  }

  return {
    success: true,
    ok: true,
    data: parsed.data,
    errorResponse: undefined,
    response: undefined,
  };
}
