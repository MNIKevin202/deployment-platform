import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
  /** Optional leading icon (e.g. <Icon name="apps" />). */
  icon?: ReactNode;
}

/** Short, non-color-only word for each tone, read by assistive tech and shown
 *  as a small dot so status never relies on color alone. */
const TONE_STATUS: Record<NonNullable<StatCardProps["tone"]>, string | null> = {
  neutral: null,
  positive: "OK",
  warning: "Attention",
  negative: "Critical"
};

export default function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon
}: StatCardProps) {
  const status = TONE_STATUS[tone];
  return (
    <article className={`stat-card tone-${tone}`}>
      <div className="stat-card-top">
        {icon && <span className="stat-card-icon" aria-hidden="true">{icon}</span>}
        <span className="stat-card-label">{label}</span>
        {status && (
          <span className="stat-card-status" aria-hidden="true">
            <span className="stat-card-status-dot" />
          </span>
        )}
      </div>
      <strong className="stat-card-value">{value}</strong>
      {hint && <span className="stat-card-hint">{hint}</span>}
      {status && <span className="sr-only">{`status: ${status}`}</span>}
    </article>
  );
}
