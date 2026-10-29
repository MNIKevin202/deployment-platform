import type { ReactNode } from "react";
import UpdateBanner from "../components/UpdateBanner";

interface AppShellProps {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  /** Extra classes on .app-shell (e.g. "app-shell--collapsed"). */
  className?: string;
}

export default function AppShell({ sidebar, header, children, className }: AppShellProps) {
  return (
    <div className={`app-shell${className ? ` ${className}` : ""}`}>
      <aside className="app-sidebar">{sidebar}</aside>
      <div className="app-topbar">{header}</div>
      <main className="app-main">
        <UpdateBanner />
        {children}
      </main>
    </div>
  );
}
