/**
 * A small, dependency-free line-icon set for the redesigned shell and Overview.
 * 24×24, 1.6 stroke, `currentColor` — so an icon inherits the surrounding text
 * colour and tone. Decorative by default (aria-hidden); pass a `title` to make
 * one meaningful to assistive tech.
 */
export type IconName =
  | "overview"
  | "apps"
  | "resources"
  | "automation"
  | "platform"
  | "database"
  | "play"
  | "stop"
  | "route"
  | "docker"
  | "cpu"
  | "memory"
  | "gauge"
  | "activity"
  | "plus"
  | "template"
  | "chevron-left"
  | "chevron-right"
  | "pulse"
  | "refresh"
  | "check";

const PATHS: Record<IconName, string> = {
  overview: "M3 12l9-9 9 9M5 10v10h14V10",
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  resources:
    "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  automation: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v4l3 2",
  platform:
    "M12 2a3 3 0 0 1 3 3 3 3 0 0 0 4.2 2.7 3 3 0 0 1 1.1 4.1A3 3 0 0 0 20 18a3 3 0 0 1-3.9 2.3A3 3 0 0 0 12 22a3 3 0 0 0-4.1-1.7A3 3 0 0 1 4 18a3 3 0 0 0-.3-4.2 3 3 0 0 1 1.1-4.1A3 3 0 0 0 9 5a3 3 0 0 1 3-3zM10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  play: "M8 5v14l11-7z",
  stop: "M7 7h10v10H7z",
  route: "M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 16h6a3 3 0 0 0 3-3V8",
  docker: "M3 11h18M6 11V8h3v3M10 11V8h3v3M14 11V8h3v3M4 14c1.5 3 5 5 8 5 5 0 8-3 9-7",
  cpu: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M6 6h12v12H6zM10 10h4v4h-4z",
  memory: "M4 7h16v10H4zM8 7v10M12 7v10M16 7v10M4 5v2M20 5v2",
  gauge: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 12l4-3M5 18a9 9 0 1 1 14 0",
  activity: "M3 12h4l3 8 4-16 3 8h4",
  plus: "M12 5v14M5 12h14",
  template: "M4 5h16v4H4zM4 11h7v8H4zM13 11h7v8h-7z",
  "chevron-left": "M15 6l-6 6 6 6",
  "chevron-right": "M9 6l6 6-6 6",
  pulse: "M3 12h5l2-5 4 10 2-5h5",
  refresh: "M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M18 4v5h-5M6 20v-5h5",
  check: "M4 12l5 5L20 6"
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

export default function Icon({ name, size = 18, className, title }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
