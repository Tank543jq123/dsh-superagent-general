# AGENTS.md

This repository is **dsh-superagent**, a DSH (DeepSeek Harness) bundle: it receives events from Sources (GitHub, Feishu, Weixin), evaluates them under a Policy, turns authorized work into Tickets, and executes each Ticket in its own DSH Session.

## Development

- Install: `pnpm install`
- Full check: `pnpm check` (typecheck + tests + build)
- Typecheck only: `pnpm typecheck`
- Tests: `pnpm test`
- Build: `pnpm build`

## Structure

- `src/core/` — domain model and Engine; no I/O, the only writer of Tickets, Threads, Decisions, Triggers and Assignments.
- `src/app/` — composition root, SQLite Store, Effects, Outbox, prompts, settings and the management API.
- `src/sources/` — SourceKind implementations (GitHub, Feishu, Weixin) and the Source extension contract.
- `src/executor/` — the DSH Executor that runs one Worker Session per Ticket.
- `src/client/` — the native DSH React panel.
- `prompts/`, `skills/`, `locale/` — packaged prompt text, skills and UI copy.
- `docs/000-008` — the upstream design documents; `docs/ARCHITECTURE.md`, `docs/PROMPTS.md`, `docs/UPSTREAM.md` and `docs/USER-GUIDE.md` describe this fork's adaptation.

## Conventions

- Keep `src/core` free of I/O; add behavior to an Engine part, not a parallel engine.
- A Source extends `SourceKind`; it does not reach into `src/app`.
- Every externally caused refusal is a `UserError` code; every state writer is named in `docs/007-architecture.md`.
- Run the relevant tests before committing; do not commit generated `lib/` output or secrets.
- The plugin creates Worker Sessions with the configured `permissionPreset`; do not hard-code a broader sandbox mode.
