// Human-friendly project IDs: slug-from-name + short random suffix.
// The slug IS the primary key (stable for life — renames never change it),
// so every existing lookup, URL param, and localStorage key keeps working.

function slugify(name: string): string {
  const s = (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return s || "project";
}

const SUFFIX = "0123456789abcdefghijklmnopqrstuvwxyz";

function suffix(): string {
  let s = "";
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  for (const b of buf) s += SUFFIX[b % SUFFIX.length];
  return s;
}

/** e.g. "mythic-thriller-k7q2". Retries on collision (taken hits the DB). */
export function uniqueSlug(name: string, taken: (slug: string) => boolean): string {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const s = `${base}-${suffix()}`;
    if (!taken(s)) return s;
  }
  // Practically unreachable — timestamp fallback guarantees termination.
  return `${base}-${Date.now().toString(36)}`;
}

/** True when an id is already user-friendly (backfill skips these). */
export function isSlug(id: string): boolean {
  // UUIDs are hex+hyphens (slug-shaped but raw) — never treat them as done.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length <= 48;
}
