# Contributing to Tempo

Thanks for your interest in **Tempo**, a lean run-only marathon training engine.
This guide covers how to get a dev loop going, the conventions the codebase
follows, and how to propose changes.

## Ground rules

- **Be kind and concise.** Issues and PRs are read by humans on their own time.
- **One concern per PR.** Small, reviewable diffs land faster than big ones.
- **Discuss big changes first.** Open an issue before starting work on anything
  that touches the training model, the API surface, or the data schema.

## Project shape

Everything lives in `val/` and is uploaded to a [Val Town](https://val.town)
project. A single http val, `app.ts`, is the only entrypoint — it mounts the
API, dashboard, and OAuth routes onto one shared Hono app on one origin. See
[`CLAUDE.md`](CLAUDE.md) for the full architecture and the file-by-file map.

The split that matters for contributors:

- **Pure logic** lives in `engine.ts` and `types.ts` — no remote imports, so it
  runs and unit-tests offline.
- **I/O** (SQLite, blobs, HTTP, OAuth) lives in `db.ts` and the http vals.

Keep that boundary. New training math goes in `engine.ts` with a test; new
endpoints register their own path-scoped routes via a `register*(app)` function.

## Local development

The engine and types are runnable without Val Town. You'll need
[Bun](https://bun.sh).

```bash
# clone
gh repo clone Approach-Labs-AI/running-tempo
cd running-tempo

# run the offline test suite (pure engine logic)
bun test test/engine.test.ts
```

For changes that touch live behavior (API, dashboard, OAuth, crons), you'll need
your own Val Town project and the deploy flow described in
[`CLAUDE.md`](CLAUDE.md) → **Deploy**. Use a throwaway project and your own API
keys — never point a dev branch at production data.

## Making a change

1. **Fork** and create a topic branch off `main`
   (`git checkout -b fix/pace-rounding`).
2. **Make the change.** Match the surrounding style — the codebase favors small
   pure functions and explicit names.
3. **Add or update a test** in `test/engine.test.ts` for any logic change.
4. **Run the suite**: `bun test test/engine.test.ts`.
5. **Open a PR** against `main` with a clear description of the what and the why.
   Link the issue it closes.

## Style & conventions

- Val Town runtime is **Deno**: `Deno.env.get(...)`, `export default app.fetch`
  for http vals.
- SQLite via `https://esm.town/v/std/sqlite`; blobs via
  `https://esm.town/v/std/blob`.
- Keep pure logic testable: no remote imports in `engine.ts` / `types.ts`.
- Prefer clarity over cleverness. Comments explain *why*, not *what*.

## Reporting bugs & requesting features

Use the issue templates. A good bug report includes what you expected, what
happened, and the smallest set of steps to reproduce. For training-model
proposals, describe the runner scenario and the desired behavior — not just the
code change.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
