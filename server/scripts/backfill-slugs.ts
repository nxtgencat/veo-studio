// One-shot: rewrite raw project IDs (UUIDs, old p_… imports) as slugs.
// Run from server/:  bun scripts/backfill-slugs.ts [--dry-run]
// Updates projects + elements/jobs/library/project_settings in one transaction
// per project. Library/element/job IDs and inputs_json are untouched (they
// never surface in paths). Re-runnable: slug-shaped IDs are skipped.
import { getDb } from "../src/db.ts";
import { isSlug, uniqueSlug } from "../src/slug.ts";

const DRY = process.argv.includes("--dry-run");
const db = getDb();

const rows = db.query("SELECT id, name FROM projects ORDER BY created_at").all() as {
  id: string; name: string;
}[];
let renamed = 0;
for (const p of rows) {
  if (isSlug(p.id)) continue;
  const slug = uniqueSlug(p.name, (s) => !!db.query("SELECT id FROM projects WHERE id=?").get(s));
  console.log(`${p.id}  ->  ${slug}`);
  if (DRY) { renamed++; continue; }
  const tx = db.transaction(() => {
    db.query("UPDATE projects SET id=? WHERE id=?").run(slug, p.id);
    for (const t of ["elements", "jobs", "library", "project_settings"]) {
      db.query(`UPDATE ${t} SET project_id=? WHERE project_id=?`).run(slug, p.id);
    }
  });
  tx();
  renamed++;
}
console.log(DRY ? `DRY RUN — ${renamed} would rename` : `RENAMED ${renamed} projects`);
