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
- Added a private Encore object bucket, external secret references, and a PostgreSQL-backed task
  queue for the Core infrastructure services.
- Added cryptographic checksums and signatures to the durable Core event stream, with validation of
  event ordering, idempotency, consumer cursors, retention, and deactivation.
- Added prepared Registry contribution types for themes, routes, pages, popups, products, and
  commercial entitlements without exposing their future private implementations.
- Added the bilingual community code of conduct, governance policy, and trademark policy from the
  repository’s initial revision.
- Connected Security Kernel decisions to the durable Core security-attempt store without retaining
  raw subject or resource identifiers.
- Added a stable Ed25519 instance identity, protected private-key storage, public Core persistence,
  drift detection, and bounded proof-of-possession challenges.

### Changed

- Centralized the contribution-type inventory so validation and catalog projection cannot drift
  apart as new Registry types are introduced.
- Hardened runtime validation for statistics and communication contracts, including every enum,
  localized purpose, delivery constraint, acknowledgement rule, and payload field definition.
- Extracted the public addon SDK contracts into the standalone `compendlore-addon-sdk` repository.
- Navigation is sourced from dedicated registries instead of hard-coded frontend entries.
- Internal architecture, planning, and audit documents are maintained in the workspace documentation
  tree instead of this repository.
- Repository Markdown is limited to useful operational files, written in English first and French
  second; this changelog remains English-only.

### Fixed

- Required every registered-method execution to cross the Core authorization port and restricted
  cross-layer imports to declared public entrypoints.
- Completed Registry lifecycle recovery so withdrawn contributions can be reinstalled,
  reconciliation rejects same-version drift, downgrades and duplicate declarations, and invalid
  transitions fail.
- Prevented Registry updates from invalidating active dependency graphs, exposed separate activation
  and withdrawal blockers, and corrected caret compatibility for pre-1.0 semantic versions.
- Hardened registered-method dispatch with handler validation, bounded input-aware idempotency,
  normalized contract failures, cooperative timeout cancellation, and transaction verification.
- Isolated stored Registry contributions from caller-owned object references and protected Core and
  extension ownership across every read and write boundary.
- Enforced contribution, owner, withdrawal, replacement, capability, configuration-value, and
  translation contracts at runtime before Registry persistence.
- Added an explicit architecture check for the Encore Registry service, its TypeScript workspace,
  its Core port, and its prohibition from owning PostgreSQL resources.
- Connected the Encore runtime to the Core bootstrap, persistent instance identity, structured logs,
  database supervision, bounded shutdown, and truthful readiness checks.
- Added repeatable validation for the applied Core schema, its foundational constraints, indexes,
  relationships, and transaction rollback.
- Bound CSRF protection and login limits to authenticated sessions, made logout idempotent, and
  completed security auditing for login, second-factor, and administrative access decisions.
- Made API body limits compatible with Encore's compile-time requirements.
- Made Security Kernel evidence authentic, operation-bound, resource-bound, expiring, and single-use
  so a reconstructed or replayed proof is rejected.
- Separated contribution deployment history from the declarative schema journal.
- Unified public and administrative development access without running a second Vite port.
- Overrode the vulnerable transitive KaTeX version.

### Release notes

- No public version has been released yet.
- Database migrations currently cover Core-owned infrastructure only.
