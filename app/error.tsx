"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { SlateButton } from "@/components/slate/button";
import { SlateEmpty } from "@/components/slate/core";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="slate-app h-[100dvh] overflow-y-auto grid place-items-center p-6" role="alert">
      <div className="w-full max-w-[480px]">
        <SlateEmpty
          icon={<TriangleAlert className="size-6 text-[#C9432E] dark:text-[#E88A76]" />}
          title="Something went wrong"
          sub={error.message || "The studio failed to load. Your projects are safe in local storage."}
          action={
            <SlateButton variant="primary" onClick={reset}>
              <RotateCcw className="size-3.5" /> Try again
            </SlateButton>
          }
        />
      </div>
    </div>
  );
}
