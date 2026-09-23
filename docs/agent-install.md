# Install MoreCodex with a coding agent

This guide is for a coding agent with access to the user's local terminal and files. The user can hand you the repository and ask you to set it up. Prepare the source preview, then help connect and verify an account and model for actual Codex tasks.

Read the [README](../README.md), [preview status](preview-status.md) and [account guide](web-accounts.md) first. The current release is `0.1.0-preview`; it provides source and build tooling, with no published MoreCodex binary installer. The preview status describes the tested scope and remaining gaps.

## 1. Check the environment

Identify the operating system, available terminal, existing Codex setup and a suitable user-owned checkout directory. Inspect an existing checkout before updating it and preserve local changes. Prefer per-user installation of missing prerequisites using the official Git and Bun instructions for that operating system, within the user's permission boundaries.

Check `git --version` and `bun --version`. The source currently pins **Bun 1.4.0** in `package.json`; use that declared version. If the required runtime is unavailable, report that dependency rather than changing the lockfiles to make installation pass.

Keep accounts, cookies, tokens, browser profiles and private diagnostics outside the Git checkout. Retain the user's existing Codex login and configuration while preparing the separate development profile.

## 2. Prepare the source preview

For a fresh checkout, run these commands from the chosen parent directory:

```sh
git clone https://github.com/howard-lynn-ye/MoreCodex.git
cd MoreCodex
bun install --frozen-lockfile
cd launcher
bun install --frozen-lockfile
cd ..
bun run check-version
bun run typecheck
bun run launcher:build
```

Check each command's exit status before continuing. `launcher:build` checks the launcher TypeScript and builds the renderer. These checks establish that this checkout can compile; account access and live tools are checked separately below.

## 3. Launch the development profile

From the repository root, run:

```sh
bun run app
```

This command installs the locked root and launcher dependencies and starts the launcher in a separate development profile. It is a long-running desktop process: use a terminal session that remains available, inspect startup output, and confirm the launcher opens when desktop observation is available. On a machine without a usable desktop session, report the launch limitation and the checks that did pass.

Use this source path for the preview. The inherited download installers and binary updater are not its installation route. Windows deployment and recovery helpers require an existing managed installation and its manifests; launching the development profile does not establish that installation.

## 4. Configure and verify the intended account

Follow the [account guide](web-accounts.md) for the selected installation/profile, account enrollment, model discovery and catalogue setup. Use the actual paths and supported setup flow for that environment. Its advanced CLI examples assume a prepared production bridge home; do not apply those example paths blindly to the development profile.

The user completes account sign-in and browser or connector consent. Once that access is available, continue configuration. Full tool mode needs the selected account/workspace's connector and Tunnel configuration. Keep credentials local and omit them from reports.

Choose one eligible account/model as the initial verification target. Confirm that its labelled entry appears in Codex, submit a real request through that entry and check the routing evidence. For full tool mode, also run one small authorized local operation, such as reading a disposable test file. A model appearing in a list or an HTTP listener responding does not establish a successful model/tool request. State which binding was tested without disclosing private identifiers, and verify additional requested bindings individually.

If the existing installation or permissions are insufficient, finish the independent source checks and state the specific remaining dependency. Preserve the current setup until the documented integration prerequisites are satisfied.

## 5. Report what is ready

Give the user the checkout path, how to launch it again, and the observed outcome of the source checks, launcher startup, live model reply and local tool check. Report any untested step or required user action explicitly. A successful source build alone is not a completed account/tool setup.

Use the [preview status](preview-status.md) for platform and recovery coverage. Keep raw private diagnostics out of Git, issues and the completion report.
