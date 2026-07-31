import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";

interface MetricsSparklineProps<T extends object> {
  data: readonly T[];
  dataKey: Extract<keyof T, string>;
  color: string;
  height?: number;
  formatValue?: (value: number) => string;
  domain?: [number, number | string];
}

/**
 * A compact, axis-free area chart for a single rolling metric — CPU%,
 * memory, network, etc. Deliberately minimal (no grid, no legend, no time
 * axis labels) since these live inside stat-card-sized spaces; the value and
 * trend shape are what matters, not precise reading.
 */
export default function MetricsSparkline<T extends object>({
  data,
  dataKey,
  color,
  height = 64,
  formatValue,
  domain
}: MetricsSparklineProps<T>) {
  const gradientId = `metrics-sparkline-${useId()}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data as T[]} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={domain ?? [0, "auto"]} />
        <Tooltip
          formatter={(value: number) => [formatValue ? formatValue(value) : String(value), ""]}
          labelFormatter={() => ""}
          contentStyle={{
            background: "var(--color-surface-raised)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
            padding: "4px 8px"
          }}
          itemStyle={{ color: "var(--color-text)" }}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
