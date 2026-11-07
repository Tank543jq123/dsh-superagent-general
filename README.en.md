# dsh-superagent-general

[简体中文](README.md) | **English**

> A general-purpose DSH SuperAgent for a team: it receives authorized requests from **GitHub, Feishu and Weixin**, decides under a Policy whether to take them, executes each Ticket in its own DSH Worker Session, and delivers the result back to the source conversation.

This repository is the upgraded release of the original `dsh-superagent`: it keeps our **Weixin Source** and **configurable sandbox**, and adopts the product layer of [SuperAgent-General](https://github.com/comeonzhj/SuperAgent-General) (Chinese prompts, Feishu application SDK, panel and locales, keyword filtering, full test suite). The domain core `src/core` remains identical to the official prototype baseline `8c32a9d`.

## What it is

`dsh-superagent-general` is a DSH (DeepSeek Harness) plugin, not another standalone agent framework:

- **Three Sources**: GitHub for tracking and review; Weixin for trusted everyday instructions; Feishu optionally over the application SDK long connection.
- **Two-layer admission**: code decides who may originate work and with what strength; the model assesses whether the work is worth doing, only inside the Policy rules.
- **Authorization as data**: accepting a request creates an immutable Mandate (source, scope, matched rules, Policy version); the Worker is bounded by it.
- **One Session per Ticket**: each Ticket gets its own DSH Worker Session and directory; reports return through a durable outbox.
- **Recoverable**: Effects, Outbox, SQLite and ticket stages cover restarts, backoff and human handoff.
- **Native panel**: overview, Source, Trigger, Eval, Execution, About and Settings; a Ticket opens its real Worker Session.

## Quick start

### Requirements

- Node.js `^22.19.0` or `>=24`
- pnpm `11.7`
- DSH `0.2.1-alpha.2` compatibility range (see `package.json`)
- `gh` for GitHub operations; Weixin and Feishu are optional Sources

### Install

```sh
git clone https://github.com/Tank543jq123/dsh-superagent-general.git
cd dsh-superagent-general
pnpm install
pnpm check                         # typecheck + tests + build
pnpm pack --pack-destination dist  # installable .tgz
```

Install `dist/dsh-superagent-0.2.2.tgz` from the DSH plugin page, enable the `dsh-superagent` bundle, then restart the DSH profile.

### Configure

Deployment-level settings live in the profile patch:

```yaml
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/superagent-data
    # read-only | workspace-write | danger-full-access
    permissionPreset: workspace-write
```

Open **SuperAgent** in the sidebar and configure, in order:

1. **Sources**: GitHub (repository, execution account), Weixin (QR sign-in, direct/group messages), Feishu (`APP_ID`/`APP_SECRET`, after enabling `dsh-superagent-feishu`).
2. **Policy**: allowed senders, admission table per receiving scope, positive/negative keywords.
3. **Eval**: default `observe` records assessments only; switch to `auto` after reviewing the behaviour.
4. **Execution**: Worker model, concurrency, ticket directory, prepare command and blocked commands.
5. **Prompts**: team communication/scope/delivery sections and optional team skills.

### Use

- The **Overview** shows what needs a person, system problems, executor load and the last 24 hours.
- Send an instruction to the Weixin bot, or mention the agent account in a GitHub Issue/PR. A candidate is created; the Router decides and opens a Ticket.
- A Ticket page opens the real `worker-…` Session, including reasoning, tool calls and delivery.
- Results return to the source conversation; structured reports and `human_action` handle blockers and decisions.

### Weixin

The Weixin Source listens only to the **account owner's direct messages** by default; group chats are off. On first use, click **Sign in** under Sources → Weixin, or run:

```sh
node scripts/weixin-login.mjs --state-dir /absolute/path/to/superagent-data
```

The binding is stored in the state directory with mode `0600`; it never enters the repository or model context.

### Feishu (optional)

The Feishu plugin is disabled by default. To use it:

1. Enter `APP_ID` / `APP_SECRET` under Sources → Feishu. The secret is stored separately in `feishu-credentials.json` with mode `0600`.
2. Override `dsh-superagent-feishu` with `disabled: false` in the profile.
3. Enable the bot, long connection, message events and permissions in the Feishu developer console, then publish the app.
4. Restart and check health. Real traffic requires your own app permissions and integration testing.

## Sources

| Source | Entry | Typical use | Default |
|---|---|---|---|
| GitHub | Issue/PR comments, CI, reviews | Code changes, review, delivery | on |
| Weixin | Owner DMs, optional groups | Research, writing, translation, files, coding instructions | on |
| Feishu | DMs, groups, topics | Team collaboration, Feishu docs/wiki | off until configured |

## Key design (brief)

- **Gate + Eval**: code decides who may ask and with what strength; the model assesses whether the work is worth doing. `off / observe / auto` lets a team roll out gradually.
- **Mandate**: an immutable authorization recording basis, matched rules and Policy version; a human stop withdraws it, a Policy change can revalidate it.
- **Subscription pass-through**: follow-ups on an existing Ticket go straight to its Worker; only out-of-scope requests are handed back to the Router.
- **Effects + Outbox**: enqueue inside the transaction, execute after commit; idempotent, ordered, retried and health-reported.
- **Ticket stages by "who it waits for"**: `person / working / idle / ended`; the panel, retry and notices share one predicate.
- **SourceKind contract**: a new Source brings its config form, admission, assessment context, replies and health, not just a fetch.

Full design: [`docs/000-008`](docs/000-philosophy.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Where it comes from: development path

This repository is neither a rewrite nor a wholesale replacement of General. It is a documented three-way port:

| Date | Repository / commit | What happened |
|---|---|---|
| 2026-10-31 | [`deepseek-ai/dsh-superagent-prototype` @ 8c32a9d](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) | Official prototype baseline: Engine, Router/Worker, authorization, subscriptions, Effects/Outbox, native panel |
| 2026-11-04/05 | [`comeonzhj/SuperAgent-General` @ aedd8ff](https://github.com/comeonzhj/SuperAgent-General/commit/aedd8ff) | Sibling fork of the same baseline: general Chinese product layer, Feishu SDK, panel/locales, keywords, full tests |
| 2026-11-05→07 | [Original `dsh-superagent` local version](https://github.com/Tank543jq123/dsh-superagent-general/commit/d97463a) / [`d97463a`](https://github.com/Tank543jq123/dsh-superagent-general/commit/d97463a) | In parallel, added the Weixin Source, `permissionPreset` sandbox, Weixin sign-in script, tests and docs; frozen on 7 November |
| 2026-11-07 | commits [`fa31795`](https://github.com/Tank543jq123/dsh-superagent-general/commit/fa31795) → [`509329e`](https://github.com/Tank543jq123/dsh-superagent-general/commit/509329e), tag [`general-v0.2.2-port`](https://github.com/Tank543jq123/dsh-superagent-general/tree/general-v0.2.2-port) | Theme-by-theme three-way port from `8c32a9d`; keep Weixin and sandbox, adopt the General product layer |
| now | [`Tank543jq123/dsh-superagent-general`](https://github.com/Tank543jq123/dsh-superagent-general) | Public upgraded release (main + tag + rollback branch) |

Why not `git merge`: the two repositories have no common history (General's first commit is an independent root commit). A merge needs `--allow-unrelated-histories`, makes the whole tree a conflict surface, and can overwrite the local Weixin and sandbox work. The actual method was `git diff 8c32a9d <general-commit> -- <paths>`, reviewed and applied per theme. The full record is in [`docs/009-general-upgrade.md`](docs/009-general-upgrade.md).

### Adopted from General

- General Chinese prompts, the three team sections, Feishu/GitHub skills, and Worker authorization wording.
- Feishu application SDK: credentials, long-connection events, API reader facade, panel secret handling.
- Panel information architecture, Chinese/English copy and the matching client tests.
- Positive/negative keyword filtering, included in the Policy version.
- General's test suite and product documentation.

### Preserved from this fork

- The Weixin Source and its `./weixin-watch` entry (our trusted instruction channel).
- `permissionPreset`: default `workspace-write`, no hard-coded `danger-full-access`.
- The `dsh-superagent` package identity, original `docs/000-008` and `SETUP.md`.
- Saved team prompt overrides (see "Verification and limits").

### Deliberately not adopted

- General's package name/version and its removal of the numbered documents.
- General's `supervise.ts` watchdog (process supervision is a deployment concern here).
- Automatic wiring of `legacy-import` (kept as a tested standalone migration helper; Runtime does not call it).
- Enabling Feishu by default (avoids setup problems when no credentials exist).

## Differences from `comeonzhj/SuperAgent-General`

| Dimension | SuperAgent-General | This repository |
|---|---|---|
| Focus | General Chinese-task product | General tasks + trusted Weixin entry |
| Sources | GitHub + Feishu SDK | GitHub + Feishu SDK + **Weixin** |
| Sandbox | Inherits `danger-full-access` | `permissionPreset`, default `workspace-write` |
| Package | `dsh-superagent-general` | `dsh-superagent` (profile compatibility) |
| Design docs | 4 product docs, no 000-008 | Keeps `docs/000-008` + `SETUP.md`, adds 009 |
| Feishu | Enabled by default | Code complete, plugin disabled until configured |
| Operations | Watchdog / legacy import | Watchdog removed; legacy import not wired |
| Prompts | General Chinese defaults | General built-ins + saved team-section overrides |
| Tests | General suite | 62 files / 1197 tests after the port |

## Relationship to the original `dsh-superagent`

| Dimension | Original | This repository |
|---|---|---|
| Baseline | `8c32a9d` | Same baseline |
| Weixin | Present | Preserved |
| Sandbox | `permissionPreset` | Preserved, default `workspace-write` |
| Product layer | Coding-agent / GitHub/PR oriented | General product layer |
| Feishu | CLI mode, disabled | Application SDK, disabled until configured |
| Package identity | `dsh-superagent` | Preserved |
| Docs | 000-008 + SETUP | Preserved, plus 009 |

## Verification and limits

Current verification:

- `pnpm check`: 62/62 test files, 1197/1197 tests, typecheck, ESM + client build.
- Restarted DSH health: runtime, weixin, github, models, evals, relay, notice, launch, delivery, assessment, reply — 11 entries ready.
- An independent test agent marked the result READY; an independent review found install-guide/migration/watchdog inconsistencies, which were fixed.

Known limits:

- **Feishu is code-level only**: real traffic needs `APP_ID`/`APP_SECRET`, app permissions and your own Feishu app; the plugin is off by default.
- **Prompts are a hybrid**: General's built-in role/defaults are live, but the saved team sections in the profile are still custom text (delivery/review constraints). Restore the team sections in the panel to adopt General defaults fully.
- **Panel UI**: API/health were verified, but no screenshot-level visual review was done; open it in your DSH and confirm.
- **No automatic old-config import**: `legacy-import` is not wired into Runtime; migrate an old `settings.json` manually.
- This is a productization of a research prototype, not an official DeepSeek product; review permissions, team policy and compliance before use.

## Rollback

```sh
# Roll back locally to the pre-upgrade state
git switch main
git reset --hard pre-general-main      # = 8c32a9d
pnpm install && pnpm check && pnpm build
# restart the DSH profile
```

- Upgrade commit: [`509329e`](https://github.com/Tank543jq123/dsh-superagent-general/commit/509329e); tag: [`general-v0.2.2-port`](https://github.com/Tank543jq123/dsh-superagent-general/tree/general-v0.2.2-port).
- Rollback branch: [`pre-general-main`](https://github.com/Tank543jq123/dsh-superagent-general/tree/pre-general-main) (`8c32a9d`).
- Remote: `Tank543jq123/dsh-superagent-general`; replace the remote if you need a team repository.
- Keep the old `lib/` or package before rebuilding and restarting.

## License and credits

MIT License. Upstream copyright and license: [LICENSE](LICENSE).

- Official prototype: [DeepSeek Harness Team / dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- General product layer: [ZhangJia (comeonzhj) / SuperAgent-General](https://github.com/comeonzhj/SuperAgent-General)
- Weixin Source, `permissionPreset` and this port: the maintainers of this fork

For step-by-step setup, read [`SETUP.md`](SETUP.md); for the detailed port record, read [`docs/009-general-upgrade.md`](docs/009-general-upgrade.md).
