import type { Metadata } from "next";
import { Bricolage_Grotesque, JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";
import { StudioProviders } from "@/components/studio/providers";

const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"] });
const sans = Manrope({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Video Studio",
  description: "Generate, manage and publish Veo videos — projects, library, elements and YouTube.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <StudioProviders>{children}</StudioProviders>
      </body>
    </html>
  );
}
