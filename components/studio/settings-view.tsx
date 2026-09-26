"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Check, Download, KeyRound, LogOut, Moon, Sun, MonitorPlay, Upload } from "lucide-react";
import { YT_CATS, YT_PRIVS } from "@/lib/catalog";
import { api } from "@/lib/api";
import { rateFor } from "@/lib/pricing";
import { ytCatLabel, ytConnect } from "@/lib/youtube";
import { useStudio } from "@/stores/use-studio";
import { useToasts, useYtAuth } from "@/stores/use-ui";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton } from "@/components/slate/button";
import { PageHead, SlateCardHeader, SlateField, SlateLabel, SlateTextarea, SlateToggle } from "@/components/slate/core";
import { SlateCard } from "@/components/slate/core";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";
import { SlateModal, SlateModalHead } from "@/components/slate/overlays";

function RateCell({ tier, res, audio }: { tier: string; res: string; audio: boolean }) {
  // Representative model per tier for the rate lookup (rates are tier+res based).
  const rep = tier === "Lite" ? "veo-3.1-lite-generate-001" : tier === "Fast" ? "veo-3.1-fast-generate-001" : tier === "Legacy" ? "veo-2.0-generate-001" : "veo-3.1-generate-001";
  const v = rateFor(rep, res, audio);
  if (v == null) return <span className="text-muted">—</span>;
  return <span className="font-mono">${v.toFixed(2)}</span>;
}

export function SettingsView() {
  const params = useParams<{ projectId: string }>();
  const project = useStudio((s) => s.projects.find((x) => x.id === params.projectId));
  const saveSettings = useStudio((s) => s.saveSettings);
  const serverSettings = useStudio((s) => s.serverSettings(params.projectId));
  const push = useToasts((s) => s.push);
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const yt = useYtAuth();
  const [sa, setSa] = useState("");
  const [bucket, setBucket] = useState("");
  const [authMode, setAuthMode] = useState<"service_account" | "env">(project?.settings.authMode ?? "service_account");
  const [ytId, setYtId] = useState(project?.settings.ytClientId ?? "");
  const [ytPriv, setYtPriv] = useState(project?.settings.ytPrivacy ?? "unlisted");
  const [ytCat, setYtCat] = useState(project?.settings.ytCategory ?? "22");
  const [ytBusy, setYtBusy] = useState(false);
  const [saBusy, setSaBusy] = useState(false);
  const [bktBusy, setBktBusy] = useState(false);
  const [togBusy, setTogBusy] = useState(false);

  // Connection truth lives server-side; inputs are connect-only (a connected
  // entry must be disconnected before a new one can be entered).
  const saConnected = !!serverSettings?.hasSaJson && (project?.settings.authMode ?? "service_account") === "service_account";
  const bucketId = project?.settings.bucket ?? "";
  const bucketOn = project?.settings.useBucket ?? false;
  const saReady = (project?.settings.authMode ?? "service_account") === "env" || !!serverSettings?.hasSaJson;

  // Reset connect forms when switching projects.
  useEffect(() => {
    setSa("");
    setBucket("");
    setAuthMode(project?.settings.authMode ?? "service_account");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) return null;
  const connected = !!yt.token && yt.exp > Date.now();

  const saveSa = () => {
    if (saBusy) return;
    setSaBusy(true);
    void saveSettings({ saJson: sa, authMode }).then(
      () => {
        push("Service account connected", { icon: "✓", detail: sa.trim() ? "Key exchanged for a token successfully" : "Auth method updated" });
        setSa("");
      },
      (e) => {
        push("Service account save failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) });
      },
    ).finally(() => setSaBusy(false));
  };
  // Connect a new bucket: always lands Off — the toggle turns it on.
  const saveBucket = () => {
    const id = bucket.trim();
    if (bktBusy || !id) return;
    setBktBusy(true);
    void saveSettings({ bucket: id, useBucket: false }).then(
      () => {
        const loc = useStudio.getState().serverSettings(project?.id ?? "")?.bucketLocation;
        setBucket("");
        push("Bucket connected · Off", { icon: "✓", detail: loc ? `Reachable · ${loc}` : "Verified — flip the toggle to use it" });
      },
      (e) => {
        push("Bucket save failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) });
      },
    ).finally(() => setBktBusy(false));
  };
  // Toggle only exists on a connected bucket. Turning on re-verifies against
  // current credentials; turning off needs no verification.
  const flipBucket = () => {
    if (togBusy || !bucketId) return;
    setTogBusy(true);
    const patch = bucketOn ? { useBucket: false } : { bucket: bucketId, useBucket: true };
    void saveSettings(patch).then(
      () => push(bucketOn ? "Bucket off" : `Bucket on — outputs save to gs://${bucketId}`, { icon: "✓", tone: bucketOn ? "info" : "ok" }),
      (e) => push("Bucket toggle failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) }),
    ).finally(() => setTogBusy(false));
  };
  const dropBucket = () => {
    if (bktBusy || !bucketId) return;
    setBktBusy(true);
    void saveSettings({ bucket: "", useBucket: false }).then(
      () => push("Bucket disconnected", { icon: "✓", tone: "info" }),
      (e) => push("Disconnect failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 140) }),
    ).finally(() => setBktBusy(false));
  };
  const saveYt = () => {
    void saveSettings({ ytClientId: ytId.trim(), ytPrivacy: ytPriv as "private" | "unlisted" | "public", ytCategory: ytCat }).then(
      () => push("YouTube settings saved", { icon: "✓" }),
      (e) => push("Save failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 140) }),
    );
  };
  const ytGo = async () => {
    if (ytBusy) return;
    setYtBusy(true);
    try {
      await saveSettings({ ytClientId: ytId.trim(), ytPrivacy: ytPriv as "private" | "unlisted" | "public", ytCategory: ytCat });
    } catch (e) {
      push("Save failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 140) });
      setYtBusy(false);
      return;
    }
    try {
      const { token, exp } = await ytConnect(ytId);
      const { ytFetchChannel } = await import("@/lib/youtube");
      const channel = await ytFetchChannel(token);
      useYtAuth.getState().setAuth(token, exp, channel);
      push(channel ? `Connected as ${channel}` : "YouTube connected", { icon: "▶" });
    } catch (e) {
      push("YouTube connect failed", { icon: "!", tone: "danger", detail: String((e as Error).message || e).slice(0, 140) });
    } finally {
      setYtBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Settings" sub={`Credentials and pricing for ${project.name}. The service-account key lives on the server and is never sent back.`} />
      <div className="grid xl:grid-cols-2 gap-4 items-start">
        {/* Two explicit stacks (not row-aligned cards) so short + tall cards
            never leave dead gaps — left: Appearance + YouTube, right: Cloud. */}
        <div className="min-w-0 space-y-4">
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">Appearance</h3>
            {dark ? <SlateBadge tone="info"><Moon className="size-3" /> Dark</SlateBadge> : <SlateBadge tone="pending"><Sun className="size-3" /> Light</SlateBadge>}
          </SlateCardHeader>
          <div className="p-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[13px] font-bold">Dark mode</p>
              <p className="text-[11.5px] text-muted mt-0.5">Follows your system by default — override it here.</p>
            </div>
            <SlateToggle on={dark} label="Toggle dark mode" onFlip={() => setTheme(dark ? "light" : "dark")} />
          </div>
        </SlateCard>
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">YouTube publishing</h3>
            {connected ? <SlateBadge tone="ok"><MonitorPlay className="size-3" /> {yt.channel || "Connected"}</SlateBadge> : <SlateBadge tone="draft"><MonitorPlay className="size-3" /> Not connected</SlateBadge>}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            <div>
              <SlateLabel>OAuth Client ID (YouTube Data API v3)</SlateLabel>
              <SlateField className="font-mono !text-[12px]" value={ytId} onChange={(e) => setYtId(e.target.value)} placeholder="123…apps.googleusercontent.com" autoComplete="off" />
              <p className="text-[11.5px] text-muted mt-1">Web-application client with the API enabled. Token stays in memory, never in storage.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <SlateLabel>Default privacy</SlateLabel>
                <SlateDropdown
                  label={ytPriv}
                  btnClassName="slate-field w-full flex items-center gap-1 !text-[13px] font-semibold"
                  menu={(close) => YT_PRIVS.map((p) => (
                    <SlateOption key={p.id} active={ytPriv === p.id} sub={p.hint} onPick={() => setYtPriv(p.id)} onClose={close}>
                      {p.label}
                    </SlateOption>
                  ))}
                />
              </div>
              <div>
                <SlateLabel>Category</SlateLabel>
                <SlateDropdown
                  label={ytCatLabel(ytCat)}
                  btnClassName="slate-field w-full flex items-center gap-1 !text-[13px] font-semibold"
                  menu={(close) => YT_CATS.map((c) => (
                    <SlateOption key={c.id} active={ytCat === c.id} onPick={() => setYtCat(c.id)} onClose={close}>
                      {c.label}
                    </SlateOption>
                  ))}
                />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <SlateButton variant="primary" size="sm" onClick={saveYt}><Check className="size-3.5" /> Save</SlateButton>
              {connected ? (
                <SlateButton variant="ghost" size="sm" onClick={() => { useYtAuth.getState().clear(); push("YouTube disconnected", { icon: "▶", tone: "info" }); }}>
                  <LogOut className="size-3.5" /> Disconnect
                </SlateButton>
              ) : (
                <SlateButton variant="ghost" size="sm" disabled={ytBusy} onClick={ytGo}>
                  <MonitorPlay className="size-3.5" /> {ytBusy ? "Connecting…" : "Connect YouTube"}
                </SlateButton>
              )}
            </div>
            <p className="text-[11.5px] text-muted leading-relaxed">
              Unverified OAuth apps can only upload <span className="font-mono">private</span>. Pass Google&apos;s audit for public uploads. Uploads cost quota (~100/day on new projects).
            </p>
          </div>
        </SlateCard>
        <BackupCard />
        </div>
        <div className="min-w-0 space-y-4">
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">Service account</h3>
            {project.settings.authMode === "env" ? (
              <SlateBadge tone="info">Environment</SlateBadge>
            ) : saConnected ? (
              <SlateBadge tone="ok"><KeyRound className="size-3" /> Connected</SlateBadge>
            ) : (
              <SlateBadge tone="draft">Not connected</SlateBadge>
            )}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            {saConnected ? (
              <>
                <p className="text-[11.5px] font-mono break-words rounded-[8px] border slate-hair p-2" style={{ background: "var(--surface-2)" }}>
                  {serverSettings?.saEmail ?? "service account"} · {serverSettings?.saProjectId ?? ""}
                </p>
                <p className="text-[11.5px] text-muted leading-relaxed">
                  Key verified and stored server-side (never sent back). Disconnect to enter a different key.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <SlateButton
                    variant="ghost"
                    size="sm"
                    disabled={saBusy}
                    onClick={() => {
                      if (saBusy) return;
                      setSaBusy(true);
                      void saveSettings({ saJson: "" }).then(
                        () => push("Service account disconnected", { icon: "✓", tone: "info" }),
                        (e) => push("Disconnect failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 140) }),
                      ).finally(() => setSaBusy(false));
                    }}
                  >
                    Disconnect
                  </SlateButton>
                </div>
              </>
            ) : (
              <>
                <div>
                  <SlateLabel>Auth method</SlateLabel>
                  <SlateDropdown
                    label={authMode === "env" ? "Environment variables" : "Service account JSON (default)"}
                    btnClassName="slate-field w-full flex items-center gap-1 !text-[13px] font-semibold"
                    menu={(close) => (
                      <>
                        <SlateOption active={authMode === "service_account"} sub="Paste a key below" onPick={() => setAuthMode("service_account")} onClose={close}>
                          Service account JSON (default)
                        </SlateOption>
                        <SlateOption active={authMode === "env"} sub="GOOGLE_CLOUD_PROJECT + VERTEX_ACCESS_TOKEN" onPick={() => setAuthMode("env")} onClose={close}>
                          Environment variables
                        </SlateOption>
                      </>
                    )}
                  />
                </div>
                {authMode === "service_account" && (
                  <div>
                    <SlateLabel>Service account JSON</SlateLabel>
                    <SlateTextarea className="font-mono !text-[11.5px]" rows={5} value={sa} onChange={(e) => setSa(e.target.value)} placeholder='{"type":"service_account","project_id":"…"}' />
                    <p className="text-[11.5px] text-muted mt-1">Needs <span className="font-mono">Vertex AI User</span> + <span className="font-mono">Service Usage Consumer</span>. The key is verified (token exchange) before saving, stored server-side, never sent back.</p>
                  </div>
                )}
                <div className="flex gap-2 flex-wrap">
                  <SlateButton variant="primary" size="sm" disabled={saBusy || (authMode === "service_account" && !sa.trim())} onClick={saveSa}><Check className="size-3.5" /> {saBusy ? "Verifying…" : "Save & verify"}</SlateButton>
                </div>
              </>
            )}
          </div>
        </SlateCard>
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">Storage bucket</h3>
            {bucketId ? (
              bucketOn
                ? <SlateBadge tone="ok">Connected · On{serverSettings?.bucketLocation ? ` · ${serverSettings.bucketLocation}` : ""}</SlateBadge>
                : <SlateBadge tone="draft">Connected · Off</SlateBadge>
            ) : (
              <SlateBadge tone="draft">Not connected</SlateBadge>
            )}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            {!saReady ? (
              <p className="text-[12.5px] text-muted leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>
                A service account must be connected first — bucket verification needs its credentials.
              </p>
            ) : !bucketId ? (
              <>
                <div>
                  <SlateLabel>Bucket ID</SlateLabel>
                  <SlateField className="font-mono !text-[12.5px]" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-veo-output-12345" />
                  <p className="text-[11.5px] text-muted mt-1">Created in <span className="font-mono">us-central1</span>. Saved only if it exists and the service account can reach it. Vertex writes outputs here; Extend chains from bucket videos.</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <SlateButton variant="primary" size="sm" disabled={bktBusy || !bucket.trim()} onClick={saveBucket}><Check className="size-3.5" /> {bktBusy ? "Verifying…" : "Save & verify"}</SlateButton>
                </div>
              </>
            ) : (
              <>
                <p className="text-[11.5px] font-mono break-words rounded-[8px] border slate-hair p-2" style={{ background: "var(--surface-2)" }}>
                  gs://{bucketId}
                </p>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-bold">Use bucket</p>
                    <p className="text-[11.5px] text-muted mt-0.5">
                      {bucketOn
                        ? "On = outputs are saved to the bucket and generated videos stay extendable."
                        : "Off = outputs return inline (not saved); only fresh uploads under 20 MB can extend."}
                    </p>
                  </div>
                  <SlateToggle
                    on={bucketOn}
                    label="Toggle bucket use"
                    disabled={togBusy}
                    onFlip={flipBucket}
                  />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <SlateButton variant="ghost" size="sm" disabled={bktBusy} onClick={dropBucket}>Disconnect</SlateButton>
                </div>
                <p className="text-[11.5px] text-muted leading-relaxed">Disconnect to enter a different bucket ID.</p>
              </>
            )}
          </div>
        </SlateCard>
        </div>

        <SlateCard className="overflow-hidden xl:col-span-2">
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">Pricing reference · 2026 $/sec</h3>
            <SlateBadge tone="brand">Live</SlateBadge>
          </SlateCardHeader>
          <div className="overflow-x-auto">
            <table className="slate-tbl">
              <thead><tr><th>Tier</th><th className="rt">720p +au</th><th className="rt">720p</th><th className="rt">1080p +au</th><th className="rt">1080p</th><th className="rt">4K +au</th><th className="rt">4K</th></tr></thead>
              <tbody>
                {["Standard", "Fast", "Lite", "Legacy"].map((t) => (
                  <tr key={t}>
                    <td className="font-bold">{t}{t === "Legacy" && <span className="text-muted font-normal"> (silent)</span>}</td>
                    <td className="rt"><RateCell tier={t} res="720p" audio /></td>
                    <td className="rt"><RateCell tier={t} res="720p" audio={false} /></td>
                    <td className="rt"><RateCell tier={t} res="1080p" audio /></td>
                    <td className="rt"><RateCell tier={t} res="1080p" audio={false} /></td>
                    <td className="rt"><RateCell tier={t} res="4K" audio /></td>
                    <td className="rt"><RateCell tier={t} res="4K" audio={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-3.5 text-[12px] text-fg2 leading-relaxed border-t slate-hair">
            8s 1080p+audio: Standard $3.20 · Fast $0.96 · Lite 720p $0.40. Extend +7s bills like generation. Veo 2 / 3 retire Jun 30, 2026.
          </div>
        </SlateCard>
      </div>
    </>
  );
}

function BackupCard() {
  const push = useToasts((s) => s.push);
  const reloadProjects = useStudio((s) => s.reloadProjects);
  const projects = useStudio((s) => s.projects);
  const totals = useStudio((s) => s.totals);
  // All scopes default off: a bare backup is projects + settings only.
  const [incElements, setIncElements] = useState(false);
  const [incGenerated, setIncGenerated] = useState(false);
  const [incUploads, setIncUploads] = useState(false);
  // "all" or one project id — per-project archives stay far under the 1 GB cap.
  const [scopeProject, setScopeProject] = useState("all");
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState<{
    file: File;
    exportedAt: string;
    counts: Record<string, number>;
  } | null>(null);

  const download = () => {
    if (busy) return;
    setBusy(true);
    void api.downloadBackup({
      elements: incElements, generated: incGenerated, uploads: incUploads,
      ...(scopeProject !== "all" ? { projectId: scopeProject } : {}),
    }).then(
      ({ blob, filename }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        push("Backup downloaded", { icon: "✓", detail: filename });
      },
      (e) => push("Backup failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 140) }),
    ).finally(() => setBusy(false));
  };

  const restore = (f: File) => {
    if (busy) return;
    setBusy(true);
    // Step 1: inspect only — the confirm dialog shows what's inside.
    void api.inspectBackup(f).then(
      ({ manifest, counts }) => {
        setInspect({ file: f, exportedAt: manifest.exportedAt, counts });
      },
      (e) => push("Cannot read backup file", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) }),
    ).finally(() => setBusy(false));
  };

  const confirmRestore = () => {
    const cur = inspect;
    if (!cur || busy) return;
    setBusy(true);
    // Step 2: real import after explicit confirm.
    void api.restoreBackup(cur.file).then(
      async (rep) => {
        setInspect(null);
        const imp = rep.imported ?? {};
        const total = Object.values(imp).reduce((a, n) => a + (Number(n) || 0), 0);
        await reloadProjects().catch(() => {});
        push(`Restore complete — ${total} records imported`, {
          icon: "✓",
          detail: `projects ${imp.projects ?? 0} · elements ${imp.elements ?? 0} · library ${imp.library ?? 0} · media ${imp.media ?? 0}`,
        });
      },
      (e) => push("Restore failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) }),
    ).finally(() => setBusy(false));
  };

  return (
    <>
      <SlateCard>
        <SlateCardHeader>
          <h3 className="font-display font-bold text-[13.5px]">Backup & restore</h3>
          <SlateBadge tone="draft">tar</SlateBadge>
        </SlateCardHeader>
      <div className="p-4 space-y-3">
        <p className="text-[11.5px] text-muted leading-relaxed">
          Projects + connection settings are always included. Toggle what else goes in — all off by default.
          Over 1 GB total? Back up one project at a time.
        </p>
        <div>
          <SlateLabel>Project scope</SlateLabel>
          <SlateDropdown
            label={scopeProject === "all" ? "All projects" : (projects.find((p) => p.id === scopeProject)?.name ?? scopeProject)}
            btnClassName="slate-field w-full flex items-center gap-1 !text-[13px] font-semibold"
            menu={(close) => (
              <>
                <SlateOption active={scopeProject === "all"} sub="everything" onPick={() => setScopeProject("all")} onClose={close}>
                  All projects
                </SlateOption>
                {projects.map((p) => {
                  const n = totals?.byProject.find((b) => b.projectId === p.id)?.videos ?? p.library.length;
                  return (
                    <SlateOption key={p.id} active={scopeProject === p.id} sub={`${n} videos`} onPick={() => setScopeProject(p.id)} onClose={close}>
                      {p.name}
                    </SlateOption>
                  );
                })}
              </>
            )}
          />
        </div>
        {([
          ["Elements (faces, places, props, stills)", incElements, setIncElements],
          ["Generated library + videos", incGenerated, setIncGenerated],
          ["Uploaded library + files", incUploads, setIncUploads],
        ] as const).map(([label, on, flip]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-bold">{label}</p>
            <SlateToggle on={on} label={label} onFlip={() => flip(!on)} />
          </div>
        ))}
        <div className="flex gap-2 flex-wrap pt-1">
          <SlateButton variant="primary" size="sm" disabled={busy} onClick={download}>
            <Download className="size-3.5" /> {busy ? "Working…" : "Download backup"}
          </SlateButton>
          <label className="slate-btn slate-btn-ghost slate-btn-sm cursor-pointer">
            <Upload className="size-3.5" /> Restore
            <input
              type="file"
              accept=".tar,.tar.gz,.tgz,application/gzip,application/x-tar"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) restore(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      </SlateCard>
      {inspect && (
        <RestoreConfirmDialog
          info={inspect}
          busy={busy}
          close={() => setInspect(null)}
          confirm={confirmRestore}
        />
      )}
    </>
  );
}

function RestoreConfirmDialog({
  info,
  busy,
  close,
  confirm,
}: {
  info: { exportedAt: string; counts: Record<string, number> };
  busy: boolean;
  close: () => void;
  confirm: () => void;
}) {
  const rows: [string, number][] = [
    ["Projects", info.counts.projects ?? 0],
    ["Connection settings", info.counts.settings ?? 0],
    ["Elements", info.counts.elements ?? 0],
    ["Library videos", info.counts.library ?? 0],
    ["Jobs", info.counts.jobs ?? 0],
    ["Media files", info.counts.media ?? 0],
  ];
  return (
    <SlateModal onClose={close}>
      <SlateModalHead title="Import this backup?" onClose={close} />
      <p className="text-[12.5px] text-muted leading-relaxed">
        Exported {new Date(info.exportedAt).toLocaleString()}. Records that already
        exist are skipped — nothing is overwritten or deleted.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {rows.map(([label, n]) => (
          <div key={label} className="rounded-[8px] border slate-hair px-2.5 py-2 flex items-center justify-between" style={{ background: "var(--surface-2)" }}>
            <span className="text-[12px] font-semibold">{label}</span>
            <span className="text-[12px] font-mono font-bold tabular-nums">{n}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-2 justify-end">
        <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
        <SlateButton variant="primary" disabled={busy} onClick={confirm}>
          <Upload className="size-3.5" /> {busy ? "Importing…" : "Import"}
        </SlateButton>
      </div>
    </SlateModal>
  );
}
