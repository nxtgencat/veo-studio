// Script packages (skill v5): real fixture + duplicate/update/invalid behavior.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

process.env.SQLITE_FILE = ":memory:";

import { getDb, resetDbForTests } from "../src/db.ts";
import { app } from "../src/routes.ts";

const REF = join(import.meta.dir, "..", "..", "references", "v5");
const EXAMPLE = "the-keepers-lamp.yaml";

function seedProject(id = "prj_scripts") {
  const now = new Date().toISOString();
  getDb()
    .query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run(id, "Scripts", now, now);
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function preview(pid: string, files: { filename: string; text: string }[], scriptId?: string) {
  const q = scriptId ? `?scriptId=${scriptId}` : "";
  const r = await app.request(`/projects/${pid}/scripts/preview${q}`, json({ files }));
  expect(r.status).toBe(200);
  return (await r.json()) as { files: any[] };
}

async function commit(pid: string, body: Record<string, unknown>) {
  const r = await app.request(`/projects/${pid}/scripts/commit`, json(body));
  return r;
}

beforeEach(() => {
  resetDbForTests();
  seedProject();
});

afterEach(() => {
  resetDbForTests();
});

describe("scripts", () => {
  test("commits and reads the v5 example", async () => {
    const text = await Bun.file(join(REF, EXAMPLE)).text();
    const pv = await preview("prj_scripts", [{ filename: EXAMPLE, text }]);
    expect(pv.files[0].status).toBe("new");
    expect(pv.files[0].role).toBe("single");
    const cr = await commit("prj_scripts", { files: [{ filename: EXAMPLE, text, action: "add" }] });
    expect(cr.status).toBe(200);
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    // v5 shape: shots exist with beats, calls attach by shot/pos/of.
    expect(view.entities.length).toBe(7);
    expect(view.shots.length).toBe(14);
    expect(view.calls.length).toBe(23);
    expect(view.scenes.length).toBe(5);
    expect(view.shots[0].beat.length).toBeGreaterThan(0);
    expect(view.totals).toMatchObject({ shots: 14, scenes: 5, calls: 23 });
    // Running times are cumulative and ordered.
    for (let i = 1; i < view.calls.length; i++) {
      expect(view.calls[i].startS).toBe(view.calls[i - 1].endS);
    }
    // Reverse index resolves entities to calls — exactly once each.
    expect(view.index.C1?.calls.length).toBeGreaterThan(0);
    for (const entry of Object.values(view.index) as { calls: string[] }[]) {
      expect(new Set(entry.calls).size).toBe(entry.calls.length);
    }
    // Summaries skip template scaffolding: no placeholders leak through.
    const cl2summary = view.calls.find((c: any) => c.id === "CL002").summary as string;
    expect(cl2summary).not.toContain("{{");
    expect(cl2summary).toContain("camera leaves the tower");
    // The fixture is lint-clean: no error checks.
    expect(view.checks.filter((c: any) => c.severity === "error")).toEqual([]);
  });

  test("exact duplicate and formatting-only change are skipped", async () => {
    const text = await Bun.file(join(REF, EXAMPLE)).text();
    const cr = await commit("prj_scripts", { files: [{ filename: "a.yaml", text, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const dup = await preview("prj_scripts", [{ filename: "a.yaml", text }], scriptId);
    expect(dup.files[0].status).toBe("duplicate");
    expect(dup.files[0].match.kind).toBe("exact");
    // Formatting-only change (quote style + trailing comment: same parsed
    // docs) → canonical duplicate.
    const reformatted =
      text.replaceAll(/^kind: (call|character|location|prop|shot|package_meta)$/gm, 'kind: "$1"') +
      "\n# formatting-only comment\n";
    const dup2 = await preview("prj_scripts", [{ filename: "a.yaml", text: reformatted }], scriptId);
    expect(dup2.files[0].status).toBe("duplicate");
    expect(dup2.files[0].match.kind).toBe("canonical");
  });

  test("1-character edit is an update with a field diff", async () => {
    const text = await Bun.file(join(REF, EXAMPLE)).text();
    const cr = await commit("prj_scripts", { files: [{ filename: "pkg.yaml", text, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const edited = text.replace("loose low braid", "loose low braiX");
    expect(edited).not.toBe(text);
    const pv = await preview("prj_scripts", [{ filename: "pkg.yaml", text: edited }], scriptId);
    const f = pv.files[0];
    expect(f.status).toBe("update");
    expect(f.match.shared).toBeGreaterThanOrEqual(60);
    const identityChanges = f.changes.filter((ch: any) => (ch.fields as string[]).includes("identity"));
    expect(identityChanges.map((ch: any) => ch.key)).toContain("character:C1");
    // Replace applies it.
    const cr2 = await commit("prj_scripts", {
      scriptId,
      files: [{ filename: "pkg.yaml", text: edited, action: "replace", targetFileId: f.match.fileId }],
    });
    expect(cr2.status).toBe(200);
    expect(((await cr2.json()) as any).applied.replaced).toBe(1);
  });

  test("split package with a missing bible flags it in checks", async () => {
    const full = await Bun.file(join(REF, EXAMPLE)).text();
    // Calls-only slice: every kind: call document, no bible.
    const chunks = full.split(/^[ \t]*---[ \t]*$/m);
    const callsOnly = chunks.filter((c) => /^[ \t]*kind:[ \t]*call[ \t]*$/m.test(c)).join("\n---\n");
    const pv = await preview("prj_scripts", [{ filename: "calls.yaml", text: callsOnly }]);
    expect(pv.files[0].status).toBe("new");
    expect(pv.files[0].role).toBe("calls");
    const cr = await commit("prj_scripts", { files: [{ filename: "calls.yaml", text: callsOnly, action: "add" }] });
    expect(cr.status).toBe(200);
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    expect(view.meta).toBeNull();
    expect(view.checks.some((ch: any) => ch.code === "missing_bible")).toBe(true);
  });

  test("invalid YAML is blocked with doc number and error", async () => {
    const good = await Bun.file(join(REF, EXAMPLE)).text();
    const bad = `${good}\n---\nkind: call\n  id: [unclosed\n`;
    const pv = await preview("prj_scripts", [{ filename: "bad.yaml", text: bad }]);
    expect(pv.files[0].status).toBe("invalid");
    expect(pv.files[0].error.doc).toBeGreaterThan(1);
    expect(typeof pv.files[0].error.message).toBe("string");
    const cr = await commit("prj_scripts", { files: [{ filename: "bad.yaml", text: bad, action: "add" }] });
    expect(cr.status).toBe(422);
    const errJson = (await cr.json()) as { error: { code: string; message: string } };
    expect(errJson.error.code).toBe("SCRIPT_INVALID");
    expect(errJson.error.message).toMatch(/doc \d+/);
  });

  test("raw round-trips verbatim, delete file removes the script when empty", async () => {
    const text = await Bun.file(join(REF, EXAMPLE)).text();
    const cr = await commit("prj_scripts", { files: [{ filename: "w.yaml", text, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const list = (await (await app.request("/projects/prj_scripts/scripts")).json()) as { scripts: any[] };
    const fileId = list.scripts[0].files[0].id as string;
    const raw = (await (await app.request(`/scripts/${scriptId}/raw?fileId=${fileId}`)).json()) as { text: string };
    expect(raw.text).toBe(text);
    expect((await app.request(`/scripts/${scriptId}/files/${fileId}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/scripts/${scriptId}`)).status).toBe(404);
  });

  test("checks catch risk drift, dangling chains, uncovered lines and bad totals", async () => {
    const text = await Bun.file(join(REF, EXAMPLE)).text();
    const broken = text
      .replace("chain_risk: none\ncontent_risk: none\nflags: []\nprompt: |\n  CONTINUE:", "chain_risk: monitor\ncontent_risk: none\nflags: []\nprompt: |\n  CONTINUE:")
      .replace("chained_from: CL001", "chained_from: CL999")
      .replace("dialogue: [s2.1]", "dialogue: []")
      .replace("totals: {scenes: 5, shots: 14, calls: 23}", "totals: {scenes: 5, shots: 14, calls: 99}");
    const cr = await commit("prj_scripts", { files: [{ filename: "b.yaml", text: broken, action: "add" }] });
    expect(cr.status).toBe(200);
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    const codes = (view.checks as any[]).map((ch) => ch.code);
    expect(codes).toContain("chain_risk_mismatch");
    expect(codes).toContain("dangling_chain");
    expect(codes).toContain("line_uncovered");
    expect(codes).toContain("totals_mismatch");
  });

  test("prompts render placeholders from plan, log actuals, or flag missing", async () => {
    const text = await Bun.file(join(REF, EXAMPLE)).text();
    const cr = await commit("prj_scripts", { files: [{ filename: "k.yaml", text, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    const cl2 = view.calls.find((c: any) => c.id === "CL002");
    // No log yet: planned continues_from fills the template.
    expect(cl2.renderedPrompt).not.toContain("{{continues_from}}");
    expect(cl2.renderedPrompt).toContain("Wide shot of the dark tower");
    expect(cl2.renderSource).toBe("planned");
    // CL001's prompt has no placeholders at all.
    expect(view.calls.find((c: any) => c.id === "CL001").renderSource).toBe("na");
    // A production log overrides the plan with the reconciled actual.
    const log = "kind: call_log\nid: CL002\ncontinues_from_actual: \"What the last frame really showed.\"\n";
    const cr2 = await commit("prj_scripts", { scriptId, files: [{ filename: "log.yaml", text: log, action: "add" }] });
    expect(cr2.status).toBe(200);
    const view2 = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    const cl2b = view2.calls.find((c: any) => c.id === "CL002");
    expect(cl2b.renderedPrompt).toContain("What the last frame really showed.");
    expect(cl2b.renderSource).toBe("actual");
    // Empty planned field: the placeholder survives and is flagged.
    const broken = text.replace(
      'continues_from: "Wide shot of the dark tower centred on the rocky headland, rain streaking sideways, lamp housing black, camera stopped."',
      "continues_from: null",
    );
    expect(broken).not.toBe(text);
    const cr3 = await commit("prj_scripts", { files: [{ filename: "m.yaml", text: broken, action: "add" }] });
    const { scriptId: sid3 } = (await cr3.json()) as { scriptId: string };
    const view3 = (await (await app.request(`/scripts/${sid3}`)).json()) as any;
    const cl2c = view3.calls.find((c: any) => c.id === "CL002");
    expect(cl2c.renderedPrompt).toContain("{{continues_from}}");
    expect(cl2c.renderSource).toBe("missing");
  });
});
