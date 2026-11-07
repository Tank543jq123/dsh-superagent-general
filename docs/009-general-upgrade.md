# General upgrade record

This fork was upgraded from the official prototype baseline `8c32a9d` with the product layer of [comeonzhj/SuperAgent-General](https://github.com/comeonzhj/SuperAgent-General) at `aedd8ff` (v0.2.2). The two repositories share no commit history, so the upgrade was applied as a reviewed tree port, not a `git merge`. The feature result is commit `fa31795`; the documentation and package-metadata follow-up is `5239ef8`. The final HEAD carries the tag `general-v0.2.2-port` on branch `feat/general-final`.

## Adopted from General

- General-purpose Chinese prompts, the three team sections, the built-in Feishu and GitHub skills, and the worker/orchestrator wording that matches them.
- The Feishu application SDK transport (`src/sources/feishu-sdk.ts`), its credential store, the long-connection event consumer, the API reader facade and the panel secret handling.
- General's panel information architecture and locale copy, plus the matching client and server tests.
- Positive/negative keyword filtering in the Policy gate and its inclusion in the Policy version.
- General's test suite and documentation that describe the adapted product behaviour.

## Preserved from this fork

- The Weixin Source (`src/sources/weixin.ts`, `weixin-trigger.ts`, `weixin-api.ts`), its `./weixin-watch` export, bundle entry and settings form.
- The configurable `permissionPreset` sandbox mode, defaulting to `workspace-write`; it is passed to every Session the plugin creates.
- The `dsh-superagent` package identity and the numbered design documents `docs/000-008` and `SETUP.md`.
- The GitHub Source remains the default work tracker; the Feishu plugin stays disabled until an operator configures `APP_ID`/`APP_SECRET`.

## Deliberately not wired

- `src/app/legacy-import.ts` is retained as a tested standalone migration helper, but this fork's Runtime does not call it, so a fresh install is not rewritten to General's default policy.
- General's `supervise.ts` watchdog was removed; process supervision remains the operator's deployment concern.
- General's package name/version and its removal of the numbered design documents were not adopted.

## Verification

Run with a clean Git environment because the DSH host exports `GIT_CONFIG_GLOBAL`:

```sh
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM pnpm check
```

The check passes: 62 test files, 1197 tests, typecheck and build. The build emits `lib/index.js`, `lib/github-watch.js`, `lib/feishu-watch.js` (a re-export barrel into the shared Feishu chunk) and `lib/weixin-watch.js`.

## Later updates

Use `git diff 8c32a9d <new-general-commit> -- <paths>` as a patch source, never `git merge` the two unrelated histories. Keep the Weixin source, `permissionPreset`, the package identity and the numbered documents on every port. The Feishu SDK is optional at runtime: leave the Feishu plugin disabled until its app credentials exist.
