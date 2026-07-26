interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
}

export default function StatCard({
  label,
  value,
  hint,
  tone = "neutral"
}: StatCardProps) {
  return (
    <article className={`stat-card tone-${tone}`}>
      <span className="stat-card-label">{label}</span>
      <strong className="stat-card-value">{value}</strong>
      {hint && <span className="stat-card-hint">{hint}</span>}
    </article>
  );
}
