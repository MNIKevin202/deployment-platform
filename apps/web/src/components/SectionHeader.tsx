import type { ReactNode } from "react";

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
}

/** Consistent section header: optional icon, an eyebrow label, a title, and a
 *  right-aligned actions slot. Reuses the existing .section-heading styling. */
export default function SectionHeader({ eyebrow, title, icon, actions }: SectionHeaderProps) {
  return (
    <div className="section-heading">
      <div className="section-heading-main">
        {icon && (
          <span className="section-heading-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
      </div>
      {actions && <div className="section-heading-actions">{actions}</div>}
    </div>
  );
}
