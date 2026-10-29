/**
 * Visual QA harness — renders the redesigned presentational surfaces with
 * MOCK data (no backend). Served by the dev server at /harness.html. This is
 * mock-data visual validation, NOT live verification of real operational data.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../App.css";
import Icon from "../components/Icon";
import SectionHeader from "../components/SectionHeader";
import StatCard from "../components/StatCard";
import StatusBadge from "../components/StatusBadge";
import AppTile from "../components/AppTile";
import Tabs from "../components/Tabs";
import type { ContainerSummary, StoredApp } from "../types/api";

const noop = () => {};

function container(partial: Partial<ContainerSummary>): ContainerSummary {
  return {
    id: "c" + Math.random().toString(36).slice(2),
    shortId: "a1b2c3d4e5f6",
    names: ["/app"],
    image: "ghcr.io/clova/app:latest",
    state: "running",
    status: "Up 2 hours",
    created: Date.now() / 1000,
    ports: [{ PrivatePort: 3000, PublicPort: 8080, Type: "tcp" }],
    labels: { "com.deployment-platform.app-name": "app" },
    isSystemContainer: false,
    isManagedApp: true,
    ...partial
  };
}

function app(partial: Partial<StoredApp>): StoredApp {
  return {
    id: 1,
    name: "app",
    containerId: "c1",
    containerName: "app",
    image: "ghcr.io/clova/app:latest",
    containerPort: 3000,
    domain: "app.example.com",
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: 512,
    cpuLimit: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    lastDeployedAt: "2026-10-20T00:00:00.000Z",
    routingReady: true,
    health: { state: "healthy", lastCheckedAt: "2026-10-29T07:00:00.000Z" },
    latestEventSeverity: "info",
    latestEventType: "deploy_succeeded",
    currentVersion: 12,
    ...partial
  };
}

const cards: { c: ContainerSummary; a: StoredApp }[] = [
  {
    c: container({ names: ["/staxxio-api"] }),
    a: app({ id: 1, name: "staxxio-api", domain: "staxxio.example.com" })
  },
  {
    c: container({ names: ["/clovaperflab"], state: "running", status: "Up 12 days" }),
    a: app({
      id: 2,
      name: "clovaperflab",
      health: { state: "healthy", lastCheckedAt: "2026-10-29T07:10:00.000Z" },
      imageUpdateAvailable: true
    })
  },
  {
    c: container({ names: ["/yumbot"], state: "exited", status: "Exited (0) 3 hours ago" }),
    a: app({
      id: 3,
      name: "yumbot",
      status: "stopped",
      routingReady: false,
      health: null
    })
  },
  {
    c: container({ names: ["/perflab-db"], image: "mongo:7", state: "running", status: "Up 20 days" }),
    a: app({
      id: 4,
      name: "perflab-db",
      image: "mongo:7",
      internalOnly: true,
      domain: null,
      latestEventSeverity: "error",
      latestEventType: "deploy_failed",
      health: { state: "unhealthy", lastCheckedAt: "2026-10-29T06:00:00.000Z" }
    })
  }
];

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <p
        style={{
          font: "800 0.7rem/1 Inter, sans-serif",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#5b6684",
          margin: "0 0 14px"
        }}
      >
        {label}
      </p>
      {children}
    </section>
  );
}

function Harness() {
  return (
    <div className="app-main" style={{ maxWidth: 1240, margin: "0 auto", padding: "32px 24px 80px" }}>
      <h1 style={{ marginTop: 0 }}>ClovaForge — Visual QA Harness</h1>
      <p className="text-faint" style={{ marginTop: -8 }}>
        Mock-data rendering of redesigned components. Not live data.
      </p>

      <Section label="Section headers">
        <SectionHeader eyebrow="Applications" title="All Managed Apps" icon={<Icon name="apps" />} />
        <SectionHeader
          eyebrow="Connections"
          title="Database Connections"
          icon={<Icon name="database" />}
          description="Keep the connection strings for databases you host elsewhere in one place."
          actions={<button className="primary-button compact">Add Connection</button>}
        />
      </Section>

      <Section label="Metric tiles (metrics-grid)">
        <div className="metrics-grid">
          <StatCard label="Apps" value="22" icon={<Icon name="apps" />} />
          <StatCard label="Running" value="21" tone="positive" icon={<Icon name="play" />} hint="of 22" />
          <StatCard label="Stopped" value="1" tone="warning" icon={<Icon name="stop" />} />
          <StatCard label="Routing" value="Healthy" tone="positive" icon={<Icon name="route" />} hint="13 routes" />
          <StatCard label="Docker" value="Connected" tone="positive" icon={<Icon name="docker" />} hint="29.6.2" />
          <StatCard label="Host" value="2 cores" icon={<Icon name="cpu" />} hint="7.8 GB" />
        </div>
      </Section>

      <Section label="Health hero">
        <section className="health-hero tone-warning">
          <span className="health-hero-mark" aria-hidden="true">
            <Icon name="pulse" size={22} />
          </span>
          <div className="health-hero-text">
            <p className="eyebrow">Platform Health</p>
            <span className="health-hero-value">Needs Attention</span>
            <p className="health-hero-sub">1 item needs attention</p>
          </div>
          <div className="health-hero-actions">
            <button className="secondary-button">
              <Icon name="template" /> Templates
            </button>
            <button className="primary-button">
              <Icon name="plus" /> Create App
            </button>
          </div>
        </section>
      </Section>

      <Section label="Status badges & pills">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <StatusBadge label="Healthy" tone="positive" />
          <StatusBadge label="Unhealthy" tone="negative" />
          <StatusBadge label="Update Available" tone="warning" />
          <StatusBadge label="Neutral" tone="neutral" />
          <span className="status-pill running">running</span>
          <span className="status-pill stopped">stopped</span>
        </div>
      </Section>

      <Section label="Tabs">
        <Tabs
          items={[
            { key: "a", label: "Connections" },
            { key: "b", label: "Global variables" },
            { key: "c", label: "GitHub" }
          ]}
          active="a"
          onChange={noop}
        />
      </Section>

      <Section label="Buttons & controls">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
          <button className="primary-button">Primary</button>
          <button className="secondary-button">Secondary</button>
          <button className="danger-button">Danger</button>
          <button className="primary-button compact">Primary compact</button>
          <button className="secondary-button compact">Secondary compact</button>
        </div>
        <div className="apps-filter-row">
          <input className="apps-filter-search" placeholder="Search by name or image..." />
          <select className="apps-filter-sort">
            <option>Sort: Name (A–Z)</option>
          </select>
        </div>
        <div className="apps-filter-chips" style={{ marginTop: 10 }}>
          <button className="apps-filter-chip active">All <span className="apps-filter-chip-count">22</span></button>
          <button className="apps-filter-chip">Running <span className="apps-filter-chip-count">21</span></button>
          <button className="apps-filter-chip">Stopped <span className="apps-filter-chip-count">1</span></button>
          <button className="apps-filter-chip">Favorites <span className="apps-filter-chip-count">3</span></button>
        </div>
      </Section>

      <Section label="Apps hero (redesigned header)">
        <header className="apps-hero">
          <div className="apps-hero-left">
            <span className="apps-hero-icon" aria-hidden="true">
              <Icon name="apps" size={24} />
            </span>
            <div className="apps-hero-headings">
              <p className="eyebrow">Applications</p>
              <h2 className="apps-hero-title">All Managed Apps</h2>
              <p className="apps-hero-sub">
                <strong>28</strong> apps
                <span className="apps-hero-sep" aria-hidden="true">•</span>
                <span className="apps-hero-stat running">21 running</span>
                <span className="apps-hero-sep" aria-hidden="true">•</span>
                <span className="apps-hero-stat stopped">7 stopped</span>
              </p>
            </div>
          </div>
          <div className="apps-hero-actions">
            <div className="view-toggle" role="group" aria-label="Layout">
              <button className="active" type="button"><Icon name="grid" size={16} /> Grid</button>
              <button type="button"><Icon name="list" size={16} /> Table</button>
            </div>
            <button className="secondary-button"><Icon name="template" size={16} /> Templates</button>
            <button className="primary-button"><Icon name="plus" size={16} /> Create App</button>
          </div>
        </header>
        <div className="apps-search" style={{ maxWidth: 420 }}>
          <Icon name="search" size={16} className="apps-search-icon" />
          <input className="apps-filter-search" placeholder="Search apps by name or image…" />
        </div>
      </Section>

      <Section label="App tiles (redesigned board)">
        <div className="apps-board">
          {cards.map(({ c, a }) => (
            <AppTile
              key={a.id}
              container={c}
              storedApp={a}
              actionLoading={null}
              onAction={noop}
              onOpenLogs={noop}
              onDeleteApp={noop}
              onViewApp={noop}
              onToggleFavorite={noop}
              onToggleSelected={noop}
            />
          ))}
        </div>
      </Section>

      <Section label="Empty state">
        <div className="empty-state app-empty-state">
          <h3>No managed apps yet</h3>
          <p>Deploy your first application from a Docker image.</p>
          <button className="primary-button">Deploy First App</button>
        </div>
      </Section>

      <Section label="Wizard stepper (static)">
        <div className="wizard-steps" style={{ borderRadius: 12, border: "1px solid var(--color-border-soft)" }}>
          {["Basics", "Source", "Configure", "Domain", "Review"].map((label, i) => (
            <div key={label} className={`wizard-step-item ${i === 2 ? "active" : i < 2 ? "done" : ""}`}>
              <span className="wizard-step-index">{i < 2 ? "✓" : i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

createRoot(document.getElementById("harness-root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
