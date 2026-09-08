# Tests

Contract tests for the JSON documents that connect the Analyzer, the Editor and the
Player. They check the **contract**, not any one component's internals: each component
will own its own unit tests inside its own directory, in whatever framework that
component ends up using.

## Running them

There are two modes.

**The full repository contract suite** - schemas, examples, negative fixtures and code
coverage:

```text
python tests/validate_contracts.py
```

**A single external Analysis document**, for validating a real analysis produced outside
the repository:

```text
python tests/validate_contracts.py --analysis path/to/analysis.json
```

In `--analysis` mode only the Analysis contract runs: the document is checked against
`schemas/analysis.schema.json` and then against the same semantic checks the repository's
own examples go through. It does not touch the chart or project contracts, does not need
a Project document, does not run the negative fixtures, and copies nothing into the
repository. Absolute and relative paths both work.

This mode exists because generating the first real Analysis document showed there was no
supported way to validate one - the only options were importing the validator's functions
by hand or copying the file into a throwaway repository-shaped tree.

Python 3 standard library only - there is nothing to install, and no dependency is added
to the repository. This is deliberate: the contract must be checkable before any
component has chosen a language. Both Python 3.11 and 3.14 are exercised.

Exit status is 0 when everything passes and 1 otherwise, so either mode can be used as a
pre-commit check or, later, in CI.

Options:

| Option | Effect |
| --- | --- |
| `--analysis PATH` | validate one external Analysis JSON instead of the repository suite |
| `--quiet` | print failures only |
| `--repo-root PATH` | check a different checkout |

## Division of labour

### What the JSON Schemas check

The schemas in [`../schemas/`](../schemas/) describe the **shape** of a single document:
which properties exist, their types, which are required, which are forbidden, numeric
bounds, string patterns, and enumerated values. They are the contract a component reads
before it trusts a document.

A JSON Schema sees one value at a time. It cannot say "this id is unique in this
document", "this reference resolves", "these entries are in ascending order", or "these
two documents describe the same song".

### What the contract test checks

`validate_contracts.py` covers both: it runs a small built-in schema validator over the
examples, and then the constraints a schema cannot express.

**Documents and schemas**

- every file in `schemas/` parses, declares the 2020-12 meta-schema, and has only
  internal `$ref`s that resolve;
- every file in `examples/` parses and conforms to its schema;
- schemas and examples are paired - no example without a schema, and no schema without
  an example.

The built-in validator is a deliberate subset. It enforces the keywords the Chart Forge
schemas actually use - `type`, `required`, `properties`, `additionalProperties`,
`items`, `enum`, `const`, `oneOf`, `$ref`, `minimum` / `maximum` / `exclusiveMinimum` /
`exclusiveMaximum`, `minLength`, `pattern` - and treats annotations (`title`,
`description`, `examples`, `default`, `$id`, `$comment`) as carrying no constraint.
`format` is among those: draft 2020-12 makes it an annotation unless a validator opts
in, so `"format": "date-time"` is **not** checked here.

A keyword outside those two lists would otherwise be ignored in silence, leaving a
schema that constrains less than it appears to. So every subschema in `schemas/` is
swept at startup and an unknown keyword fails the run (`schema/unsupported-keyword`).
The sweep is static and covers the whole schema, not only the branches an example
happens to reach.

This is not a JSON Schema implementation and is not meant to become one. When the
schemas genuinely need more, the honest fix is to depend on a real validator, not to
grow this file.

**Analysis**

- event ids are unique, and so are stem ids and detector ids;
- `source.stemId` names a stem the document declares;
- `detectorId` on every event and beat names a detector the document declares;
- `endKind` agrees with the presence of `endSec` and `durationSec` - `bounded` requires
  an `endSec`, while `instantaneous` and `unknown` must have neither;
- `endSec` is not before `startSec`;
- when both are present, `durationSec` agrees with `endSec - startSec`;
- `beats[].timeSec` is in ascending order;
- `events[]` is ordered by `(startSec, id)` - the secondary key matters because events
  from different branches routinely share a timestamp (53 did in the first real
  document), and it carries no musical meaning.

**Chart**

- note ids are unique;
- `lane` and `endLane` are inside the playfield, `0` to `laneCount - 1`;
- `endTimeSec` is after `timeSec`;
- `hold` and `slide` notes have an `endTimeSec`;
- `notes[].timeSec` and `timing.bpmChanges[].timeSec` are in ascending order.

**Across documents**

- a note's optional `sourceEventId` resolves to an event in the analysis the project
  points at - the one place the two documents touch, and therefore the one worth
  guarding;
- every `kind: "file"` reference in a project exists on disk;
- the project, its analysis and its chart agree about the audio: the same resolved path,
  and no disagreement on `durationSec` or `sha256` where both state one.

Ascending means non-decreasing. Two notes at the same instant in different lanes are
normal; time going backwards is not.

### What is checked nowhere yet

`tempo.map[]` and `sections[]` are not required to be ordered, because nothing in the
schemas or the documentation says they must be. If that is the intent, say so in
`schemas/analysis.schema.json` first and the check follows.

Audio files are never opened. A document may reference audio that does not exist; only
references to *documents* are required to resolve.

## Fixtures

A test suite that only sees valid data proves nothing. `fixtures/invalid/` holds
deliberately broken documents, each as small as the flaw it carries, and
`fixtures/cases.json` states for each one the **exact** set of problem codes it must
produce - no more and no fewer. A check that fires for the wrong reason, or a new check
that fires on an unrelated fixture, fails the suite.

`fixtures/valid/` holds the opposite: documents that must pass every check, registered
with an empty `expect`. The examples already cover the ordinary case, so these are for
claims a single example cannot make at once - that a chart written before a field existed
is still valid, that the same chart with the field present and empty is too, and that a
document may carry a kind this version of the contract has never heard of. Each is
evidence for a compatibility promise, so it is worth a fixture of its own rather than a
sentence in a commit message.

Document paths in `cases.json` are relative to the repository root, so a case can pair a
broken fixture with a good example - that is how the cross-document cases work.

Every problem the validator can report has a code, registered in `CODES` in
`validate_contracts.py`. The run ends with a coverage line naming the codes that no
fixture exercises yet. Four are currently uncovered - `schema/meta`, `schema/bad-ref`,
`schema/unsupported-keyword` and `contract/unpaired-example`. They are properties of the
repository's own `schemas/` and `examples/` directories rather than of any one document,
so a permanent fixture for them would mean committing a broken schema. They were
verified instead against a throwaway copy of the repository, using `--repo-root`, which
is the supported way to re-check them.

## Adding a check

1. Register a code in `CODES` with a one-line description.
2. Report it from the relevant `check_*` function.
3. Add a minimal fixture under `fixtures/invalid/` and a case in `fixtures/cases.json`.
   Add one under `fixtures/valid/` too when the check draws a line something on the
   good side of it must stay on.
4. Run the suite: the new case must pass, and no existing case may change.

## What does not belong here

Audio processing accuracy, UI behaviour and playback timing. Those need the components
themselves and belong with them.

Small binary fixtures may live in `fixtures/`, which `.gitignore` re-includes. Keep them
tiny - a few seconds of audio at most. Full songs stay out of the repository.

## Ground rules

- Standard library only. Whatever is used must not force a language choice on the
  components themselves.
- When a schema changes, the examples and these tests change with it.
