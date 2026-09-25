"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { SlateButton } from "@/components/slate/button";
import { SlateEmpty } from "@/components/slate/core";

export default function TabError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="px-3 sm:px-5 lg:px-8 py-5" role="alert">
      <SlateEmpty
        icon={<TriangleAlert className="size-6 text-[#C9432E] dark:text-[#E88A76]" />}
        title="Something went wrong"
        sub={error.message || "This section failed to render. Your projects are safe in local storage."}
        action={
          <SlateButton variant="primary" onClick={reset}>
            <RotateCcw className="size-3.5" /> Try again
          </SlateButton>
        }
      />
    </div>
  );
}
