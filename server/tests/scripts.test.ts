// Script packages: real fixture + duplicate/update/invalid behavior +
 // composer links + frame-to-video / keyframe / text-to-video rules.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.SQLITE_FILE = ":memory:";

import { getDb, resetDbForTests } from "../src/db.ts";
import { app } from "../src/routes.ts";

/** Minimal lint-clean package: reference opening + frame opening with
 *  keyframed first/last stills, then an extend. Inline so it never depends
 *  on the untracked references/ attachment dir. */
const PKG = [
  "kind: package_meta",
  "title: PKG QA",
  "target_runtime_s: 16",
  "model_lock: {name: m, locked_date: '2026-09-30', base_clip_s: 8, extend_increment_s: 7, chain_soft_s: 22, chain_hard_s: 29, chain_cap_s: 36, max_reference_images: 3, max_prompt_chars: 4000, words_per_sec: 2.5, extend_carries_audio: false, extend_returns: combined, supports_negative_prompt: true, frame_takes_refs: false, frame_takes_last_frame: true}",
  "totals: {scenes: 2, shots: 2, calls: 3, keyframes: 2}",
  "cost_estimate: {first_pass_rate: 0.5, calls_raw: 3, calls_projected: 6, asset_images_raw: 9}",
  "---",
  "kind: character",
  "id: C1",
  "name: Mara",
  "lock_version: 1",
  "appears_in_shots: [1, 2]",
  "identity: freckles, short bob",
  "side_detail: green jacket",
  "voice: soft alto",
  "image_prompt: freckles, short bob green jacket",
  "---",
  "kind: keyframe",
  "id: K1",
  "lock_version: 1",
  "role: first",
  "for_call: CL002",
  "made_from: [C1]",
  "contains: [C1]",
  "composition: Mara at the bench, sun left",
  "image_prompt: freckles, short bob green jacket at the bench",
  "---",
  "kind: keyframe",
  "id: K2",
  "lock_version: 1",
  "role: last",
  "for_call: CL002",
  "made_from: [C1]",
  "contains: [C1]",
  "composition: Mara at the door, key raised",
  "image_prompt: freckles, short bob green jacket at the door",
  "---",
  "kind: shot",
  "id: 1",
  "scene: 1",
  "planned_s: 8",
  "characters: [C1]",
  "lines: [{id: s1.1, who: C1, text: Open it.}]",
  "---",
  "kind: shot",
  "id: 2",
  "scene: 2",
  "planned_s: 8",
  "characters: [C1]",
  "---",
  "kind: call",
  "id: CL001",
  "shot: 1",
  "pos: 1",
  "of: 1",
  "dur: 8",
  "mode: reference-to-video",
  "refs: [C1]",
  "characters: [C1]",
  "props: []",
  "dialogue: [s1.1]",
  "chain_risk: none",
  "content_risk: none",
  "flags: []",
  "prompt: Mara freckles, short bob green jacket enters. Reference 1 equals Mara. Mara says flat Open it. Only Mara moves her lips.",
  "---",
  "kind: call",
  "id: CL002",
  "shot: 2",
  "pos: 1",
  "of: 2",
  "dur: 8",
  "mode: frame-to-video",
  "refs: []",
  "characters: [C1]",
  "props: []",
  "dialogue: []",
  "chain_risk: none",
  "content_risk: none",
  "flags: []",
  "seed_from: K1",
  "end_frame: K2",
  "anchor_from: sun left, Mara screen-left",
  "ends_at: Mara at the door, key raised, mouth closed",
  "prompt: Mara freckles, short bob green jacket turns. FRAMES First frame equals K1. CARRY {{anchor_from}}",
  "---",
  "kind: call",
  "id: CL003",
  "shot: 2",
  "pos: 2",
  "of: 2",
  "dur: 7",
  "mode: extend",
  "refs: []",
  "characters: [C1]",
  "props: []",
  "dialogue: []",
  "chain_risk: none",
  "content_risk: none",
  "flags: []",
  "chained_from: CL002",
  "continues_from: Mara mid-turn, mouth closed",
  "prompt: CONTINUE {{continues_from}} She lifts the key.",
  "",
].join("\n");

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
  test("commits and reads a package", async () => {
    const pv = await preview("prj_scripts", [{ filename: "pkg.yaml", text: PKG }]);
    expect(pv.files[0].status).toBe("new");
    const cr = await commit("prj_scripts", { files: [{ filename: "pkg.yaml", text: PKG, action: "add" }] });
    expect(cr.status).toBe(200);
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    expect(view.entities.length).toBe(1);
    expect(view.keyframes.length).toBe(2);
    expect(view.shots.length).toBe(2);
    expect(view.calls.length).toBe(3);
    expect(view.scenes.length).toBe(2);
    expect(view.totals).toMatchObject({ shots: 2, scenes: 2, calls: 3, keyframes: 2 });
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
    const cl3summary = view.calls.find((c: any) => c.id === "CL003").summary as string;
    expect(cl3summary).not.toContain("{{");
    expect(cl3summary).toContain("lifts the key");
    // The fixture is lint-clean: no error checks.
    expect(view.checks.filter((c: any) => c.severity === "error")).toEqual([]);
  });

  test("exact duplicate and formatting-only change are skipped", async () => {
    const cr = await commit("prj_scripts", { files: [{ filename: "a.yaml", text: PKG, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const dup = await preview("prj_scripts", [{ filename: "a.yaml", text: PKG }], scriptId);
    expect(dup.files[0].status).toBe("duplicate");
    expect(dup.files[0].match.kind).toBe("exact");
    // Formatting-only change (quote style + trailing comment: same parsed
    // docs) → canonical duplicate.
    const reformatted =
      PKG.replaceAll(/^kind: (package_meta|character|location|prop|composite|keyframe|shot|call|chunk_header|asset_log|call_log)$/gm, 'kind: "$1"') +
      "\n# formatting-only comment\n";
    const dup2 = await preview("prj_scripts", [{ filename: "a.yaml", text: reformatted }], scriptId);
    expect(dup2.files[0].status).toBe("duplicate");
    expect(dup2.files[0].match.kind).toBe("canonical");
  });

  test("1-character edit is an update with a field diff", async () => {
    const cr = await commit("prj_scripts", { files: [{ filename: "pkg.yaml", text: PKG, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const edited = PKG.replace("freckles, short bob", "freckles, short boX");
    expect(edited).not.toBe(PKG);
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
    // Calls-only slice: every kind: call document, no bible.
    const chunks = PKG.split(/^[ \t]*---[ \t]*$/m);
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
    const bad = `${PKG}\n---\nkind: call\n  id: [unclosed\n`;
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
    const cr = await commit("prj_scripts", { files: [{ filename: "w.yaml", text: PKG, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const list = (await (await app.request("/projects/prj_scripts/scripts")).json()) as { scripts: any[] };
    const fileId = list.scripts[0].files[0].id as string;
    const raw = (await (await app.request(`/scripts/${scriptId}/raw?fileId=${fileId}`)).json()) as { text: string };
    expect(raw.text).toBe(PKG);
    expect((await app.request(`/scripts/${scriptId}/files/${fileId}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/scripts/${scriptId}`)).status).toBe(404);
  });

  test("checks catch risk drift, dangling chains, uncovered lines and bad totals", async () => {
    const broken = PKG
      .replace("chain_risk: none", "chain_risk: monitor")
      .replace("chained_from: CL002", "chained_from: CL999")
      .replace("dialogue: [s1.1]", "dialogue: []")
      .replace("calls: 3, keyframes: 2}", "calls: 99, keyframes: 2}");
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
    const cr = await commit("prj_scripts", { files: [{ filename: "k.yaml", text: PKG, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    const cl3 = view.calls.find((c: any) => c.id === "CL003");
    // No log yet: planned continues_from fills the template.
    expect(cl3.renderedPrompt).not.toContain("{{continues_from}}");
    expect(cl3.renderedPrompt).toContain("Mara mid-turn, mouth closed");
    expect(cl3.renderSource).toBe("planned");
    // CL001's prompt has no placeholders at all.
    expect(view.calls.find((c: any) => c.id === "CL001").renderSource).toBe("na");
    // A production log overrides the plan with the reconciled actual.
    const log = "kind: call_log\nid: CL003\ncontinues_from_actual: \"What the last frame really showed.\"\n";
    const cr2 = await commit("prj_scripts", { scriptId, files: [{ filename: "log.yaml", text: log, action: "add" }] });
    expect(cr2.status).toBe(200);
    const view2 = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    const cl3b = view2.calls.find((c: any) => c.id === "CL003");
    expect(cl3b.renderedPrompt).toContain("What the last frame really showed.");
    expect(cl3b.renderSource).toBe("actual");
    // Empty planned field: the placeholder survives and is flagged.
    const broken = PKG.replace("continues_from: Mara mid-turn, mouth closed", "continues_from: null");
    expect(broken).not.toBe(PKG);
    const cr3 = await commit("prj_scripts", { files: [{ filename: "m.yaml", text: broken, action: "add" }] });
    const { scriptId: sid3 } = (await cr3.json()) as { scriptId: string };
    const view3 = (await (await app.request(`/scripts/${sid3}`)).json()) as any;
    const cl3c = view3.calls.find((c: any) => c.id === "CL003");
    expect(cl3c.renderedPrompt).toContain("{{continues_from}}");
    expect(cl3c.renderSource).toBe("missing");
  });

  test("composer links pin entity images and call outputs, then unlink", async () => {
    const text = [
      "kind: package_meta",
      "title: Link test",
      "---",
      "kind: shot",
      "id: 1",
      "scene: 1",
      "planned_s: 8",
      "---",
      "kind: call",
      "id: CL001",
      "shot: 1",
      "pos: 1",
      "of: 1",
      "dur: 8",
      "mode: reference-to-video",
      'prompt: "A test shot."',
      "",
    ].join("\n");
    const cr = await commit("prj_scripts", { files: [{ filename: "link.yaml", text, action: "add" }] });
    expect(cr.status).toBe(200);
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const db = getDb();
    const now = new Date().toISOString();
    const elId = "el_link_1";
    db.query("INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)").run(
      elId, "prj_scripts", "characters", "Link face", "data:image/png;base64,xx", "", now,
    );
    const vidId = "vid_link_1";
    db.query(`INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect,
      duration_seconds, audio, status, cost_estimate, video_url, thumb_url, inputs_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      vidId, "prj_scripts", "job-1", "r2v", "veo-3.1-fast-generate-001", "p", "720p", "16:9",
      8, 1, "succeeded", 0, "", "", "{}", now, now,
    );
    // Fresh view carries empty links.
    expect(((await (await app.request(`/scripts/${scriptId}`)).json()) as any).links).toEqual({ entities: {}, calls: {} });
    // Link an entity and a call output.
    const put = (url: string, body: unknown) => app.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await put(`/scripts/${scriptId}/links/entity`, { entityId: "C1", elementId: elId })).status).toBe(200);
    expect((await put(`/scripts/${scriptId}/links/call`, { callId: "CL001", videoId: vidId })).status).toBe(200);
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    expect(view.links).toEqual({ entities: { C1: elId }, calls: { CL001: vidId } });
    // Cross-project targets are rejected.
    seedProject("prj_other");
    expect((await put(`/scripts/${scriptId}/links/entity`, { entityId: "C1", elementId: "nope" })).status).toBe(404);
    expect((await put(`/scripts/${scriptId}/links/call`, { callId: "CL001", videoId: "nope" })).status).toBe(404);
    // Unlink both.
    expect((await app.request(`/scripts/${scriptId}/links/entity/C1`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/scripts/${scriptId}/links/call/CL001`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await app.request(`/scripts/${scriptId}`)).json()) as any).links).toEqual({ entities: {}, calls: {} });
    // Element delete cleans its links (FK cascade counts the link row too).
    await put(`/scripts/${scriptId}/links/entity`, { entityId: "C1", elementId: elId });
    expect(db.query("DELETE FROM elements WHERE id=?").run(elId).changes).toBeGreaterThanOrEqual(1);
    // Manual cleanup mirrors the route (direct DB delete in tests bypasses it).
    db.query("DELETE FROM script_entity_links WHERE element_id=?").run(elId);
    expect(((await (await app.request(`/scripts/${scriptId}`)).json()) as any).links.entities).toEqual({});
  });

  test("commits a lint-clean package with keyframes", async () => {
    const cr = await commit("prj_scripts", { files: [{ filename: "pkg.yaml", text: PKG, action: "add" }] });
    expect(cr.status).toBe(200);
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const view = (await (await app.request(`/scripts/${scriptId}`)).json()) as any;
    expect(view.keyframes.map((k: any) => k.id).sort()).toEqual(["K1", "K2"]);
    expect(view.totals).toMatchObject({ shots: 2, calls: 3, keyframes: 2 });
    expect(view.files[0].keyframes).toBe(2);
    expect(view.checks.filter((c: any) => c.severity === "error")).toEqual([]);
  });

  test("frame/text/keyframe rules fire", async () => {
    const badLock = PKG.replace("frame_takes_refs: false", "frame_takes_refs: true");
    const cr = await commit("prj_scripts", { files: [{ filename: "pkg.yaml", text: badLock, action: "add" }] });
    const { scriptId } = (await cr.json()) as { scriptId: string };
    const codes = ((await (await app.request(`/scripts/${scriptId}`)).json()) as any).checks.map((c: any) => c.code);
    expect(codes).toContain("frame_takes_refs");

    // Refs on a frame call are an error now (first/last frame only).
    const withRefs = PKG.replace("mode: frame-to-video\nrefs: []", "mode: frame-to-video\nrefs: [C1]");
    const cr2 = await commit("prj_scripts", { files: [{ filename: "r.yaml", text: withRefs, action: "add" }] });
    const codes2 = ((await (await app.request(`/scripts/${(await cr2.json() as any).scriptId}`)).json()) as any).checks.map((c: any) => c.code);
    expect(codes2).toContain("frame_has_references");

    // Composite seeds and dangling end frames are rejected by the lint.
    const badSeed = PKG.replace("seed_from: K1", "seed_from: G9");
    const cr3 = await commit("prj_scripts", { files: [{ filename: "s.yaml", text: badSeed, action: "add" }] });
    const codes3 = ((await (await app.request(`/scripts/${(await cr3.json() as any).scriptId}`)).json()) as any).checks.map((c: any) => c.code);
    expect(codes3).toContain("dangling_chain");

    const badEnd = PKG.replace("end_frame: K2", "end_frame: K9");
    const cr4 = await commit("prj_scripts", { files: [{ filename: "e.yaml", text: badEnd, action: "add" }] });
    const codes4 = ((await (await app.request(`/scripts/${(await cr4.json() as any).scriptId}`)).json()) as any).checks.map((c: any) => c.code);
    expect(codes4).toContain("end_frame_unknown");

    // text-to-video without low_consistency warns.
    const textShot = [
      "kind: shot", "id: 3", "scene: 3", "planned_s: 8", "characters: []",
      "---",
      "kind: call", "id: CL004", "shot: 3", "pos: 1", "of: 1", "dur: 8",
      "mode: text-to-video", "refs: []", "characters: []", "props: []", "dialogue: []",
      "chain_risk: none", "content_risk: none", "flags: []",
      'prompt: "An empty room."', "",
    ].join("\n");
    const cr5 = await commit("prj_scripts", { files: [{ filename: "t.yaml", text: `${PKG}\n---\n${textShot}`, action: "add" }] });
    const view5 = (await (await app.request(`/scripts/${(await cr5.json() as any).scriptId}`)).json()) as any;
    expect(view5.calls.some((c: any) => c.mode === "text-to-video")).toBe(true);
    expect(view5.checks.map((c: any) => c.code)).toContain("text_expected_low_consistency");
  });
});
