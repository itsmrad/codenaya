/**
 * Calls a Next.js API route as the signed-in user. Native apps have no
 * cookies, so the Clerk session token goes in the Authorization header, which
 * Clerk's middleware accepts in place of the session cookie.
 */
export const postApi = async <T>(
  path: string,
  body: unknown,
  getToken: () => Promise<string | null>,
): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string } }> => {
  const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await getToken()}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
};
