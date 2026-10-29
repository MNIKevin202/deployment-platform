# ClovaForge UI Overhaul — Progress

> Persistent progress tracker for the autonomous Phase 2–9 visual overhaul.
> Updated as work lands so state is recoverable if the session is interrupted.
> **Scope:** frontend visual redesign only. No backend/API/schema/Docker/auth
> changes, no production deploy/release. Production stays on **1.6.1**.

## Design language (established Phase 1)
- Dark-first tokens in `:root` (App.css): `--color-bg #0a0e17`, surfaces
  `--color-surface`/`-raised`/`-3`, borders `-border`/`-soft`/`-hair`, text
  `-text`/`-muted`/`-faint`, accent `--color-accent #6f74f2`/`-accent-2`,
  semantic success/warning/danger (+`-bg`), radii `--radius-sm..xl`, spacing
  `--s1..s7`, type scale `--text-xs..2xl`, `--shadow-sm/-card/-pop`.
- Shared components: `Icon`, `SectionHeader` (icon+eyebrow+title+actions),
  `StatCard`, `StatusBadge`, `Tabs`, `Notice`, `ConfirmationDialog`, `.panel`.
- Page shell: `.page` > `SectionHeader` + `.panel` sections. Collapsible sidebar.

## Phase status
- [x] **Phase 1** — Foundation + Overview command center. Released **1.6.1**.
- [~] **Phase 2 — Applications** (in progress)
  - [x] AppsPage header → `SectionHeader`
  - [x] AppCard: drop noisy neutral "Health Unknown" badge
  - [ ] Control bar (search/sort/filter chips) refinement
  - [ ] Status badges consistency (StatusBadge component)
  - [ ] Grid/table views, bulk-action bar, empty/loading/error states
- [ ] **Phase 3 — Application Details** (AppDetail + panels/tabs)
- [ ] **Phase 4 — Resources** (ResourcesPage/Section, Connections, databases, storage)
- [ ] **Phase 5 — Automation** (CronPage)
- [ ] **Phase 6 — Platform & Settings** (Platform/Settings/System + panels; native confirm → ConfirmationDialog)
- [ ] **Phase 7 — Create App Wizard & Templates**
- [ ] **Phase 8 — Global polish & CSS consolidation**
- [ ] **Phase 9 — Visual QA** (mock-data harness, viewports 1920×1080/1440×900/1280×800/mobile)

## Decisions log
- Build on the existing Phase-1 tokens/components; refine shared primitives
  rather than per-page one-offs.
- Visual QA via an isolated Vite mock-data harness (real components + mock
  props) opened in Chrome — the built-in browser cannot open localhost, and the
  full backend is not run locally. Mock-data QA is labelled as such; no live
  verification is claimed unless done against a running stack.

## Testing results (latest)
- Build: clean. Web tests: 557/557 passing (pre-Phase-2-completion baseline).

## Commits
- (tracked below as phases land)
