# Changelog

All notable changes to Compendlore CMS are recorded in this file. Entries remain under `Unreleased`
until the release manager assigns a version and publication date.

## [Unreleased]

### Added

- Established the Encore.ts backend, React frontends, TypeScript 6 workspaces, and shared Sass
  presentation foundation.
- Added the Core security foundation, durable extension event stream, private security kernel,
  protected installation flow, and Core-owned persistence.
- Added the CMS Registry contribution contracts, declarative schema engine, statistics contracts,
  messaging contracts, and persistent messaging schema.
- Added the API gateway, real-time communication contracts, secure external connectors, and separate
  public and administrative frontend entry points on one development origin.
- Added Docker deployment support and reproducible repository quality checks.
- Added the bilingual community code of conduct, governance policy, and trademark policy from the
  repository’s initial revision.
- Added fail-closed security policy resolution, Ed25519 instance identity, reliable outbox dispatch,
  typed theme contracts, and automated dependency maintenance.
- Added the Phase 9 native vertical slice: Core localization, entity, navigation, sidebar and page
  catalogs; Registry materialization and lifecycle; PostgreSQL structural catalogs; and resolved API
  projections for the public and administrative React applications.
- Added the required abstract `entity` root with inherited identity and editorial fields, native
  home and administration navigation, and an administrative contribution-inspection view.
- Added the Phase 10 page engine with typed routes, aliases, contextual pages, versioned contracts,
  responsive grid documents, atomic publication workflows, and Core-owned structural persistence.
- Added generic React page hosts and an administrative page inspector with responsive preview,
  keyboard movement, and keyboard resizing.
- Added stable dynamic API transports with per-endpoint contract negotiation, typed request
  parameters, deprecation metadata, and a 2FA-protected administration audience.

### Changed

- Extracted the public addon SDK contracts into the standalone `compendlore-addon-sdk` repository.
- Navigation is sourced from dedicated registries instead of hard-coded frontend entries.
- Internal architecture, planning, and audit documents are maintained in the workspace documentation
  tree instead of this repository.
- Repository Markdown is limited to useful operational files, written in English first and French
  second; this changelog remains English-only.
- Isolated Encore runtime adapters from testable database and catalog contracts.
- Navigation now references stable route identifiers and validated parameters while the page
  registry remains the single source of canonical browser URLs.

### Fixed

- Renamed the measurement-unit persistence offset column to avoid the reserved PostgreSQL `OFFSET`
  keyword during fresh database migrations.
- Made API body limits compatible with Encore's compile-time requirements.
- Separated contribution deployment history from the declarative schema journal.
- Unified public and administrative development access without running a second Vite port.
- Kept frontend and backend origins strictly separate: `/api/*` is requested directly from Encore
  and is never exposed by the frontend server.
- Composed the native site catalog during Encore API startup instead of leaving its endpoint
  permanently unavailable.
- Overrode the vulnerable transitive KaTeX version.

### Release notes

- No public version has been released yet.
- Database migrations currently cover Core-owned infrastructure only.
