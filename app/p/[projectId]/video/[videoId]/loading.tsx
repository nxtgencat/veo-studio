import { StudioShell } from "@/components/studio/studio-shell";
import { VideoLoadingSkeleton } from "@/components/slate/skeleton";

export default function VideoLoading() {
  return (
    <StudioShell>
      <VideoLoadingSkeleton />
    </StudioShell>
  );
}
