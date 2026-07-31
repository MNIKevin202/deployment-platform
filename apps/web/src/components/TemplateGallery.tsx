import { useEffect, useState } from "react";
import { templatesInCategory, type AppTemplate, type TemplateCategory } from "../lib/appTemplates";
import {
  findInstalledTemplateApp,
  requiredDatabaseStatus,
  type InstalledTemplateMatch,
  type RequiredDatabaseStatus
} from "../lib/templateInstallStatus";

interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
  onSelect: (template: AppTemplate) => void;
  /** Existing apps, used to detect a template that's already installed. */
  storedApps: ReadonlyArray<{ id: number; name: string; image: string }>;
  /** Closes the gallery and navigates to the given app's detail page. */
  onViewApp: (appId: number) => void;
}

const CATEGORIES: TemplateCategory[] = ["Databases", "Apps", "Tools"];

function envSummary(env: AppTemplate["env"][number]): string {
  if (env.generate === "password") {
    return "auto-generated";
  }
  if (env.value) {
    return env.value;
  }
  return "set at install";
}

export default function TemplateGallery({
  open,
  onClose,
  onSelect,
  storedApps,
  onViewApp
}: TemplateGalleryProps) {
  const [selected, setSelected] = useState<AppTemplate | null>(null);

  // Escape backs out of the detail view first, then closes. Clicking the
  // backdrop deliberately does nothing, so a stray click can't discard things.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setSelected((current) => {
        if (current) {
          return null;
        }
        onClose();
        return null;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset the detail view whenever the gallery is reopened.
  useEffect(() => {
    if (!open) {
      setSelected(null);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const selectedMatch = selected ? findInstalledTemplateApp(selected, storedApps) : null;
  const selectedDbStatus = selected ? requiredDatabaseStatus(selected, storedApps) : null;

  return (
    <div className="modal-backdrop">
      <section className="form-modal wide template-gallery" role="dialog" aria-modal="true" aria-label="App templates">
        <header>
          <div>
            <p className="eyebrow">New app</p>
            <h2>{selected ? selected.name : "One-click templates"}</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {selected ? (
          <TemplateDetail
            template={selected}
            installedMatch={selectedMatch}
            dbStatus={selectedDbStatus}
            onBack={() => setSelected(null)}
            onInstall={() => onSelect(selected)}
            onViewApp={onViewApp}
            onSelectTemplate={setSelected}
          />
        ) : (
          <>
            <p className="dialog-description">
              Pick a service to see what it sets up, then install to pre-fill the Create App wizard —
              image, port, environment (with generated passwords where needed), and storage.
            </p>

            <div className="template-gallery-body">
              {CATEGORIES.map((category) => {
                const items = templatesInCategory(category);
                if (items.length === 0) {
                  return null;
                }

                return (
                  <div key={category} className="template-category">
                    <h3>{category}</h3>
                    <div className="template-grid">
                      {items.map((template) => {
                        const installed = findInstalledTemplateApp(template, storedApps) !== null;
                        return (
                          <button
                            key={template.id}
                            type="button"
                            className="template-card"
                            onClick={() => setSelected(template)}
                          >
                            {installed && <span className="template-installed-badge">Installed</span>}
                            <span className="template-icon" aria-hidden="true">
                              {template.icon}
                            </span>
                            <span className="template-card-body">
                              <span className="template-name">{template.name}</span>
                              <span className="template-desc">{template.description}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

interface TemplateDetailProps {
  template: AppTemplate;
  installedMatch: InstalledTemplateMatch | null;
  dbStatus: RequiredDatabaseStatus | null;
  onBack: () => void;
  onInstall: () => void;
  onViewApp: (appId: number) => void;
  onSelectTemplate: (template: AppTemplate) => void;
}

function TemplateDetail({
  template,
  installedMatch,
  dbStatus,
  onBack,
  onInstall,
  onViewApp,
  onSelectTemplate
}: TemplateDetailProps) {
  return (
    <>
      <div className="template-detail-body">
        {installedMatch && (
          <div className="template-installed-banner">
            <span>
              Already installed as <strong>{installedMatch.appName}</strong>.
            </span>
            <button type="button" className="secondary-button compact" onClick={() => onViewApp(installedMatch.appId)}>
              View App
            </button>
          </div>
        )}

        {dbStatus && !dbStatus.installed && (
          <div className="template-warning-banner">
            <span>
              ⚠ This needs a <strong>{dbStatus.template.name}</strong> app running first — none was found. Install
              it, then match this template's database password to what it generates.
            </span>
            <button
              type="button"
              className="secondary-button compact"
              onClick={() => onSelectTemplate(dbStatus.template)}
            >
              Set up {dbStatus.template.name}
            </button>
          </div>
        )}

        <div className="template-detail-hero">
          <span className="template-icon large" aria-hidden="true">
            {template.icon}
          </span>
          <div>
            <span className="template-detail-category">{template.category}</span>
            <p className="template-detail-blurb">{template.longDescription}</p>
          </div>
        </div>

        {template.highlights.length > 0 && (
          <ul className="template-highlights">
            {template.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        )}

        <div className="template-detail-section">
          <h4>Configuration</h4>
          <dl className="template-detail-specs">
            <div>
              <dt>Image</dt>
              <dd>
                <code>{template.image}</code>
              </dd>
            </div>
            <div>
              <dt>Container port</dt>
              <dd>{template.containerPort}</dd>
            </div>
            <div>
              <dt>Suggested name</dt>
              <dd>
                <code>{template.suggestedName}</code>
              </dd>
            </div>
          </dl>
        </div>

        <div className="template-connect">
          <span className="template-connect-label">Reachable from your other apps at</span>
          <code>
            app-{template.suggestedName}:{template.containerPort}
          </code>
          <span className="template-connect-note">The hostname follows the app name you choose.</span>
        </div>

        {template.env.length > 0 && (
          <div className="template-detail-section">
            <h4>Environment</h4>
            <ul className="template-detail-list">
              {template.env.map((env) => (
                <li key={env.key}>
                  <code>{env.key}</code>
                  <span className="template-detail-envvalue">{envSummary(env)}</span>
                  {env.secret && <span className="template-badge">secret</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {template.volumes && template.volumes.length > 0 && (
          <div className="template-detail-section">
            <h4>Persistent storage</h4>
            <ul className="template-detail-list">
              {template.volumes.map((volume) => (
                <li key={volume}>
                  <code>{volume}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="template-detail-actions">
        <button type="button" className="secondary-button" onClick={onBack}>
          ← Back
        </button>
        <button type="button" className="primary-button" onClick={onInstall}>
          Install {template.name}
        </button>
      </div>
    </>
  );
}
