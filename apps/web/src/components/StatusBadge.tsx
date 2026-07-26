type StatusBadgeTone = "positive" | "negative" | "neutral" | "warning";

interface StatusBadgeProps {
  label: string;
  tone: StatusBadgeTone;
}

export default function StatusBadge({ label, tone }: StatusBadgeProps) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}
