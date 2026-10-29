# ClovaForge UI Overhaul — Progress

> Persistent tracker for the Phase 2–9 visual overhaul.
> **Scope:** frontend visual redesign only. No backend/API/schema/Docker/auth
> changes, no production deploy/release. Production stays on **1.6.1**.
> Work is committed + pushed to **main** (CI builds/tests only; release is
> tag-triggered and was NOT run).

## Design language (established Phase 1)
- Dark-first tokens in `:root` (App.css): colors (`--color-bg`, surfaces,
  borders, text, accent, semantic success/warning/danger + `-bg`), radii,
  spacing, type scale, shadows.
- Shared components: `Icon` (now a full line-icon set), `SectionHeader`
  (icon + eyebrow + title + **description** + actions), `StatCard`,
  `StatusBadge`, `Tabs`, `Notice`, `ConfirmationDialog`, `useConfirm`, `.panel`.
- Page shell: `.page` > `SectionHeader` + `.panel`/`.page-section`. Collapsible
  sidebar. `.metrics-grid` (now self-sufficient), `.container-grid`.

## Phase status
- [x] **Phase 1** — Foundation + Overview command center. Released **1.6.1**.
- [x] **Phase 2 — Applications**
  - AppsPage header → SectionHeader; de-cluttered AppCard (dropped noisy neutral
    "Health Unknown" badge); control bar / chips / grid / table / bulk-action
    bar / empty states already on the Phase-1 token system (verified in harness).
- [x] **Phase 3 — Application Details** (consistency pass)
  - Panel section headers unified; sub-page headers (Connections/Environment/
    Repositories) converted. AppDetail shell/tabs already on the token system.
  - NOTE: AppDetail's per-tab content (logs, env table, history, metrics) was
    NOT deep-redesigned — it renders with existing token styling and could not
    be QA'd live (no local backend). See Limitations.
- [x] **Phase 4 — Resources** — Connections / Global variables / Repositories /
  Repository detail headers → SectionHeader + icons.
- [x] **Phase 5 — Automation** — Cron page header → SectionHeader + icon.
  (Cron job list/modals render on existing token styling.)
- [x] **Phase 6 — Platform & Settings**
  - All six settings panels + System (Internet/Docker/Platform Services) +
    Platform Updates headers → SectionHeader + icons.
  - Native `window.confirm` (4 flows) → styled `ConfirmationDialog` via a new
    promise-based `useConfirm()` hook.
- [x] **Phase 7 — Create App Wizard & Templates**
  - Wizard widened 760→960px, centred reading column, more breathing room,
    centred step rail. (Deeper vertical-rail restructure deferred — see below.)
- [x] **Phase 8 — Global polish & CSS consolidation** (targeted)
  - `.metrics-grid` made self-sufficient (display:grid); section headers stack
    on ≤720px; expanded shared icon vocabulary. Full CSS de-duplication of the
    legacy override blocks was intentionally NOT attempted (high risk, low
    visible gain) — see Limitations.
- [x] **Phase 9 — Visual QA** — Isolated mock-data harness built + reviewed at
  desktop (1568px capture). Fixed issues found. Mobile verified from CSS only
  (Chrome capture is fixed-width; see Limitations).

## Decisions log
- Shared-primitive-first: refine/apply shared components + tokens app-wide
  rather than bespoke per-page restyles, for one cohesive system.
- Settings/panel headers converted via a CRLF-tolerant codemod (scratchpad),
  each verified by build + tests.
- Dialog/modal headers (with close buttons) and two dynamic-title action headers
  left on `.section-heading` (already consistent; low gain / higher risk).
- Visual QA via `apps/web/harness.html` (served at `/harness.html` by the dev
  server) rendering real components with MOCK data. This is mock-data QA, not
  live verification.

## Limitations (honest)
- **Mobile render not verified live.** Claude-in-Chrome's screenshot capture
  stays at the desktop width regardless of `resize_window`, and the built-in
  browser cannot open localhost. Responsive behaviour (auto-fill grids, health
  hero wrap, section-header stacking at ≤720px) was reviewed and hardened in CSS
  but not rendered at phone width.
- **Data-dense surfaces not deep-redesigned / not live-QA'd:** AppDetail tab
  content, EnvVarTable/StorageTable, HistoryPanel, LogViewer/ConsolePanel, cron
  job lists. They inherit the token system and shared headers but a full local
  stack (API + seeded DB) would be needed to redesign + verify them safely.
- **Wizard** got a spacious CSS treatment, not a full vertical-rail JSX rebuild
  (that 3045-line component is high-risk to restructure blind).
- **CSS** still has the layered override sections from Phase 1; a full
  consolidation was deferred to avoid regressions in surfaces that can't be
  live-QA'd.

## Testing results
- Build (`tsc -b && vite build`): clean after every phase.
- Web tests (`vitest run`): **557/557 passing** after every phase. No tests
  weakened or deleted; no behaviour changes.

## Commits (on main, pushed)
- c0af692 Phase 2 (Apps) wip: SectionHeader header + de-clutter cards
- 15b442d unify section headers + expand icon set across pages
- f2140cd Phase 6: replace native window.confirm with styled dialog
- 6d7995f Phase 7 + 9: spacious wizard, QA harness, responsive fixes
- c296a4f Phase 6: SectionHeader + icons on settings panels
- 0d7fb45 SectionHeader + icons on Repository detail & Platform updates
- (plus 81cc764 = the 1.6.1 Phase-1 fix release, pre-overhaul)

## How to review
1. `cd apps/web && npm run dev`, open `http://localhost:3000/harness.html`
   (or the port it prints) for the mock-data design-system gallery.
2. Review the diff on `main` since `799e194` (pre-1.6.1) / `81cc764` (1.6.1).
3. To see live pages with real data, run the full stack locally or apply a
   release to a non-production/staging box — production is deliberately left on
   1.6.1.

## Recommended release procedure (when approved)
- Bump `version` in `package.json`, `apps/api/package.json`, `apps/web/package.json`
  (e.g. to `1.7.0`), commit, then push tag `v1.7.0` to trigger the publish
  workflow (same path as 1.6.1). Apply to production via Platform → Updates →
  Update now when ready.
