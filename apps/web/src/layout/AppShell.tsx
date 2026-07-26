import type { ReactNode } from "react";

interface AppShellProps {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}

export default function AppShell({ sidebar, header, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">{sidebar}</aside>
      <div className="app-topbar">{header}</div>
      <main className="app-main">{children}</main>
    </div>
  );
}
