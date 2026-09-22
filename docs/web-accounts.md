# Web account registry and native Codex models

This backend exposes account-specific models through Codex's existing `model/list` catalogue. It does not add a model picker or change the official Codex route automatically.

## Transport and current support

Account configuration, discovery, catalogue generation and route selection run in backend code. **Web inference still uses this project's ChatGPT browser automation.** A hidden browser is still a browser. Tunnel credentials authorize the MCP tool connection, not an HTTP model inference API. No official API model replaces a selected Web model.

Model discovery reads the enrolled account's authenticated Web catalogue. Only models that are available, pinned to that user/workspace and have a configured selection are published. Existing preset routes (`chatgpt-web/pro`, etc.) remain supported. New models can instead provide an explicit model definition through configuration or CLI, without changing source. Discovering a candidate does not prove that either selection path can use it. A wrong selection is rejected by comparing the actual submitted model/workspace and Web response metadata with the selected model. Unconfigured candidates remain visible in CLI status, not in the native picker.

## Independent persistent sessions

Launcher accounts have a distinct `sessionHome`, browser descriptor and persistent browser partition. `start` reuses that directory; it does not import Chrome/Edge cookies, refresh an original browser, install a Codex route, or run a new authentication flow. `login` explicitly opens that account's dedicated authorization surface for the user. Existing-browser accounts use the separate connection mode below.

Authentication uses the site's session response, independently of whether the composer has rendered. Transient network/security-check failures preserve the stored session and show a separate error. The host does not automatically refresh on OAuth completion or Cloudflare challenges. Authentication popups explicitly share the account's persistent session, which is flushed on successful authentication and graceful shutdown. These changes do not prevent real server-side session expiry.

Host readiness is checked over its authenticated control endpoint, including the descriptor's process ID and partition. A login command is sent once after readiness; a navigation timeout does not replay login. Concurrent background launches do not bring the existing account window to the foreground.

`web-accounts status` also reads each enrolled host's current status without opening or refreshing a page. `runtime.authentication` distinguishes `authenticated`, `login-required`, and `unverified` (including a stopped or unreachable host). This is the host's latest observation, not a new end-to-end request or proof of model entitlement. Saved `identityVerified` and `selectableModels` describe enrollment/catalogue metadata and do not establish that a session is currently usable. An original Chrome/Edge login is separate from an enrolled account host.

Never point two account entries at the same session directory. Do not use the DEV profile to enroll production accounts. Do not put cookies, bearer tokens or Tunnel key contents in the registry. A Tunnel key is referenced by an absolute file path.

### Reuse an already signed-in Chrome/Edge session

`web-accounts attach-browser ID --user-data-dir ABSOLUTE_BROWSER_ROOT` selects `external-cdp` for an existing enrollment. For a new enrollment, `add` accepts `--user-data-dir` instead of `--descriptor`. The root identifies the browser rendezvous file, **not** the ChatGPT account. Discovery matches the enrolled email inside the page and pins the returned user ID and workspace ID. An account source change invalidates prior catalogue verification until discovery succeeds.

The browser must expose its own supported, user-authorized debugging connection. Chrome 144+ documents the running-session permission flow at `chrome://inspect/#remote-debugging`; the user must enable it and approve the browser's connection prompt. Support in a specific Edge build must be checked separately. The bridge reads only `DevToolsActivePort`, accepts only a loopback WebSocket, and neither launches the browser nor changes its settings. It does not decrypt, copy or export login data. A browser refusing this connection is a blocker, not a reason to bypass encryption or require another website login.

Each enrolled account keeps one connection shared across its model workers. Connections have no default forced expiry. Turns create background tabs in the verified context and re-check identity before submission. Original tabs are never refreshed, navigated or closed. Bridge shutdown releases its own tabs and socket. Closing the source tab is allowed if another matching ChatGPT tab remains in the same context. Browser disconnection or identity failure stops requests without automatic reconnect or account fallback; restore that browser connection and explicitly restart the bridge. A new connection after a bridge/browser restart may require browser consent again even though ChatGPT remains signed in. This consent behavior is controlled by the browser and remains a persistence acceptance item.

`status` does not initiate a privileged connection: it reports connection availability separately from authenticated discovery. `start`, `login` and `stop` refuse external accounts so they cannot accidentally launch an empty profile or close the user's browser. Removing an external account detaches its registry entry and leaves the original profile intact.

### External conversation ownership and compaction

Automatic external turns retain only bridge-created pages, keyed by thread, account, model and compaction epoch. The next turn must acquire the same page exclusively. Interruption and failure wait for confirmed closure of that exact target before releasing ownership. A failed close quarantines the connection and returns a non-retryable error; disconnecting the socket alone is not proof that a task stopped. The outgoing Web request must contain the pinned workspace header and actual model slug, and completion also requires matching model metadata from the Web response.

Structured context compaction uses the same retained-conversation MCP/Broker handoff as launcher-backed requests. It cannot silently create a fresh page or substitute a read-only summary when the source page is missing. This path has local protocol tests, including a real Windows broker transaction with simulated pages, but still needs live website acceptance.

Retention is currently limited to the lifetime of the connection and to 32 conversations per account/model worker. It is not restart persistence of open pages. After a bridge/browser restart, a missing source produces `compaction_source_unavailable`; a normal new turn must establish context before another retained compaction. Saved website authentication remains owned by the original browser. Browser connection consent may be required again on restart, even while the website remains signed in.

## CLI workflow

Use the project-pinned Bun 1.4.0 and a prepared production bridge home. The following variables are examples of paths to supply; the commands do not target the running official Codex configuration:

```powershell
$bun = 'bun' # Bun 1.4.0 on PATH
$repo = (Get-Location).Path # Run from the MoreCodex checkout
$cli = Join-Path $repo 'src/cli.ts'
$bridge = Join-Path $env:USERPROFILE '.morecodex'
$accountHome = Join-Path $env:LOCALAPPDATA 'MoreCodexAccounts/research'
$descriptor = Join-Path $accountHome 'bridge-home/runtime/launcher-browser.json'
$electron = Join-Path $repo 'launcher/node_modules/electron/dist/electron.exe'

& $bun $cli --home $bridge web-accounts status
& $bun $cli --home $bridge web-accounts add research --label 'Research account' --email 'you@example.com' --session-home $accountHome --descriptor $descriptor
& $bun $cli --home $bridge web-accounts login research --executable $electron --entry (Join-Path $repo 'launcher')
# Complete login manually, then discover models available to that account.
& $bun $cli --home $bridge web-accounts discover research
# Replace ACTUAL_WEB_SLUG with an observed slug and use a compatible selector.
& $bun $cli --home $bridge web-accounts model research ACTUAL_WEB_SLUG --route chatgpt-web/pro
```

`start ID`, `login ID`, `stop ID`, `rename ID ALIAS`, `enable ID` and `disable ID` are backend commands. `stop` refuses an active turn and preserves session files. Stop/disable does not delete an account or credentials. A disabled or no-longer-available model fails closed even if an older native picker still contains its ID.

### Configure a model outside the built-in presets

After authenticated discovery, supply a JSON definition whose `slug` and `title` exactly match that discovery:

```powershell
& $bun $cli --home $bridge web-accounts model research ACTUAL_WEB_SLUG --definition 'D:\WebAccounts\observed-model-definition.json'
```

The file contains these explicit fields; none of them is proof of successful inference:

| Field | Required contents |
|---|---|
| `version`, `slug`, `title` | Version `1`, actual discovered slug and title. |
| `effort` | Native `codex` effort and internal `adapter` effort. The selected route keeps them fixed. |
| `capabilities` | `tools` and `inputModalities` (`text`, optionally `image`). Undeclared native capabilities are not inherited. |
| `limits` | `contextWindow`, `autoCompactTokenLimit`, `browserMessageTokenLimit`, `browserComposerCharLimit`, `platformReserveTokens`, `imageTokenReserveTokens`. Supply measured or otherwise established limits, not guessed native model values. |
| `selection` | A `menu` or `slider` strategy containing exact accessible control names observed on the authenticated website. |

A menu strategy specifies `trigger`, `scope`, `steps` and `verify`. Each control has an exact `role` and `name`; verification requires the target's checked/selected state. A slider strategy specifies `trigger`, `scope`, `slider`, keyboard `control`, and exact `min`, `max`, `value`. Missing, ambiguous or changed controls fail explicitly. Strategies cannot contain scripts, CSS selectors, network endpoints or request-body replacements. See `src/web-model-definition.ts` for the validated schema.

`--definition` and `--route` are mutually exclusive. The CLI backs up the registry and updates its managed catalogue. Rediscovery preserves a definition only for the same actual slug and updates the discovered title; a newly discovered slug does not inherit a previous model's selection. Each turn receives a deep snapshot, so an edit cannot retarget an in-flight request.

This removes the fixed-preset code restriction. It does not make a hidden or unsupported website model available, discover reliable selection controls automatically, or establish that all configured candidates work. Each published model still needs the native Codex acceptance checks below. A text-only/tools-disabled definition cannot satisfy the user's tool-chain requirements merely by being listed.

`remove ID` removes only the account's registry entry and exported models, with a registry backup. Its host, saved login, history and session directory remain intact. Stop the host first if it should also exit. Restoring the registry backup restores enrollment; no credential recovery or new source edit is needed.

Registry edits made by the CLI are validated before replacement, backed up, serialized by a lock file, and regenerate the previously exported catalogue. A generation failure preserves the old registry. In an installed integration, run these commands with that integration's `--home` and matching `CODEX_HOME`; the managed native catalogue is updated with its recovery journal. An unrelated administrative home does not modify another installation. After direct configuration edits, use `route refresh-catalog` from the installation home. Codex may need to reopen to reload `model_catalog_json`; live hot reload is not guaranteed.

## Configuration and bindings

Bridge `config.json` references `webAccountsFile`. Its version 2 registry contains:

- `accounts[]`: `id`, `label`, expected `email`, `enabled`, distinct `sessionHome` and `browserHostDescriptorPath`.
- `externalBrowser` (optional): absolute `userDataDir`, optional `connectTimeoutMs` and `connectionTtlMs`; the existing descriptor is retained for recovery but is not used by external requests.
- `userId`, `accountId`, `catalogIdentity`, `catalogVerifiedAt`: enrolled by live `discover`; directory names and aliases never establish identity.
- `models[]`: actual `slug`, actual `title`, `available`, and either an optional legacy `adapterRoute` or a validated `definition`.
- Per-account `connectorName` and `tunnel` with `binaryPath`, `tunnelId`, `runtimeKeyFile`, `profileDir`, `profileName`, `alias` are required in full tool mode. Verify the existing connector owner/workspace/Tunnel before configuring these. This CLI does not create connectors or independently certify a Tunnel binding. Missing bindings fail before inference instead of inheriting the bridge's default account Tunnel.
- `nativeCatalogFile`: official bundled metadata, exported by the official `codex.exe debug models --bundled` command.
- `catalogOutputFile`: generated native catalogue; separate from bridge config, registry and template.
- `host`: executable and optional source launcher entry, recorded by `start`/`login`.

Public IDs hash the account ID, enrolled user ID, workspace ID and actual model slug. Renaming the alias/title preserves the ID; enrolling a different identity does not inherit it. The display label is the actual model title followed by the configured alias.

The local catalogue is independent of the bearer token belonging to the official Codex login. Web requests are routed by the selected public ID, not that bearer token. The helper receives the pinned account identity and model binding; it checks the live session, submitted model/workspace and actual response model. Redacted `[web-routing]` logs record trace ID, public ID, model slug, identity fingerprints and request-body fingerprint. They exclude prompt contents, cookies and authorization headers.

## Acceptance and rollback

**Release gate:** every genuinely available model for every configured account must appear together in the official Codex native dropdown as `actual model title + account alias`, and must complete a real request selected from that UI. Capture the expanded native dropdown and each successful native reply, paired with redacted request/account/model routing evidence. Configuration, CLI output, third-party launchers, names alone, HTTP success, or app-server-only runs do not satisfy this gate. Unsupported or unverified candidates remain an explicit coverage gap; publishing only the passing subset does not establish full acceptance. Backend catalogue entries alone do not prove model entitlement.

The native catalogue file is only metadata. Its existence, a model name in a dropdown, and HTTP 200 do not establish successful inference. Verify each account with an actual native Codex request and correlate its routing trace with the Web response model; then test tools, interruption, compaction and restart.

For an existing managed integration, use `node scripts/current-codex-integration.cjs disconnect ABSOLUTE_CONNECTION_JSON` to remove only the route and catalogue settings owned by its journal. Preserve browser profiles and review the journal before restoring configuration. The Windows deployment helpers require an existing supervised installation; they are not a first-install wizard.
