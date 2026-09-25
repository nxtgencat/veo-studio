"use client";

import { Suspense } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { useHydrateStudio, useRenderTick } from "@/hooks/use-studio-hooks";
import { SlateToastProvider } from "@/components/slate/toasts";

function StudioEffects() {
  useHydrateStudio();
  useRenderTick();
  return null;
}

export function StudioProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SlateToastProvider>
        <StudioEffects />
        <Suspense fallback={null}>{children}</Suspense>
      </SlateToastProvider>
    </ThemeProvider>
  );
}
