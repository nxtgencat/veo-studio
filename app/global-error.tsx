"use client";

import { TriangleAlert } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#FAF7F1", color: "#181A16" }}>
        <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }} role="alert">
          <div style={{ textAlign: "center", maxWidth: 420 }}>
            <TriangleAlert style={{ width: 24, height: 24, color: "#C9432E" }} />
            <h1 style={{ fontSize: 18, margin: "12px 0 6px" }}>Studio crashed</h1>
            <p style={{ fontSize: 13, opacity: 0.7 }}>{error.message || "An unrecoverable error occurred."}</p>
            <button
              type="button"
              onClick={reset}
              style={{ marginTop: 16, height: 38, padding: "0 14px", borderRadius: 9, border: 0, background: "#1C7247", color: "#fff", fontWeight: 600, cursor: "pointer" }}
            >
              Reload studio
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
