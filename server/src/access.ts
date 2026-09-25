import { createHash, timingSafeEqual } from "node:crypto";

// Optional shared-secret gate for the whole API. Set VEO_PASSWORD and every
// route except /health (container probes) and /auth/status (lets the UI
// prompt) requires `Authorization: Bearer <password>`. Unset = open.
export function passwordRequired(): boolean {
  return (process.env.VEO_PASSWORD ?? "") !== "";
}

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/** SHA-256 first so comparison cost never leaks password length. */
function fingerprintsMatch(got: string, want: string): boolean {
  if (!got || !want) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

export function isTokenValid(token: string): boolean {
  if (!passwordRequired()) return true;
  return fingerprintsMatch(token, process.env.VEO_PASSWORD ?? "");
}

export function isAuthorized(header: string | undefined): boolean {
  if (!passwordRequired()) return true;
  return isTokenValid(bearerToken(header));
}

/**
 * Media fallback: <video>/<img> tags can't send Authorization headers, so
 * GET /media/:id also accepts ?token=<password>. Same secret, same check —
 * just a different transport for browser-native media fetches (incl. Range).
 * Only used for media; every other route stays header-only.
 */
export function isAuthorizedMedia(header: string | undefined, queryToken: string): boolean {
  if (!passwordRequired()) return true;
  if (fingerprintsMatch(bearerToken(header), process.env.VEO_PASSWORD ?? "")) return true;
  return isTokenValid(queryToken);
}
