import { useEffect, useState } from "react";
import {
  companionAppName,
  templatesInCategory,
  type AppTemplate,
  type TemplateCategory
} from "../lib/appTemplates";
import {
  findInstalledTemplateApp,
  requiredDatabaseStatus,
  type InstalledTemplateMatch,
  type RequiredDatabaseStatus
} from "../lib/templateInstallStatus";
import { assessHostForTemplate, formatGb } from "../lib/templateResources";

interface TemplateGalleryProps {
  /** `model` is set only for templates that offer a first model download. */
  onSelect: (template: AppTemplate, options?: { model?: string | null }) => void;
  /** Existing apps, used to detect a template that's already installed. */
  storedApps: ReadonlyArray<{ id: number; name: string; image: string }>;
  /** Closes the gallery and navigates to the given app's detail page. */
  onViewApp: (appId: number) => void;
  /** Host CPU/memory, used to warn when a template needs more than there is. */
  hostInfo?: { cpuCount: number; memoryTotalBytes: number } | null;
}

// Exclusive Apps leads the list: it holds the platform's own first-party
// templates (Blueprint, CanvasMint, SitePhotos).
const CATEGORIES: TemplateCategory[] = ["Exclusive Apps", "Databases", "Apps", "Tools"];

function envSummary(env: AppTemplate["env"][number]): string {
  if (env.generate === "password") {
    return "auto-generated";
  }
  if (env.value) {
    return env.value;
  }
  return "set at install";
}

/** The icon artwork for a card, preferring a first-party image over the emoji. */
function TemplateIcon({ template, large }: { template: AppTemplate; large?: boolean }) {
  if (template.iconImage) {
    return (
      <img
        className={`template-icon-image${large ? " large" : ""}`}
        src={template.iconImage}
        alt=""
        aria-hidden="true"
        loading="lazy"
      />
    );
  }

  return (
    <span className={`template-icon${large ? " large" : ""}`} aria-hidden="true">
      {template.icon}
    </span>
  );
}

export default function TemplateGallery({
  onSelect,
  storedApps,
  onViewApp,
  hostInfo
}: TemplateGalleryProps) {
  const [selected, setSelected] = useState<AppTemplate | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | null>(null);

  // Escape backs out of the detail view to the list. As a page (rather than a
  // modal) there is nothing to close beyond that.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedMatch = selected ? findInstalledTemplateApp(selected, storedApps) : null;
  const selectedDbStatus = selected ? requiredDatabaseStatus(selected, storedApps) : null;

  const query = search.trim().toLowerCase();
  const matchesQuery = (template: AppTemplate) =>
    query === "" ||
    template.name.toLowerCase().includes(query) ||
    template.description.toLowerCase().includes(query);

  // Counts are per-category over the search results, so a chip's number
  // always reflects what clicking it would actually show.
  const visibleByCategory = new Map<TemplateCategory, AppTemplate[]>(
    CATEGORIES.map((category) => [category, templatesInCategory(category).filter(matchesQuery)])
  );
  const totalVisible = CATEGORIES.reduce(
    (sum, category) => sum + (visibleByCategory.get(category)?.length ?? 0),
    0
  );
  const shownCategories = CATEGORIES.filter(
    (category) => activeCategory === null || activeCategory === category
  );

  if (selected) {
    return (
      <div className="page">
        <section className="page-section template-gallery-page">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Template</p>
              <h2>{selected.name}</h2>
            </div>
            <button className="secondary-button compact" type="button" onClick={() => setSelected(null)}>
              ← All templates
            </button>
          </div>

          <TemplateDetail
            template={selected}
            installedMatch={selectedMatch}
            dbStatus={selectedDbStatus}
            hostInfo={hostInfo}
            onBack={() => setSelected(null)}
            onInstall={(model) => onSelect(selected, { model })}
            onViewApp={onViewApp}
            onSelectTemplate={setSelected}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="page-section template-gallery-page">
        <div className="section-heading">
          <div>
            <p className="eyebrow">New app</p>
            <h2>One-click templates</h2>
          </div>
        </div>

        <p className="text-faint">
          Pick a service to see what it sets up, then install to pre-fill the Create App wizard —
          image, port, environment (with generated passwords where needed), and storage.
        </p>

        <div className="apps-filter-row">
          <input
            className="apps-filter-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search templates..."
            aria-label="Search templates"
          />
          <span className="apps-filter-count text-faint">
            {totalVisible} template{totalVisible === 1 ? "" : "s"}
          </span>
        </div>

        <div className="apps-filter-pill-row">
          <div className="apps-filter-chips" role="group" aria-label="Template categories">
            <button
              type="button"
              className={`apps-filter-chip ${activeCategory === null ? "active" : ""}`}
              aria-pressed={activeCategory === null}
              onClick={() => setActiveCategory(null)}
            >
              All <span className="apps-filter-chip-count">{totalVisible}</span>
            </button>
            {CATEGORIES.map((category) => (
              <button
                key={category}
                type="button"
                className={`apps-filter-chip ${activeCategory === category ? "active" : ""}`}
                aria-pressed={activeCategory === category}
                onClick={() => setActiveCategory(category)}
              >
                {category}{" "}
                <span className="apps-filter-chip-count">
                  {visibleByCategory.get(category)?.length ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>

        {totalVisible === 0 ? (
          <div className="empty-state">
            <h3>No templates match "{search}"</h3>
            <p>Try a different search term, or pick another category.</p>
          </div>
        ) : (
          <>
            <div className="template-gallery-body">
              {shownCategories.map((category) => {
                const items = visibleByCategory.get(category) ?? [];
                if (items.length === 0) {
                  return null;
                }

                return (
                  <div key={category} className="template-category">
                    <h3>
                      {category} <span className="template-category-count">{items.length}</span>
                    </h3>
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
                            <TemplateIcon template={template} />
                            <span className="template-card-body">
                              <span className="template-name">{template.name}</span>
                              {template.badge && (
                                <span className="template-original-badge">{template.badge}</span>
                              )}
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
  hostInfo?: { cpuCount: number; memoryTotalBytes: number } | null;
  onBack: () => void;
  onInstall: (model: string | null) => void;
  onViewApp: (appId: number) => void;
  onSelectTemplate: (template: AppTemplate) => void;
}

/** "Install without a model" — the explicit opt-out in the model picker. */
const NO_MODEL = "";

function TemplateDetail({
  template,
  installedMatch,
  dbStatus,
  hostInfo,
  onBack,
  onInstall,
  onViewApp,
  onSelectTemplate
}: TemplateDetailProps) {
  const modelChoices = template.modelChoices ?? [];
  // Default to the entry marked "(recommended)" when there is one, so the
  // common path is one click.
  const [model, setModel] = useState<string>(() => {
    const recommended = modelChoices.find((choice) =>
      choice.label.toLowerCase().includes("recommended")
    );
    return recommended?.id ?? modelChoices[0]?.id ?? NO_MODEL;
  });

  const assessment = assessHostForTemplate(template.resources, hostInfo);
  const selectedChoice = modelChoices.find((choice) => choice.id === model) ?? null;

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
          <TemplateIcon template={template} large />
          <div>
            <span className="template-detail-category">
              {template.category}
              {template.badge && (
                <span className="template-original-badge">{template.badge}</span>
              )}
            </span>
            <p className="template-detail-blurb">{template.longDescription}</p>
          </div>
        </div>

        {template.warning && (
          <div className="template-warning-banner">
            <span>⚠ {template.warning}</span>
          </div>
        )}

        {assessment && assessment.shortfalls.length > 0 && (
          <div className={assessment.belowMinimum ? "error-banner" : "warning-banner"}>
            {assessment.belowMinimum
              ? `This server is below the minimum this template asks for: ${assessment.shortfalls.join("; ")}. You can still install it, but expect it to run poorly or fail to start.`
              : `This server meets the minimum but not the recommendation: ${assessment.shortfalls.join("; ")}.`}
          </div>
        )}

        {template.highlights.length > 0 && (
          <ul className="template-highlights">
            {template.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        )}

        {template.resources && (
          <div className="template-detail-section">
            <h4>Server requirements</h4>
            <dl className="template-detail-specs">
              <div>
                <dt>Minimum</dt>
                <dd>
                  {template.resources.minCpu} vCPU · {formatGb(template.resources.minMemoryMb)} RAM ·{" "}
                  {template.resources.minDiskGb} GB storage
                </dd>
              </div>
              <div>
                <dt>Recommended</dt>
                <dd>
                  {template.resources.recommendedCpu}+ vCPU ·{" "}
                  {formatGb(template.resources.recommendedMemoryMb)} RAM ·{" "}
                  {template.resources.recommendedDiskGb} GB storage
                </dd>
              </div>
            </dl>
          </div>
        )}

        {template.companions && template.companions.length > 0 && (
          <div className="template-detail-section">
            <h4>Services this installs</h4>
            <ul className="template-detail-list template-service-list">
              <li>
                <code>app-{template.suggestedName}</code>
                <span className="template-detail-envvalue">
                  {template.name} — public HTTPS domain
                </span>
              </li>
              {template.companions.map((companion) => (
                <li key={companion.key}>
                  <code>app-{companionAppName(template.suggestedName, companion)}</code>
                  <span className="template-detail-envvalue">
                    {companion.label} —{" "}
                    {(companion.internalOnly ?? true) ? "internal only" : "public"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="section-description">
              Each is created as a managed app of its own, so it appears on the Apps page and
              can be inspected, backed up, and deleted like anything else here.
            </p>
          </div>
        )}

        {modelChoices.length > 0 && (
          <div className="template-detail-section">
            <h4>First model</h4>
            <label>
              <span className="sr-only">Model to download after install</span>
              <select
                className="wizard-select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                aria-label="Model to download after install"
              >
                {modelChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label} · {choice.sizeLabel}
                  </option>
                ))}
                <option value={NO_MODEL}>Don't download a model now</option>
              </select>
            </label>
            <p className="section-description">
              {selectedChoice
                ? selectedChoice.note
                  ? `${selectedChoice.note} The download starts after deployment and runs in the background — the app is usable while it runs, and you can change or add models later.`
                  : "The download starts after deployment and runs in the background — the app is usable while it runs, and you can change or add models later."
                : "No model will be downloaded. You can pick one from the app's Blueprint tab whenever you're ready — nothing will work until at least one model is installed."}
            </p>
          </div>
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
        <button
          type="button"
          className="primary-button"
          onClick={() => onInstall(model === NO_MODEL ? null : model)}
        >
          Install {template.name}
        </button>
      </div>
    </>
  );
}
