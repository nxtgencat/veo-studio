"use client";

import { Suspense } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { useHydrateStudio, useRenderTick } from "@/hooks/use-studio-hooks";
import { SlateToastProvider } from "@/components/slate/toasts";
import { SlateSidebarProvider } from "@/components/slate/sidebar";

function StudioEffects() {
  useHydrateStudio();
  useRenderTick();
  return null;
}

export function StudioProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SlateToastProvider>
        <SlateSidebarProvider>
          <StudioEffects />
          <Suspense fallback={null}>{children}</Suspense>
        </SlateSidebarProvider>
      </SlateToastProvider>
    </ThemeProvider>
  );
}
