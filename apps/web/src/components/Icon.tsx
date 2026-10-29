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
  | "check"
  | "settings"
  | "server"
  | "key"
  | "git"
  | "clock"
  | "globe"
  | "shield"
  | "bell"
  | "search"
  | "filter"
  | "list"
  | "grid"
  | "trash"
  | "edit"
  | "external"
  | "logs"
  | "warning"
  | "info"
  | "x"
  | "link"
  | "terminal"
  | "download"
  | "upload"
  | "box"
  | "lock"
  | "eye"
  | "calendar"
  | "bolt"
  | "folder"
  | "more"
  | "chevron-down";

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
  check: "M4 12l5 5L20 6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1.1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  server: "M4 4h16v6H4zM4 14h16v6H4zM7.5 7h.01M7.5 17h.01M11 7h5M11 17h5",
  key: "M10.5 14a5 5 0 1 1 3.8-1.8L21 19v2h-3v-2h-2v-2h-2l-1.2-1.2A5 5 0 0 1 10.5 14zM8 9.5h.01",
  git: "M9 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 12V5M9 5a3 3 0 1 0 0-.01zM18 9a3 3 0 1 0 0 .01zM18 9c0 3-3 4-6 4",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 12h17M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18",
  shield: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  filter: "M3 5h18l-7 8v5l-4 2v-7z",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z",
  external: "M14 5h5v5M19 5l-8 8M18 14v5H5V6h5",
  logs: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  warning: "M12 4l9 16H3zM12 10v4M12 18h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  x: "M6 6l12 12M18 6L6 18",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.5-1.5",
  terminal: "M5 5h14v14H5zM8 9l3 3-3 3M13 15h4",
  download: "M12 3v12M7 10l5 5 5-5M4 20h16",
  upload: "M12 21V9M7 14l5-5 5 5M4 4h16",
  box: "M12 2l9 5v10l-9 5-9-5V7zM3.5 7l8.5 5 8.5-5M12 12v10",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  eye: "M2.5 12s4-7 9.5-7 9.5 7 9.5 7-4 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  calendar: "M5 5h14v15H5zM5 9.5h14M9 3v4M15 3v4",
  bolt: "M13 2L4 14h6l-1 8 9-12h-6z",
  folder: "M3 6h6l2 2h10v11H3z",
  more: "M12 6.5h.01M12 12h.01M12 17.5h.01",
  "chevron-down": "M6 9l6 6 6-6"
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
