import { useId } from "react";

interface BrandMarkProps {
  /** Rendered size in px when no CSS width/height overrides it. */
  size?: number;
  className?: string;
}

/**
 * The ClovaForge mark: a spark on a violet→ember gradient tile. The forge
 * identity lives here (and almost nowhere else) — a subtle influence, not a
 * theme. Each instance gets a unique gradient id so multiple marks on one page
 * don't collide.
 */
export default function BrandMark({ size = 34, className }: BrandMarkProps) {
  const gradientId = `cf-mark-${useId().replace(/:/g, "")}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="ClovaForge"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8a7cf6" />
          <stop offset="0.62" stopColor="#6f74f2" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <path
        d="M16 6.5l2.3 6.1 6.2 2.3-6.2 2.3L16 25.5l-2.3-6.3-6.2-2.3 6.2-2.3z"
        fill="#fff"
        fillOpacity="0.95"
      />
    </svg>
  );
}
