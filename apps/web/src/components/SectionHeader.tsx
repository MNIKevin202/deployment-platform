import type { ReactNode } from "react";

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  icon?: ReactNode;
  /** Optional supporting copy rendered under the title. */
  description?: ReactNode;
  actions?: ReactNode;
}

/** Consistent section header: optional icon, an eyebrow label, a title, an
 *  optional description, and a right-aligned actions slot. Reuses the existing
 *  .section-heading styling. */
export default function SectionHeader({
  eyebrow,
  title,
  icon,
  description,
  actions
}: SectionHeaderProps) {
  return (
    <div className="section-heading">
      <div className="section-heading-main">
        {icon && (
          <span className="section-heading-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div className="section-heading-text">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
          {description && <p className="section-heading-desc">{description}</p>}
        </div>
      </div>
      {actions && <div className="section-heading-actions">{actions}</div>}
    </div>
  );
}
