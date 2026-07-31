import { useEffect } from "react";
import { APP_TEMPLATES, type AppTemplate, type TemplateCategory } from "../lib/appTemplates";

interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
  onSelect: (template: AppTemplate) => void;
}

const CATEGORIES: TemplateCategory[] = ["Databases", "Tools"];

export default function TemplateGallery({ open, onClose, onSelect }: TemplateGalleryProps) {
  // Escape still closes; clicking the backdrop deliberately does not, so a
  // stray click can't discard the selection.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="form-modal wide template-gallery" role="dialog" aria-modal="true" aria-label="App templates">
        <header>
          <div>
            <p className="eyebrow">New app</p>
            <h2>One-click templates</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="dialog-description">
          Pick a service to pre-fill the Create App wizard — image, port, environment (with generated
          passwords where needed), and storage. You can adjust everything before creating.
        </p>

        <div className="template-gallery-body">
          {CATEGORIES.map((category) => {
            const items = APP_TEMPLATES.filter((template) => template.category === category);
            if (items.length === 0) {
              return null;
            }

            return (
              <div key={category} className="template-category">
                <h3>{category}</h3>
                <div className="template-grid">
                  {items.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="template-card"
                      onClick={() => onSelect(template)}
                    >
                      <span className="template-icon" aria-hidden="true">
                        {template.icon}
                      </span>
                      <span className="template-card-body">
                        <span className="template-name">{template.name}</span>
                        <span className="template-desc">{template.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
