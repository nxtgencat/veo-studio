import Link from "next/link";
import { Clapperboard, SearchX } from "lucide-react";
import { SlateButton } from "@/components/slate/button";
import { SlateEmpty } from "@/components/slate/core";

export default function NotFound() {
  return (
    <div className="slate-app h-[100dvh] flex flex-col overflow-hidden">
      <header className="h-[52px] shrink-0 border-b slate-hair bg-surface flex items-center gap-2.5 px-4">
        <span className="grid place-items-center w-7 h-7 rounded-[9px] bg-[#1C7247] text-white shrink-0">
          <Clapperboard className="size-4" />
        </span>
        <p className="font-display font-bold text-[14.5px]">AI Video Studio</p>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto grid place-items-center p-6">
        <div className="w-full max-w-[480px]">
          <SlateEmpty
            icon={<SearchX className="size-6 text-[#1C7247] dark:text-[#6FC191]" />}
            title="Page not found"
            sub="The link may be wrong or the project/video was deleted."
            action={
              <Link href="/" className="no-underline">
                <SlateButton variant="primary">Back to Studio</SlateButton>
              </Link>
            }
          />
        </div>
      </main>
    </div>
  );
}
