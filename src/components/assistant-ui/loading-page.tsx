import { type FC } from "react";

/**
 * Full-panel conversation loading page: a monochrome arc spinner drawn in `--primary`,
 * kept animating under reduced-motion. `label` names the live region; the visible span
 * is aria-hidden.
 */
export const NexusLoadingPage: FC<{ label: string }> = ({ label }) => (
  <div className="nexus-loadpage" role="status" aria-label={label}>
    <svg
      className="nexus-loadpage-stage text-primary"
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Track: the full ring, dimmed by opacity so it stays in the same hue
          family as the arc in either theme. */}
      <circle
        className="nexus-loadpage-track"
        cx="24"
        cy="24"
        r="18"
        stroke="currentColor"
        strokeWidth="3"
      />
      {/* Arc: a quarter of the same circumference (2π·18 ≈ 113), rotating. */}
      <circle
        className="nexus-loadpage-arc"
        cx="24"
        cy="24"
        r="18"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="30 83"
      />
    </svg>
    <span className="nexus-loadpage-label" aria-hidden="true">
      {label}
    </span>
  </div>
);
