"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Check, KeyRound, LogOut, Moon, Sun, MonitorPlay } from "lucide-react";
import { YT_CATS, YT_PRIVS } from "@/lib/catalog";
import { rateFor } from "@/lib/pricing";
import { ytCatLabel, ytConnect } from "@/lib/youtube";
import { useStudio } from "@/stores/use-studio";
import { useToasts, useYtAuth } from "@/stores/use-ui";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton } from "@/components/slate/button";
import { PageHead, SlateCardHeader, SlateField, SlateLabel, SlateTextarea, SlateToggle } from "@/components/slate/core";
import { SlateCard } from "@/components/slate/core";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";

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
  const [bucket, setBucket] = useState(project?.settings.bucket ?? "");
  const [useBucket, setUseBucket] = useState(project?.settings.useBucket ?? true);
  const [authMode, setAuthMode] = useState<"service_account" | "env">(project?.settings.authMode ?? "service_account");
  const [ytId, setYtId] = useState(project?.settings.ytClientId ?? "");
  const [ytPriv, setYtPriv] = useState(project?.settings.ytPrivacy ?? "unlisted");
  const [ytCat, setYtCat] = useState(project?.settings.ytCategory ?? "22");
  const [ytBusy, setYtBusy] = useState(false);
  const [saBusy, setSaBusy] = useState(false);
  const [bktBusy, setBktBusy] = useState(false);

  // Resync local editors when the server state arrives/changes.
  useEffect(() => {
    if (!project) return;
    setBucket(project.settings.bucket ?? "");
    setUseBucket(project.settings.useBucket ?? true);
    setAuthMode(project.settings.authMode ?? "service_account");
  }, [project?.settings.bucket, project?.settings.useBucket, project?.settings.authMode]);

  if (!project) return null;
  const connected = !!yt.token && yt.exp > Date.now();

  const saveSa = () => {
    if (saBusy) return;
    setSaBusy(true);
    void saveSettings({ saJson: sa, authMode }).then(
      () => {
        push("Service account saved & verified", { icon: "✓", detail: sa.trim() ? "Key exchanged for a token successfully" : "Auth method updated" });
        setSa("");
      },
      (e) => {
        push("Service account save failed", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) });
      },
    ).finally(() => setSaBusy(false));
  };
  const saveBucket = () => {
    if (bktBusy) return;
    setBktBusy(true);
    void saveSettings({ bucket: bucket.trim(), useBucket }).then(
      () => {
        const loc = useStudio.getState().serverSettings(project?.id ?? "")?.bucketLocation;
        push(
          bucket.trim() ? "Bucket verified & saved" : "Bucket cleared",
          { icon: "✓", detail: loc ? `Reachable · ${loc}` : bucket.trim() ? "Saved" : undefined },
        );
      },
      (e) => {
        push("Bucket save failed — kept previous value", { icon: "!", tone: "danger", detail: String(e instanceof Error ? e.message : e).slice(0, 160) });
      },
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
        </div>
        <div className="min-w-0 space-y-4">
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">Service account</h3>
            {authMode === "env" ? (
              <SlateBadge tone="info">Environment</SlateBadge>
            ) : serverSettings?.hasSaJson ? (
              <SlateBadge tone="ok"><KeyRound className="size-3" /> SA connected</SlateBadge>
            ) : (
              <SlateBadge tone="danger">No service account</SlateBadge>
            )}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            {serverSettings?.hasSaJson && (
              <p className="text-[11.5px] font-mono break-words rounded-[8px] border slate-hair p-2" style={{ background: "var(--surface-2)" }}>
                {serverSettings.saEmail ?? "service account"} · {serverSettings.saProjectId ?? ""}
              </p>
            )}
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
                <SlateLabel>Service account JSON {serverSettings?.hasSaJson ? <span className="text-muted font-normal">(blank = keep current)</span> : null}</SlateLabel>
                <SlateTextarea className="font-mono !text-[11.5px]" rows={5} value={sa} onChange={(e) => setSa(e.target.value)} placeholder='{"type":"service_account","project_id":"…"}' />
                <p className="text-[11.5px] text-muted mt-1">Needs <span className="font-mono">Vertex AI User</span> + <span className="font-mono">Service Usage Consumer</span>. The key is verified (token exchange) before saving, stored server-side, never sent back.</p>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <SlateButton variant="primary" size="sm" disabled={saBusy} onClick={saveSa}><Check className="size-3.5" /> {saBusy ? "Verifying…" : "Save & verify"}</SlateButton>
            </div>
          </div>
        </SlateCard>
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">Storage bucket</h3>
            {project.settings.useBucket && project.settings.bucket ? (
              <SlateBadge tone="ok">In use{serverSettings?.bucketLocation ? ` · ${serverSettings.bucketLocation}` : ""}</SlateBadge>
            ) : (
              <SlateBadge tone="draft">Off</SlateBadge>
            )}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            <div>
              <SlateLabel>Bucket ID</SlateLabel>
              <SlateField className="font-mono !text-[12.5px]" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-veo-output-12345" />
              <p className="text-[11.5px] text-muted mt-1">Created in <span className="font-mono">us-central1</span>. Saved only if it exists and the service account can reach it. Vertex writes outputs here; Extend chains from bucket videos.</p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-bold">Use bucket</p>
                <p className="text-[11.5px] text-muted mt-0.5">On = outputs are saved to the bucket and generated videos stay extendable. Off = outputs return inline (not saved); Extend then works only for fresh uploads under 20 MB.</p>
              </div>
              <SlateToggle on={useBucket} label="Toggle bucket use" onFlip={() => setUseBucket((v) => !v)} />
            </div>
            <div className="flex gap-2 flex-wrap">
              <SlateButton variant="primary" size="sm" disabled={bktBusy} onClick={saveBucket}><Check className="size-3.5" /> {bktBusy ? "Verifying…" : "Save & verify"}</SlateButton>
            </div>
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
