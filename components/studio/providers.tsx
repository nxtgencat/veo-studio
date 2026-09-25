"use client";

import { Suspense, useState } from "react";
import { useTheme } from "next-themes";
import { Clapperboard, Eye, EyeOff, KeyRound, Loader2, Moon, Sun } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { useHydrateStudio, useRenderTick } from "@/hooks/use-studio-hooks";
import { useStudio } from "@/stores/use-studio";
import { SlateToastProvider } from "@/components/slate/toasts";
import { SlateSidebarProvider } from "@/components/slate/sidebar";
import { SlateButton } from "@/components/slate/button";
import { SlateField, SlateLabel } from "@/components/slate/core";

function StudioEffects() {
  useHydrateStudio();
  useRenderTick();
  return null;
}

/**
 * Password gate: full-screen split with a brand panel (desktop) and a
 * focused unlock card. Single password, inline errors, show/hide toggle,
 * busy submit — no modal, no signup flows.
 */
function AuthGate() {
  const authRequired = useStudio((s) => s.authRequired);
  const login = useStudio((s) => s.login);
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!authRequired) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !pw) return;
    setBusy(true);
    setError("");
    void login(pw).then((r) => {
      setBusy(false);
      if (r.ok) {
        setPw("");
      } else {
        setError("Wrong password — try again.");
      }
    });
  };
  return (
    <div className="fixed inset-0 z-[80] slate-app flex overflow-hidden">
      {/* Brand panel (desktop) */}
      <aside className="hidden lg:flex lg:w-[42%] xl:w-[38%] relative overflow-hidden flex-col justify-between p-10 xl:p-14 text-white" style={{ background: "#0B2E1E" }}>
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{ background: "radial-gradient(560px circle at 15% 8%, rgba(63,169,109,.35), transparent 60%), radial-gradient(520px circle at 90% 92%, rgba(42,143,88,.30), transparent 55%)" }}
        />
        <div className="relative flex items-center gap-2.5">
          <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-white/10">
            <Clapperboard className="size-[19px]" />
          </span>
          <span className="font-display font-bold text-[16px]">AI Video Studio</span>
        </div>
        <div className="relative max-w-[420px]">
          <h1 className="font-display font-bold text-[34px] xl:text-[40px] leading-[1.08]">
            Cinematic clips, rendered while you watch.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">
            Unlock with the server password to generate, extend, and organize Veo renders across every project.
          </p>
          <div className="mt-8 flex items-center gap-5 font-mono text-[12.5px] text-white/60">
            {[["6", "video models"], ["5", "gen modes"], ["37s", "max extend"]].map(([v, l]) => (
              <div key={l}>
                <p className="font-bold text-[15px] text-white tabular-nums">{v}</p>
                <p className="text-[11px] text-white/50">{l}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-[12px] text-white/45">Password-protected · key stays on your server</p>
      </aside>

      {/* Unlock panel */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 sm:p-10 relative">
        <button
          type="button"
          onClick={() => setTheme(dark ? "light" : "dark")}
          aria-label="Toggle theme"
          className="absolute top-5 right-5 grid place-items-center w-10 h-10 rounded-full hover:bg-surface2 text-fg2"
        >
          {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </button>
        <div className="w-full max-w-[400px]">
          <div className="lg:hidden flex items-center gap-2.5 mb-7 justify-center">
            <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-[#1C7247] text-white">
              <Clapperboard className="size-[18px]" />
            </span>
            <span className="font-display font-bold text-[16px]">AI Video Studio</span>
          </div>
          <div className="slate-card p-7 sm:p-8">
            <div className="grid place-items-center w-12 h-12 rounded-full mx-auto mb-4" style={{ background: "var(--t-brand-bg)" }}>
              <KeyRound className="size-[22px] text-[#1C7247]" />
            </div>
            <h2 className="font-display font-bold text-[22px] text-center">Enter password</h2>
            <p className="mt-1.5 text-[13.5px] text-fg2 text-center">This studio is locked. Unlock to continue.</p>
            <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
              <div>
                <SlateLabel htmlFor="veo-password">Server password</SlateLabel>
                <div className="relative">
                  <SlateField
                    id="veo-password"
                    type={show ? "text" : "password"}
                    value={pw}
                    onChange={(e) => { setPw(e.target.value); setError(""); }}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    autoFocus
                    aria-invalid={!!error}
                    className={`!pr-11 ${error ? "!border-[#C9432E]" : ""}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? "Hide password" : "Show password"}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-8 h-8 rounded-[8px] text-muted hover:text-fg"
                  >
                    {show ? <EyeOff className="size-[17px]" /> : <Eye className="size-[17px]" />}
                  </button>
                </div>
                {error ? (
                  <p className="text-[12px] text-[#C9432E] mt-1.5 flex items-center gap-1">{error}</p>
                ) : null}
              </div>
              <SlateButton variant="primary" className="w-full !h-[46px]" type="submit" disabled={busy || !pw}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null} {busy ? "Checking…" : "Unlock studio"}
              </SlateButton>
            </form>
          </div>
          <p className="mt-6 text-center text-[12px] text-muted leading-relaxed">
            Stay signed in on this browser for 72 hours — or lock it anytime from the header.
          </p>
        </div>
      </main>
    </div>
  );
}

export function StudioProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SlateToastProvider>
        <SlateSidebarProvider>
          <StudioEffects />
          <AuthGate />
          <Suspense fallback={null}>{children}</Suspense>
        </SlateSidebarProvider>
      </SlateToastProvider>
    </ThemeProvider>
  );
}
