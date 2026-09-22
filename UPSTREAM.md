# Upstream attribution

MoreCodex derives from **codex-chatgpt-web**, created by **miuuyy and its contributors**.

- Original repository: https://github.com/miuuyy/codex-chatgpt-web
- Imported baseline: `e85e3693fdb4e3e033348c08df0298c20fcdb612` (v5.0.6).
- Original license: MIT; its copyright and permission notice remain in [LICENSE](LICENSE).
- This repository starts from a source snapshot with a new commit history. Earlier upstream history remains available in the original repository. MoreCodex additions do not imply authorship of the original code.

The original local Responses bridge, browser launcher, streaming, tool transport and session infrastructure belong to that upstream work. MoreCodex adds account management and model bindings, further session handling, and Windows integration/deployment helpers.

MoreCodex uses its own release numbering, beginning at `0.1.0-preview`. This is not upstream v5.0.7, v5.0.8 or a claim of parity with later upstream versions. Later upstream fixes have not been comprehensively merged or compared.

Most documentation other than the MoreCodex READMEs, this notice, the changelog, contributing guide, account guide and preview status is inherited from upstream. Historical validation statements describe that project's releases, not validation of MoreCodex. Consult [preview status](docs/preview-status.md) for this release's evidence and limits.

Third-party notices under `LICENSES/` remain in place. Packaging scripts generate additional dependency notices for built distributions.
