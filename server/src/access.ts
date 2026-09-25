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

export function isAuthorized(header: string | undefined): boolean {
  if (!passwordRequired()) return true;
  return fingerprintsMatch(bearerToken(header), process.env.VEO_PASSWORD ?? "");
}
