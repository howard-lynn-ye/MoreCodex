# Contributing to MoreCodex

MoreCodex is maintained in this repository by [howard-lynn-ye](https://github.com/howard-lynn-ye) and contributors. It builds on codex-chatgpt-web by miuuyy and its contributors. The original project's history and MIT notice are preserved; see [UPSTREAM.md](UPSTREAM.md).

Bug reports, focused fixes, documentation improvements and reproducible compatibility reports are welcome. For larger features, describe the proposed behavior in an issue before starting a broad implementation.

## Reporting a problem

Include your MoreCodex commit or version, operating system, reproduction steps, expected result and a redacted error. Check the [preview status](docs/preview-status.md) for known gaps. Never upload browser profiles, account registries, cookies, credentials, tunnel identifiers or raw logs. Review even an automatically redacted export before attaching it.

Use fictional account labels such as `alpha`, `beta` and `gamma`, reserved example email addresses, and temporary paths in examples and tests. Do not copy a developer's real name, school or employer account labels, email address, device identifiers, browser screenshots or private conversations into fixtures. Use a GitHub privacy email for commits. Ignore rules do not remove files from existing commits; review the staged content and outgoing history before publication.

## Working on a change

Use Bun 1.4.0. Install the locked dependencies and run the source checks:

```sh
bun install --frozen-lockfile
cd launcher
bun install --frozen-lockfile
cd ..
bun run check-version
bun run typecheck
bun run launcher:typecheck
bun run launcher:build
```

Run the tests relevant to the changed behavior. The [source preview workflow](.github/workflows/preview.yml) lists the focused regression suite used for this preview. The broader `bun run verify` command and packaging workflows are inherited from upstream; report their results separately, including any known failures. Do not describe focused tests as full platform acceptance.

Keep pull requests focused and explain what changed, why it changed and how you verified it. Add a regression test for a behavior change when it can catch the underlying failure. Browser changes should include a reproducible fixture and the observed interface behavior, with personal information removed.

## Behavior to preserve

- Keep account, workspace and model selection explicit. A mismatch or unavailable selection must return an error instead of silently choosing a different account or model.
- Expose local tools only through the authorized active task and its account-bound connector. Respect explicitly declared model capabilities.
- Keep development profiles isolated and integration changes reversible. Do not overwrite unrelated Codex settings or another installation's runtime.
- Retain upstream and third-party attribution. Do not claim that the project bypasses account permissions, quotas or usage limits.

Live browser authentication, tool execution, interruption, long-context compaction and reboot recovery need separate testing with an authorized account. A passing offline test or healthy HTTP endpoint does not establish end-to-end acceptance. Build platform packages on their matching operating system and state which platforms were actually tested.
