"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Check, Download, KeyRound, Loader2, LogOut, Moon, Sun, MonitorPlay, Trash2, Upload } from "lucide-react";
import { YT_CATS, YT_PRIVS } from "@/lib/catalog";
import { ago, fmtBytes } from "@/lib/format";
import { backupFileUrl, errOf } from "@/lib/api";
import { rateFor } from "@/lib/pricing";
import { refreshYtAccount, ytCatLabel, ytConnectWithChannel, ytErrorHint, ytRevokeAccess } from "@/lib/youtube";
import { useStudio } from "@/stores/use-studio";
import { pushErr, useBackup, useToasts, useYtAuth } from "@/stores/use-ui";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton } from "@/components/slate/button";
import { PageHead, SlateCardHeader, SlateField, SlateLabel, SlateTextarea, SlateToggle } from "@/components/slate/core";
import { SlateCard } from "@/components/slate/core";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";
import { ConfirmDeleteDialog, SlateModal, SlateModalHead } from "@/components/slate/overlays";

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
  const [ytAppBusy, setYtAppBusy] = useState(false);
  const [ytPrefsBusy, setYtPrefsBusy] = useState(false);
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
    setYtId(project?.settings.ytClientId ?? "");
    setYtPriv(project?.settings.ytPrivacy ?? "unlisted");
    setYtCat(project?.settings.ytCategory ?? "22");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Heal sessions connected before account state existed (or when the check
  // failed): token is live but nothing is known — check once, persist.
  const ytLive = !!yt.token && yt.exp > Date.now();
  const [ytCheckBusy, setYtCheckBusy] = useState(false);
  useEffect(() => {
    if (ytLive && yt.token && yt.account !== "ok") {
      void refreshYtAccount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytLive]);

  const retryYtCheck = () => {
    if (ytCheckBusy || !useYtAuth.getState().token) return;
    setYtCheckBusy(true);
    void refreshYtAccount().finally(() => setYtCheckBusy(false));
  };

  if (!project) return null;
  const connected = !!yt.token && yt.exp > Date.now();
  // OAuth app truth lives server-side (client ID is public by design).
  const ytAppId = project.settings.ytClientId ?? "";
  // Channel metadata (one channels.list at connect, 1 quota unit).
  const ytStats = yt.meta ? [
    yt.meta.subs != null ? `${yt.meta.subs.toLocaleString()} subs` : "",
    yt.meta.videos != null ? `${yt.meta.videos.toLocaleString()} videos` : "",
    yt.meta.views != null ? `${yt.meta.views.toLocaleString()} views` : "",
  ].filter(Boolean).join(" · ") : "";
  const ytSub = yt.meta ? [yt.meta.handle, ytStats].filter(Boolean).join(" · ") : "";

  const saveSa = () => {
    if (saBusy) return;
    setSaBusy(true);
    void saveSettings({ saJson: sa, authMode }).then(
      () => {
        push("Service account connected", { icon: "check", detail: sa.trim() ? "Key exchanged for a token successfully" : "Auth method updated" });
        setSa("");
      },
      (e) => {
        pushErr("Service account save failed", errOf(e, 160));
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
        push("Bucket connected · Off", { icon: "check", detail: loc ? `Reachable · ${loc}` : "Verified — flip the toggle to use it" });
      },
      (e) => {
        pushErr("Bucket save failed", errOf(e, 160));
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
      () => push(bucketOn ? "Bucket off" : `Bucket on — outputs save to gs://${bucketId}`, { icon: "check", tone: bucketOn ? "info" : "ok" }),
      (e) => pushErr("Bucket toggle failed", errOf(e, 160)),
    ).finally(() => setTogBusy(false));
  };
  const dropBucket = () => {
    if (bktBusy || !bucketId) return;
    setBktBusy(true);
    void saveSettings({ bucket: "", useBucket: false }).then(
      () => push("Bucket disconnected", { icon: "check", tone: "info" }),
      (e) => pushErr("Disconnect failed", errOf(e, 140)),
    ).finally(() => setBktBusy(false));
  };
  // YouTube OAuth app card: save/disconnect the client ID (like the SA key card).
  const saveYtApp = () => {
    const id = ytId.trim();
    if (ytAppBusy || !id) return;
    setYtAppBusy(true);
    void saveSettings({ ytClientId: id }).then(
      () => {
        setYtId("");
        push("YouTube OAuth app saved", { icon: "check" });
      },
      (e) => pushErr("Save failed", errOf(e, 140)),
    ).finally(() => setYtAppBusy(false));
  };
  const clearYtApp = () => {
    if (ytAppBusy) return;
    setYtAppBusy(true);
    // The token was minted for this client — sign the account out too.
    ytRevokeAccess(useYtAuth.getState().token);
    useYtAuth.getState().clear();
    void saveSettings({ ytClientId: "" }).then(
      () => push("YouTube OAuth app disconnected", { icon: "play", tone: "info" }),
      (e) => pushErr("Disconnect failed", errOf(e, 140)),
    ).finally(() => setYtAppBusy(false));
  };
  // Publishing account card: publish defaults (like the bucket card).
  const saveYtPrefs = () => {
    if (ytPrefsBusy) return;
    setYtPrefsBusy(true);
    void saveSettings({ ytPrivacy: ytPriv as "private" | "unlisted" | "public", ytCategory: ytCat }).then(
      () => push("Publishing defaults saved", { icon: "check" }),
      (e) => pushErr("Save failed", errOf(e, 140)),
    ).finally(() => setYtPrefsBusy(false));
  };
  // The account depends on the app (like the bucket depends on auth):
  // Connect uses the saved client ID, never a draft.
  const ytGo = async () => {
    if (ytBusy) return;
    if (!ytAppId) {
      pushErr("Save your OAuth Client ID in the YouTube OAuth app card first");
      return;
    }
    setYtBusy(true);
    try {
      const c = await ytConnectWithChannel(ytAppId);
      useYtAuth.getState().setAuth({ token: c.token, exp: c.exp, channel: c.channel, meta: c.meta, account: c.account, detail: c.detail });
      push(c.channel ? `Connected as ${c.channel}` : "YouTube connected", { icon: "play" });
    } catch (e) {
      pushErr("YouTube connect failed", errOf(e, 140));
    } finally {
      setYtBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Settings" sub={`Credentials and pricing for ${project.name}. The service-account key lives on the server and is never sent back.`} />
      <div className="grid xl:grid-cols-2 gap-4 items-start">
        {/* Two explicit stacks (not row-aligned cards) so short + tall cards
            never leave dead gaps — left: Appearance + YouTube app + account, right: Cloud. */}
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
            <h3 className="font-display font-bold text-[13.5px]">YouTube OAuth app</h3>
            {ytAppId ? <SlateBadge tone="ok"><KeyRound className="size-3" /> Saved</SlateBadge> : <SlateBadge tone="draft">Not set</SlateBadge>}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            {ytAppId ? (
              <>
                <p className="text-[11.5px] font-mono break-words rounded-[8px] border slate-hair p-2" style={{ background: "var(--surface-2)" }}>
                  {ytAppId}
                </p>
                <p className="text-[11.5px] text-muted leading-relaxed">
                  Saved server-side with this project. Disconnect to enter a different one — this also signs the account out.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <SlateButton variant="ghost" size="sm" disabled={ytAppBusy} onClick={clearYtApp}>
                    Disconnect
                  </SlateButton>
                </div>
              </>
            ) : (
              <>
                <div>
                  <SlateLabel>OAuth Client ID (YouTube Data API v3)</SlateLabel>
                  <SlateField className="font-mono !text-[12px]" value={ytId} onChange={(e) => setYtId(e.target.value)} placeholder="123…apps.googleusercontent.com" autoComplete="off" />
                  <p className="text-[11.5px] text-muted mt-1">Web-application client with the API enabled and this origin registered. The ID is public — only the session stays in this browser, never on the server.</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <SlateButton variant="primary" size="sm" disabled={ytAppBusy || !ytId.trim()} onClick={saveYtApp}>
                    <Check className="size-3.5" /> Save
                  </SlateButton>
                </div>
              </>
            )}
          </div>
        </SlateCard>
        <SlateCard>
          <SlateCardHeader>
            <h3 className="font-display font-bold text-[13.5px]">YouTube account</h3>
            {connected
              ? <SlateBadge tone="ok"><MonitorPlay className="size-3" /> {yt.channel || "Connected"}</SlateBadge>
              : yt.channel
                ? <SlateBadge tone="pending"><MonitorPlay className="size-3" /> Session expired</SlateBadge>
                : <SlateBadge tone="draft"><MonitorPlay className="size-3" /> Not connected</SlateBadge>}
          </SlateCardHeader>
          <div className="p-4 space-y-4">
            {yt.meta && (
              <div className="rounded-[8px] border slate-hair p-2.5 flex items-center gap-2.5" style={{ background: "var(--surface-2)" }}>
                {yt.meta.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={yt.meta.avatar} alt="" className="size-9 rounded-full shrink-0" loading="lazy" />
                ) : (
                  <span className="slate-tile-icon w-9 h-9 !rounded-full shrink-0">
                    <MonitorPlay className="size-4" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold truncate">{yt.meta.name || yt.channel || "Connected"}</span>
                  {ytSub && (
                    <span className="block text-[11px] font-mono text-muted truncate">{ytSub}</span>
                  )}
                </span>
              </div>
            )}
            {connected && yt.account === "no-channel" && (
              <div className="rounded-[8px] border slate-hair p-2.5 text-[12px] leading-relaxed" style={{ background: "var(--t-danger-bg)", color: "var(--t-danger-fg)" }}>
                <p className="font-bold">No YouTube channel on this Google account.</p>
                <p className="mt-0.5">Uploads will fail until you create one — then Disconnect and connect again.</p>
              </div>
            )}
            {connected && yt.account === "error" && (
              <div className="rounded-[8px] border slate-hair p-2.5 text-[12px] leading-relaxed" style={{ background: "var(--surface-2)" }}>
                <p className="font-bold">Signed in, but channel info couldn&apos;t be read{yt.detail ? ` (${yt.detail})` : ""}.</p>
                <p className="mt-0.5 text-muted">{ytErrorHint(yt.detail)} — then reconnect.</p>
                <div className="mt-2 flex gap-2">
                  <SlateButton variant="ghost" size="sm" disabled={ytCheckBusy} onClick={retryYtCheck}>
                    {ytCheckBusy ? "Checking…" : "Retry check"}
                  </SlateButton>
                </div>
              </div>
            )}
            {connected ? (
              <div className="flex gap-2 flex-wrap">
                <SlateButton variant="ghost" size="sm" onClick={() => {
                  // Revoke server-side too: memory-clear alone leaves the token live ~1h.
                  ytRevokeAccess(useYtAuth.getState().token);
                  useYtAuth.getState().clear();
                  push("YouTube disconnected", { icon: "play", tone: "info" });
                }}>
                  <LogOut className="size-3.5" /> Disconnect
                </SlateButton>
              </div>
            ) : (
              <>
                <p className="text-[11.5px] text-muted leading-relaxed">
                  {yt.channel
                    ? `Signed in as ${yt.channel} before — reconnect to publish again. Needs the OAuth app above.`
                    : "Connect your Google account to publish. Needs the OAuth app above first."}
                </p>
                <div className="flex gap-2 flex-wrap">
                  <SlateButton variant="ghost" size="sm" disabled={ytBusy || !ytAppId} onClick={ytGo}>
                    <MonitorPlay className="size-3.5" /> {ytBusy ? "Connecting…" : yt.channel ? "Reconnect" : "Connect YouTube"}
                  </SlateButton>
                </div>
              </>
            )}
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
              <SlateButton variant="primary" size="sm" disabled={ytPrefsBusy} onClick={saveYtPrefs}><Check className="size-3.5" /> Save</SlateButton>
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
                        () => push("Service account disconnected", { icon: "check", tone: "info" }),
                        (e) => pushErr("Disconnect failed", errOf(e, 140)),
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
  const files = useBackup((s) => s.files);
  const busy = useBackup((s) => s.busy);
  const refresh = useBackup((s) => s.refresh);
  const buildNow = useBackup((s) => s.buildNow);
  const upload = useBackup((s) => s.upload);
  const remove = useBackup((s) => s.remove);
  const restore = useBackup((s) => s.restore);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // AbortController behind the Cancel button (upload is the only long op here).
  const uploadCtrl = useRef<AbortController | null>(null);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busyMsg = busy ? (busy.kind === "upload" ? busy.label : busy.kind === "build" ? "Packing everything…" : "Restoring…") : "";

  const onBuild = () => {
    void buildNow().then(
      (row) => {
        if (row) push("Backup packed", { icon: "check", detail: row.filename });
        else pushErr("Backup failed");
      },
    );
  };

  const onUpload = (f: File) => {
    const ctrl = new AbortController();
    uploadCtrl.current = ctrl;
    void upload(f, ctrl.signal).then(
      (row) => {
        uploadCtrl.current = null;
        if (row) push("Backup stored", { icon: "check", detail: row.filename });
        else if (ctrl.signal.aborted) push("Upload cancelled", { icon: "cancel", tone: "info" });
        else pushErr("Upload failed — not a readable backup");
      },
    );
  };

  const onDownload = (id: string, filename: string) => {
    const a = document.createElement("a");
    a.href = backupFileUrl(id);
    a.download = filename;
    a.click();
  };

  const onDelete = (id: string) => {
    setDeleteId(id);
  };

  const confirmDelete = () => {
    if (!deleteId || busy) return;
    const id = deleteId;
    setDeleteId(null);
    void remove(id).then(
      (ok) => {
        if (ok) push("Backup deleted", { icon: "trash", tone: "info" });
        else pushErr("Delete failed");
      },
    );
  };

  const onRestore = (id: string) => {
    const row = useBackup.getState().files.find((f) => f.id === id);
    if (!row) return;
    setConfirmId(id);
  };

  const confirmRestore = () => {
    if (!confirmId || busy) return;
    const id = confirmId;
    setConfirmId(null);
    void restore(id).then(
      async (rep) => {
        if (!rep) {
          pushErr("Restore failed");
          return;
        }
        const imp = rep.imported ?? {};
        const total = Object.values(imp).reduce((a, n) => a + (Number(n) || 0), 0);
        await reloadProjects().catch(() => {});
        push(`Restore complete — ${total} records imported`, {
          icon: "check",
          detail: `projects ${imp.projects ?? 0} · elements ${imp.elements ?? 0} · library ${imp.library ?? 0} · media ${imp.media ?? 0}`,
        });
      },
    );
  };

  const confirmRow = confirmId ? files.find((f) => f.id === confirmId) : undefined;

  return (
    <>
      <SlateCard>
        <SlateCardHeader>
          <h3 className="font-display font-bold text-[13.5px]">Backups</h3>
          <SlateBadge tone="draft">tar</SlateBadge>
        </SlateCardHeader>
      <div className="p-4 space-y-3">
        <p className="text-[11.5px] text-muted leading-relaxed">
          One click packs everything. Uploaded files are stored too — download, restore, or delete any of them. Restoring merges; existing records are skipped.
        </p>
        <div className="flex gap-2 flex-wrap">
          <SlateButton variant="primary" size="sm" disabled={!!busy} onClick={onBuild}>
            <Download className="size-3.5" /> {busy?.kind === "build" ? "Packing…" : "Backup now"}
          </SlateButton>
          <label className="slate-btn slate-btn-ghost slate-btn-sm cursor-pointer">
            <Upload className="size-3.5" /> Upload
            <input
              type="file"
              accept=".tar,.tar.gz,.tgz,application/gzip,application/x-tar"
              className="hidden"
              disabled={!!busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {busy && (
          <p className="text-[12px] text-muted flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" /> {busyMsg} safe to leave this page.
            {busy.kind === "upload" && (
              <SlateButton variant="ghost" size="sm" onClick={() => uploadCtrl.current?.abort()}>
                Cancel
              </SlateButton>
            )}
          </p>
        )}
        {files.length === 0 ? (
          <p className="text-[12.5px] text-muted slate-card p-4 text-center">No backups yet — pack one or upload a file.</p>
        ) : (
          <div className="space-y-1.5">
            {files.map((f) => (
              <div key={f.id} className="rounded-[8px] border slate-hair p-2.5" style={{ background: "var(--surface-2)" }}>
                <p className="text-[12.5px] font-semibold truncate" title={f.filename}>{f.filename}</p>
                <p className="text-[11px] font-mono text-muted mt-0.5">
                  {ago(Date.parse(f.created_at) || 0)} · {fmtBytes(f.bytes)}{(f.counts.library ?? 0) > 0 ? ` · ${f.counts.library} videos` : ""}{(f.counts.media ?? 0) > 0 ? ` · ${f.counts.media} files` : ""}
                </p>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  <SlateButton variant="ghost" size="sm" disabled={!!busy} onClick={() => onDownload(f.id, f.filename)}>
                    <Download className="size-3.5" /> Download
                  </SlateButton>
                  <SlateButton variant="ghost" size="sm" disabled={!!busy} onClick={() => onRestore(f.id)}>
                    <Upload className="size-3.5" /> Restore
                  </SlateButton>
                  <SlateButton variant="ghost" size="sm" disabled={!!busy} onClick={() => onDelete(f.id)}>
                    <Trash2 className="size-3.5" /> Delete
                  </SlateButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </SlateCard>
      {confirmRow && (
        <RestoreConfirmDialog
          info={{ exportedAt: confirmRow.created_at, counts: confirmRow.counts }}
          busy={!!busy}
          close={() => setConfirmId(null)}
          confirm={confirmRestore}
        />
      )}
      {deleteId && (
        <ConfirmDeleteDialog
          title="Delete this backup?"
          body={`${files.find((f) => f.id === deleteId)?.filename ?? "This file"} will be removed from the server. This cannot be undone.`}
          icon={<Trash2 className="size-3.5" />}
          busy={!!busy}
          close={() => setDeleteId(null)}
          confirm={confirmDelete}
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
