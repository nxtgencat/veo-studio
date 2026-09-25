import { StudioShell } from "@/components/studio/studio-shell";
import { TabLoadingSkeleton } from "@/components/slate/skeleton";

export default function TabLoading() {
  return (
    <StudioShell>
      <TabLoadingSkeleton />
    </StudioShell>
  );
}
