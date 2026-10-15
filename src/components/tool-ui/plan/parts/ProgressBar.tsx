import { memo } from "react";
import { cn } from "@/lib/utils";

export const PlanProgressBar = memo(function PlanProgressBar({
  progress,
  isCelebrating,
}: {
  progress: number;
  isCelebrating: boolean;
}) {
  return (
    <div
      className="bg-muted relative mb-3 h-1.5 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          progress === 100
            ? "bg-success motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:ease-out"
            : "bg-primary",
        )}
        style={{
          width: `${progress}%`,
          boxShadow:
            "inset 0 1px 0 oklch(1 0 0 / 30%), 0 1px 2px oklch(0 0 0 / 20%)",
        }}
      />
      {isCelebrating && (
        <div
          className="pointer-events-none absolute inset-0 rounded-full motion-safe:animate-pulse"
          style={{
            boxShadow: "0 0 20px color-mix(in oklab, var(--success) 60%, transparent)",
          }}
        />
      )}
    </div>
  );
});
