/**
 * Request checks shared by write routes that act for a signed-in user.
 * A cross-site page can't make the browser send either: `Origin` names the
 * calling page, and `Sec-Fetch-Site` is set by the browser alone.
 */
export const isSameOrigin = (request: Request) =>
  request.headers.get("origin") === new URL(request.url).origin ||
  request.headers.get("sec-fetch-site") === "same-origin";

export const isJson = (request: Request) =>
  request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
