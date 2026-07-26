import type { ReactNode } from "react";

interface HeaderProps {
  title: string;
  subtitle?: string;
  username: string;
  onLogout: () => void;
  actions?: ReactNode;
}

export default function Header({
  title,
  subtitle,
  username,
  onLogout,
  actions
}: HeaderProps) {
  return (
    <div className="header-inner">
      <div className="header-title-block">
        <h1>{title}</h1>
        {subtitle && <p className="header-subtitle">{subtitle}</p>}
      </div>

      <div className="header-actions">
        {actions}

        <span className="signed-in-user">
          Signed in as <strong>{username}</strong>
        </span>

        <button className="secondary-button" type="button" onClick={onLogout}>
          Log Out
        </button>
      </div>
    </div>
  );
}
