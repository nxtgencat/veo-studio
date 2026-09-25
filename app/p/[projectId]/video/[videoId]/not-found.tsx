import Link from "next/link";
import { SearchX } from "lucide-react";
import { SlateButton } from "@/components/slate/button";
import { SlateEmpty } from "@/components/slate/core";
import { StudioShell } from "@/components/studio/studio-shell";

export default function VideoNotFound() {
  return (
    <StudioShell>
      <SlateEmpty
        icon={<SearchX className="size-6 text-[#1C7247] dark:text-[#6FC191]" />}
        title="Video not found"
        sub="It may have been deleted in another tab."
        action={
          <Link href="/" className="no-underline">
            <SlateButton variant="primary">Back to Studio</SlateButton>
          </Link>
        }
      />
    </StudioShell>
  );
}
