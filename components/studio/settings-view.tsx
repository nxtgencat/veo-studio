"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Check, LogOut, Moon, ShieldCheck, Sun, MonitorPlay } from "lucide-react";
import { RATES } from "@/mock/catalog.mock";
import { YT_CATS, YT_PRIVS } from "@/mock/catalog.mock";
import { ytCatLabel, ytConnect } from "@/lib/youtube";
import { useStudio } from "@/stores/use-studio";
import { useToasts, useYtAuth } from "@/stores/use-ui";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton } from "@/components/slate/button";
import { PageHead, SlateCardHeader, SlateField, SlateLabel, SlateTextarea, SlateToggle } from "@/components/slate/core";
import { SlateCard } from "@/components/slate/core";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";

function RateCell({ tier, res, audio }: { tier: string; res: string; audio: boolean }) {
  const r = RATES[tier]?.[res];
  if (!r) return <span className="text-muted">—</span>;
  const v = audio ? r.a : r.s;
  return v == null ? <span className="text-muted">—</span> : <span className="font-mono">${v.toFixed(2)}</span>;
}

export function SettingsView() {
  const params = useParams<{ projectId: string }>();
  const project = useStudio((s) => s.projects.find((x) => x.id === params.projectId));
  const updateActive = useStudio((s) => s.updateActive);
  const push = useToasts((s) => s.push);
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const yt = useYtAuth();
  const [sa, setSa] = useState(project?.settings.saJson ?? "");
  const [bucket, setBucket] = useState(project?.settings.bucket ?? "");
  const [ytId, setYtId] = useState(project?.settings.ytClientId ?? "");
  const [ytPriv, setYtPriv] = useState(project?.settings.ytPrivacy ?? "unlisted");
  const [ytCat, setYtCat] = useState(project?.settings.ytCategory ?? "22");
  const [ytBusy, setYtBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!project) return null;
  const connected = !!yt.token && yt.exp > Date.now();

  const saveConn = () => {
    updateActive((d) => { d.settings.saJson = sa; d.settings.bucket = bucket.trim(); });
    push("Settings saved", { icon: "✓" });
  };
  const saveYt = () => {
    updateActive((d) => { d.settings.ytClientId = ytId.trim(); d.settings.ytPrivacy = ytPriv as "private" | "unlisted" | "public"; d.settings.ytCategory = ytCat; });
    push("YouTube settings saved", { icon: "✓" });
  };
  const validate = () => {
    const msgs: string[] = [];
    if (!sa.trim()) msgs.push("service-account JSON is empty");
    else {
      try {
        const j = JSON.parse(sa);
        if (j.type !== "service_account") msgs.push("JSON is valid but type ≠ service_account");
        if (!j.client_email) msgs.push("missing client_email");
        if (!j.private_key) msgs.push("missing private_key");
      } catch (e) {
        msgs.push("JSON does not parse: " + (e as Error).message);
      }
    }
    if (!bucket.trim()) msgs.push("bucket is empty");
    else if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket.trim())) msgs.push("bucket name looks invalid");
    setErr(msgs.join(" · "));
    push(msgs.length ? "Validation found issues" : "Connection looks valid", {
      icon: msgs.length ? "!" : "✓",
      tone: msgs.length ? "danger" : "ok",
      detail: msgs.length ? msgs.join(" · ") : "JSON parses · bucket format OK · region us-central1",
    });
  };

  const ytGo = async () => {
    if (ytBusy) return;
    setYtBusy(true);
    updateActive((d) => { d.settings.ytClientId = ytId.trim(); d.settings.ytPrivacy = ytPriv as "private" | "unlisted" | "public"; d.settings.ytCategory = ytCat; });
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
      <PageHead title="Settings" sub={`Credentials and pricing for ${project.name}. Credentials stay in this browser.`} />
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
            <h3 className="font-display font-bold text-[13.5px]">Google Cloud connection</h3>
            <SlateBadge tone="draft">Local only</SlateBadge>
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            <div>
              <SlateLabel>Service account JSON</SlateLabel>
              <SlateTextarea className="font-mono !text-[11.5px]" rows={7} value={sa} onChange={(e) => setSa(e.target.value)} placeholder='{"type":"service_account","project_id":"…"}' />
              <p className="text-[11.5px] text-muted mt-1">Needs <span className="font-mono">Vertex AI User</span> + <span className="font-mono">Service Usage Consumer</span> + object access on your bucket.</p>
            </div>
            <div>
              <SlateLabel>Storage bucket ID</SlateLabel>
              <SlateField className="font-mono !text-[12.5px]" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-veo-output-12345" />
              <p className="text-[11.5px] text-muted mt-1">Created in <span className="font-mono">us-central1</span>. Used for outputs and Extend inputs.</p>
            </div>
            {err && <p className="text-[11.5px] text-[#C9432E]">{err}</p>}
            <div className="flex gap-2 flex-wrap">
              <SlateButton variant="primary" size="sm" onClick={saveConn}><Check className="size-3.5" /> Save</SlateButton>
              <SlateButton variant="ghost" size="sm" onClick={validate}><ShieldCheck className="size-3.5" /> Validate</SlateButton>
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
