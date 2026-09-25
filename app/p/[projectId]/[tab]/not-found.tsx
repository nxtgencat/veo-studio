import Link from "next/link";
import { SearchX } from "lucide-react";
import { SlateButton } from "@/components/slate/button";
import { SlateEmpty } from "@/components/slate/core";
import { StudioShell } from "@/components/studio/studio-shell";

export default function TabNotFound() {
  return (
    <StudioShell>
      <SlateEmpty
        icon={<SearchX className="size-6 text-[#1C7247] dark:text-[#6FC191]" />}
        title="Not found"
        sub="Unknown tab, or this project / video no longer exists."
        action={
          <Link href="/" className="no-underline">
            <SlateButton variant="primary">Back to Studio</SlateButton>
          </Link>
        }
      />
    </StudioShell>
  );
}
