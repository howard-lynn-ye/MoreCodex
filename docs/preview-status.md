# MoreCodex preview status

Release: **0.1.0-preview**, source preview, 2026-09-22.

## Release scope

The source includes bridge extensions, launcher and build tooling for review and testing. It is not a declaration that every account, model, browser or operating system passes end-to-end acceptance. No MoreCodex binary installer is published with this source preview.

The development launcher (`bun run app`) uses a separate development profile. Advanced Windows integration scripts require an existing supervised installation and its manifests; they are not a general first-install wizard.

## Known limits

- External Chrome/Edge connections may require renewed browser consent after restart. Some connector-selection and reconnection flows remain unverified end to end.
- Retained external conversations are connection-bound. Source-page loss and compaction after restart remain acceptance gaps; saved login is not an active conversation.
- Native model discovery and a healthy HTTP listener do not prove a complete model/tool request. Each account/model needs live verification.
- Prior broader local testing recorded a stale observation-timeout assertion and Windows broker/symlink test issues. Focused preview tests do not replace the full suite or resolve every inherited failure.
- MoreCodex installers and macOS/Linux deployments have not been accepted for this preview. Inherited upstream validation documents and screenshots are not proof for this version.

## Verification scope

Local Windows checks on 2026-09-22 used Bun 1.4.0: backend TypeScript, launcher TypeScript, renderer compilation and version consistency passed. The focused account/model suite passed 91 tests, and development-profile checks passed another 6. Launcher/integration and packaging-contract checks passed 45 with 2 skipped. After correcting test fixture type narrowing, the 13 affected model-selection/routing tests passed again; they are included in the 91, not additional unique tests. The Windows installer passed a PowerShell syntax check. These are 142 distinct passing tests and 2 skipped tests; packaging-contract tests do not build or install a package. No MoreCodex binary package or fresh live account acceptance was verified by these checks.

Automatic preview CI checks version consistency, backend and launcher TypeScript, renderer compilation, and selected offline tests for account catalogues, model bindings, configured selection, external browser ownership, profile isolation, updates and Windows lifecycle helpers.

Full upstream validation and binary release workflows are manual. The binary workflow must be explicitly run against an appropriate version tag; it is not triggered by publishing this source preview. Real browser authentication, tool permissions, interruption, long-context compaction and reboot recovery require separate account-bound acceptance.

Do not attach private browser profiles, account registries, raw logs or credentials to issues. Provide the version, operating system, a redacted error and steps to reproduce.
