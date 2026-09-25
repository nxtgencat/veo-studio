import { SlateSpinner } from "@/components/slate/skeleton";

export default function RootLoading() {
  return (
    <div className="slate-app h-[100dvh] grid place-items-center" aria-busy="true" aria-label="Loading">
      <SlateSpinner className="size-6 text-muted" />
    </div>
  );
}
