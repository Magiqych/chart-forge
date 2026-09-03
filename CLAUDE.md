# CLAUDE.md — working rules for Chart Forge

Rules for Claude Code (and any other agent or contributor) working in this repository.
Read this before making changes.

## 1. Safety gate — run before any change

Before creating, modifying or deleting anything, confirm and report:

1. The working directory and the repository root.
2. That this is in fact the `chart-forge` repository (check `git remote -v`).
3. The current branch and `HEAD`.
4. `git status` — the full list of uncommitted and untracked changes.

If the repository is not the expected one, or there are unexpected existing files or
uncommitted changes, **stop and report instead of changing anything.**

Never delete or overwrite an existing file just because it is in the way. Untracked and
uncommitted work belongs to the user; preserve it. If something must be replaced, say so
and get confirmation first.

## 2. Commits and remotes

- Do **not** `git commit` unless the user explicitly asks.
- Do **not** `git push`, open pull requests, or merge unless the user explicitly asks.
- Leave changes in the working tree so the user can review them with `git diff`.

## 3. Keep the components loosely coupled

`analyzer/`, `editor/` and `player/` are independent components.

- They communicate **only** through the JSON documents defined in `schemas/`.
- No component may import, read or depend on another component's internal source,
  build output, or in-memory representation.
- Shared knowledge belongs in `schemas/` and `docs/`, not in one component that another
  reaches into.
- Do not introduce a repository-wide language, framework or build system that forces all
  three components into the same stack. Each component may choose its own.

## 4. Respect the conceptual boundaries

- An **Analysis Event** (what happens in the audio) and a **Chart Note** (what the game
  asks the player to hit) are different concepts. Do not merge, alias, or auto-convert
  them.
- The Analyzer produces **guide information for a human author**, not a chart. Do not
  add features that make the Analyzer decide gameplay.
- Keep game-specific data (e.g. Deresute specifics) inside the designated extension
  namespace of the chart model, separate from the generic chart model.

## 5. Schema changes

The schemas in `schemas/` are the contract between components. Treat changes to them as
public API changes.

- Prefer additive, backward-compatible changes: new **optional** fields, new enum
  members with a documented fallback.
- Adding a required field, removing a field, renaming a field or changing a field's type
  or unit is a breaking change. It needs the schema `version` bumped and an explicit note
  to the user.
- Time fields carry their unit in the name (`startSec`, `timeSec`, …). Keep that
  convention; do not introduce a bare `time` field of ambiguous unit.
- When you change a schema, check and update in the same change:
  - `examples/` — the example documents must stay valid,
  - `tests/` — validation fixtures and expectations,
  - `docs/` and `README.md` — terminology and field names must stay consistent.

## 6. Dependencies

- Do not add libraries, frameworks or tooling that the task does not actually require.
- Do not create `package.json`, `pyproject.toml`, lockfiles, CI configuration or
  container files on your own initiative.
- Prefer the standard library of whatever language a component ends up using.
- Avoid premature optimization and speculative abstraction. Build the smallest thing
  that satisfies the current requirement.

## 7. Do not guess at existing behaviour

- Read the existing code, schemas and docs before implementing or changing anything.
- If a specification is unclear or absent (particularly the Deresute chart format), do
  not invent it silently. State the uncertainty and ask, or mark it explicitly as a
  provisional assumption in the document.
- Do not "fix" a spec by changing it to match an implementation; the schema is the
  source of truth.

## 8. Large binary files

Audio files, stems, and other large or generated artefacts must not be committed. See
`.gitignore`. Small fixtures for examples and tests are allowed only in the directories
that `.gitignore` explicitly re-includes, and only when genuinely small.

## 9. Reporting

When finishing a task, report what changed, what was verified and how, and what was
deliberately left undone.
