#!/usr/bin/env python3
"""Chart Forge contract tests.

Validates the JSON documents that form the contract between the Analyzer, the Editor
and the Player:

  1. every schema and example parses, and every internal $ref resolves;
  2. every example conforms to its schema, checked by a small built-in validator;
  3. the constraints a JSON Schema cannot express - unique ids, resolvable references,
     ordered time series, ends after starts, agreement between documents;
  4. deliberately broken fixtures fail, for the expected reason and no other.

Python standard library only, by design: the contract must be checkable without
installing anything, in a repository that has not chosen a language for any component.
The schema validator below is intentionally a subset - it covers the keywords the Chart
Forge schemas actually use and nothing more. It is a contract test, not a JSON Schema
implementation.

Usage:

    python tests/validate_contracts.py
    python tests/validate_contracts.py --quiet
    python tests/validate_contracts.py --repo-root /path/to/chart-forge
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
CASES_FILE = FIXTURES / "cases.json"

META_SCHEMA = "https://json-schema.org/draft/2020-12/schema"

#: Every problem this file can report. Kept in one place so the negative fixtures can
#: be checked for coverage, and so a new check cannot quietly invent a code.
CODES = {
    "json/parse-error": "a document is not valid JSON",
    "json/missing-file": "an expected document does not exist",
    "schema/meta": "a schema does not declare the 2020-12 meta-schema",
    "schema/bad-ref": "a $ref inside a schema does not resolve",
    "schema/unsupported-keyword": "a schema uses a keyword this validator does not implement",
    "schema/invalid": "a document does not conform to its schema",
    "contract/unpaired-example": "an example has no schema, or a schema has no example",
    "analysis/duplicate-event-id": "two analysis events share an id",
    "analysis/duplicate-stem-id": "two stems share an id",
    "analysis/duplicate-detector-id": "two detectors share an id",
    "analysis/unknown-stem-ref": "an event points at a stem that is not declared",
    "analysis/unknown-detector-ref": "a beat or event points at a detector that is not declared",
    "analysis/end-before-start": "an event ends before it starts",
    "analysis/duration-mismatch": "durationSec disagrees with endSec - startSec",
    "analysis/end-kind-mismatch": "endSec or durationSec disagrees with the event's endKind",
    "analysis/beats-not-ascending": "beats are not in ascending time order",
    "analysis/events-not-ascending": "events are not ordered by (startSec, id)",
    "chart/duplicate-note-id": "two notes share an id",
    "chart/lane-out-of-range": "a note sits outside the playfield",
    "chart/end-lane-out-of-range": "a note ends outside the playfield",
    "chart/end-not-after-start": "endTimeSec is not after timeSec",
    "chart/hold-missing-end": "a held note has no endTimeSec",
    "chart/waypoints-not-on-slide": "a note that is not a slide carries waypoints",
    "chart/waypoints-without-end": "a slide has waypoints but no end",
    "chart/waypoint-lane-out-of-range": "a slide waypoint sits outside the playfield",
    "chart/waypoints-not-ascending": "a slide's points do not strictly ascend in time",
    "chart/end-action-without-end": "a note has an endAction but no end to act at",
    "chart/end-action-wrong-kind": "an endAction is on a kind that cannot carry one",
    "chart/end-action-flick-without-direction": "a flick endAction names no direction",
    "chart/connection-unknown-note": "a connection names a note that is not in the chart",
    "chart/connection-self": "a connection joins a note to itself",
    "chart/connection-endpoint-kind": "a connection joins notes of the wrong kind",
    "chart/connection-not-forward": "a connection does not run forwards in time",
    "chart/connection-duplicate": "the same two notes are connected twice",
    "chart/connection-branches": "a note is connected onwards, or back to, more than once",
    "chart/notes-not-ascending": "notes are not in ascending time order",
    "chart/duplicate-decoration-id": "two decorations share an id",
    "chart/decoration-end-not-after-start": "a decoration ends at or before it starts",
    "chart/text-decoration-missing-text": "a text decoration has no text to draw",
    "chart/decorations-not-ascending": "decorations are not in ascending start order",
    "chart/bpm-changes-not-ascending": "bpmChanges are not in ascending time order",
    "project/missing-reference": "a referenced document does not exist",
    "cross/unknown-source-event": "sourceEventId does not resolve to an analysis event",
    "cross/audio-mismatch": "documents in one project refer to different audio",
    "cross/audio-duration-mismatch": "documents in one project disagree on audio duration",
    "cross/audio-sha256-mismatch": "documents in one project disagree on the audio hash",
}

TOLERANCE_SEC = 1e-6


class Problems:
    """Collects (code, message) pairs. A check never raises; it records."""

    def __init__(self):
        self.items = []

    def add(self, code, message):
        assert code in CODES, "unregistered problem code: " + code
        self.items.append((code, message))

    def codes(self):
        return {code for code, _ in self.items}

    def __bool__(self):
        return bool(self.items)

    def __len__(self):
        return len(self.items)


# --------------------------------------------------------------------------------
# JSON loading
# --------------------------------------------------------------------------------


def load_json(path, problems, label=None):
    """Return the parsed document, or None after recording why it could not load."""
    label = label or rel(path)
    if not path.exists():
        problems.add("json/missing-file", label + ": file does not exist")
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        problems.add("json/parse-error", label + ": " + str(exc))
        return None


def rel(path):
    try:
        return Path(path).resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


# --------------------------------------------------------------------------------
# Minimal JSON Schema validator (subset used by the Chart Forge schemas)
# --------------------------------------------------------------------------------

_SIMPLE_TYPES = ("object", "array", "string", "boolean", "integer", "number", "null")

#: Keywords this validator enforces.
_HANDLED_KEYWORDS = {
    "type", "const", "enum", "oneOf", "required", "properties", "additionalProperties",
    "items", "minLength", "pattern", "minimum", "maximum", "exclusiveMinimum",
    "exclusiveMaximum",
}

#: Keywords that carry no constraint here: annotations, identifiers, and `format`,
#: which draft 2020-12 treats as an annotation unless a validator opts in.
_IGNORED_KEYWORDS = {
    "$schema", "$id", "$defs", "$comment", "$ref", "title", "description", "examples",
    "default", "deprecated", "readOnly", "writeOnly", "format",
}


def resolve_ref(schema, root):
    """Follow internal $refs, letting sibling keywords override the target."""
    depth = 0
    while isinstance(schema, dict) and "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise KeyError("external $ref is not supported: " + ref)
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        siblings = {k: v for k, v in schema.items() if k != "$ref"}
        schema = dict(node)
        schema.update(siblings)
        depth += 1
        if depth > 16:
            raise KeyError("$ref loop at " + ref)
    return schema


def _type_ok(value, name):
    if name == "boolean":
        return isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "null":
        return value is None
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    raise KeyError("unsupported type keyword: " + name)


def check_instance(value, schema, root, path, out):
    """Append plain strings describing how `value` fails `schema`."""
    schema = resolve_ref(schema, root)

    # A keyword this validator does not implement would be silently ignored, and the
    # schema would then constrain less than it appears to. Refuse instead, so that
    # growing the schemas forces a decision about growing the validator.
    unknown = set(schema) - _HANDLED_KEYWORDS - _IGNORED_KEYWORDS
    if unknown:
        raise KeyError(
            "{0}: unsupported schema keyword(s): {1}".format(path, ", ".join(sorted(unknown)))
        )

    if "oneOf" in schema:
        matched = []
        for index, branch in enumerate(schema["oneOf"]):
            branch_errors = []
            check_instance(value, branch, root, path, branch_errors)
            if not branch_errors:
                matched.append(index)
        if len(matched) != 1:
            out.append(
                "{0}: matched {1} of the {2} oneOf branches, expected exactly 1".format(
                    path, len(matched), len(schema["oneOf"])
                )
            )
        return

    declared = schema.get("type")
    if declared is not None:
        names = declared if isinstance(declared, list) else [declared]
        for name in names:
            if name not in _SIMPLE_TYPES:
                raise KeyError("unsupported type keyword: " + name)
        if not any(_type_ok(value, name) for name in names):
            out.append(
                "{0}: expected type {1}, got {2}".format(
                    path, "/".join(names), type(value).__name__
                )
            )
            return

    if "const" in schema and value != schema["const"]:
        out.append("{0}: expected {1!r}, got {2!r}".format(path, schema["const"], value))
    if "enum" in schema and value not in schema["enum"]:
        out.append("{0}: {1!r} is not one of {2}".format(path, value, schema["enum"]))

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            out.append("{0}: shorter than minLength {1}".format(path, schema["minLength"]))
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            out.append(
                "{0}: {1!r} does not match pattern {2}".format(path, value, schema["pattern"])
            )

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        bounds = (
            ("minimum", lambda a, b: a >= b, ">="),
            ("maximum", lambda a, b: a <= b, "<="),
            ("exclusiveMinimum", lambda a, b: a > b, ">"),
            ("exclusiveMaximum", lambda a, b: a < b, "<"),
        )
        for keyword, holds, symbol in bounds:
            if keyword in schema and not holds(value, schema[keyword]):
                out.append(
                    "{0}: {1} is not {2} {3}".format(path, value, symbol, schema[keyword])
                )

    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                out.append("{0}: missing required property {1!r}".format(path, name))
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties", True)
        for key, child in value.items():
            if key in properties:
                check_instance(child, properties[key], root, path + "." + key, out)
            elif additional is False:
                out.append("{0}: property {1!r} is not allowed".format(path, key))

    if isinstance(value, list) and "items" in schema:
        for index, child in enumerate(value):
            check_instance(child, schema["items"], root, "{0}[{1}]".format(path, index), out)


def iter_subschemas(node, path="$"):
    """Every position in a schema that is itself a schema, for the keywords we use."""
    if not isinstance(node, dict):
        return
    yield path, node
    for keyword in ("properties", "$defs"):
        for name, child in node.get(keyword, {}).items():
            for found in iter_subschemas(child, "{0}/{1}/{2}".format(path, keyword, name)):
                yield found
    for found in iter_subschemas(node.get("items"), path + "/items"):
        yield found
    for found in iter_subschemas(node.get("additionalProperties"),
                                 path + "/additionalProperties"):
        yield found
    for index, branch in enumerate(node.get("oneOf", [])):
        for found in iter_subschemas(branch, "{0}/oneOf[{1}]".format(path, index)):
            yield found


def unsupported_keywords(schema):
    """Report every keyword in the schema that this validator would silently ignore.

    Checked statically, over the whole schema: the runtime guard in check_instance only
    sees the branches an example happens to reach, so a keyword sitting in an unvisited
    branch would otherwise look enforced when it is not.
    """
    found = []
    for path, node in iter_subschemas(schema):
        unknown = set(node) - _HANDLED_KEYWORDS - _IGNORED_KEYWORDS
        for keyword in sorted(unknown):
            found.append((path, keyword))
    return found


def validate_against_schema(document, schema, label, problems):
    errors = []
    try:
        check_instance(document, schema, schema, "$", errors)
    except KeyError as exc:
        problems.add("schema/bad-ref", "{0}: {1}".format(label, exc))
        return
    for error in errors:
        problems.add("schema/invalid", "{0}: {1}".format(label, error))


# --------------------------------------------------------------------------------
# Constraints a JSON Schema cannot express
# --------------------------------------------------------------------------------


def is_ascending(values):
    """Non-decreasing. Simultaneous beats or notes are legitimate; going back is not."""
    return list(values) == sorted(values)


def check_analysis(document, label, problems):
    stem_ids = set()
    for stem in document.get("stems", []):
        if stem["id"] in stem_ids:
            problems.add(
                "analysis/duplicate-stem-id",
                "{0}: stem id {1!r} appears more than once".format(label, stem["id"]),
            )
        stem_ids.add(stem["id"])

    detector_ids = set()
    for detector in document.get("detectors", []):
        if detector["id"] in detector_ids:
            problems.add(
                "analysis/duplicate-detector-id",
                "{0}: detector id {1!r} appears more than once".format(
                    label, detector["id"]
                ),
            )
        detector_ids.add(detector["id"])

    for index, beat in enumerate(document.get("beats", [])):
        ref = beat.get("detectorId")
        if ref is not None and ref not in detector_ids:
            problems.add(
                "analysis/unknown-detector-ref",
                "{0}: beat {1} at {2}s references detector {3!r}, which is not "
                "declared".format(label, index, beat.get("timeSec"), ref),
            )

    event_ids = set()
    for event in document.get("events", []):
        event_id = event["id"]
        if event_id in event_ids:
            problems.add(
                "analysis/duplicate-event-id",
                "{0}: event id {1!r} appears more than once".format(label, event_id),
            )
        event_ids.add(event_id)

        stem_ref = event.get("source", {}).get("stemId")
        if stem_ref is not None and stem_ref not in stem_ids:
            problems.add(
                "analysis/unknown-stem-ref",
                "{0}: event {1!r} references stem {2!r}, which is not declared".format(
                    label, event_id, stem_ref
                ),
            )

        detector_ref = event.get("detectorId")
        if detector_ref is not None and detector_ref not in detector_ids:
            problems.add(
                "analysis/unknown-detector-ref",
                "{0}: event {1!r} references detector {2!r}, which is not declared".format(
                    label, event_id, detector_ref
                ),
            )

        start = event["startSec"]
        end = event.get("endSec")
        if end is not None and end < start:
            problems.add(
                "analysis/end-before-start",
                "{0}: event {1!r} ends at {2} but starts at {3}".format(
                    label, event_id, end, start
                ),
            )
        duration = event.get("durationSec")
        if end is not None and duration is not None:
            if abs((end - start) - duration) > TOLERANCE_SEC:
                problems.add(
                    "analysis/duration-mismatch",
                    "{0}: event {1!r} has durationSec {2} but endSec - startSec is {3}".format(
                        label, event_id, duration, end - start
                    ),
                )

        # endKind is what makes a missing endSec unambiguous, so the two must agree.
        end_kind = event.get("endKind")
        if end_kind == "bounded" and end is None:
            problems.add(
                "analysis/end-kind-mismatch",
                "{0}: event {1!r} has endKind 'bounded' but no endSec".format(
                    label, event_id
                ),
            )
        if end_kind in ("instantaneous", "unknown"):
            for field, value in (("endSec", end), ("durationSec", duration)):
                if value is not None:
                    problems.add(
                        "analysis/end-kind-mismatch",
                        "{0}: event {1!r} has endKind {2!r} but also {3} {4}".format(
                            label, event_id, end_kind, field, value
                        ),
                    )

    beats = [beat["timeSec"] for beat in document.get("beats", [])]
    if not is_ascending(beats):
        problems.add(
            "analysis/beats-not-ascending",
            "{0}: beats[].timeSec is not in ascending order".format(label),
        )

    # Events carry a total order: startSec, then id for events sharing a timestamp.
    order = [(event["startSec"], event["id"]) for event in document.get("events", [])]
    if not is_ascending(order):
        problems.add(
            "analysis/events-not-ascending",
            "{0}: events[] is not ordered by (startSec, id)".format(label),
        )


#: Kinds that can finish with something other than an ordinary release. A tap, a purple
#: and a flick are instants - there is no end for an action to happen at.
END_ACTION_KINDS = ("hold", "slide")


def check_note_end_action(note, note_id, label, problems):
    """The rules the schema cannot state about how a note finishes.

    JSON Schema can say an endAction is a {type, direction} object; it cannot say the note
    must actually have an end for the action to happen at, or that only a held or
    travelling note has one. Those are cross-field facts, so they live here.
    """
    action = note.get("endAction")
    if action is None:
        return

    if note.get("endTimeSec") is None:
        # Without an end there is no moment for the action to happen at, and a reader
        # that ignored the field would see an instantaneous note - so the documented
        # fallback would disagree with the full reading.
        problems.add(
            "chart/end-action-without-end",
            "{0}: note {1!r} has an endAction but no endTimeSec".format(label, note_id),
        )

    if note["type"] not in END_ACTION_KINDS:
        problems.add(
            "chart/end-action-wrong-kind",
            "{0}: {1} note {2!r} cannot carry an endAction; only {3} can".format(
                label, note["type"], note_id, " and ".join(END_ACTION_KINDS)
            ),
        )

    if action.get("type") == "flick" and action.get("direction") is None:
        problems.add(
            "chart/end-action-flick-without-direction",
            "{0}: note {1!r} ends in a flick with no direction".format(label, note_id),
        )


#: What each kind of connection may join. A flick run is a run of flicks.
CONNECTION_ENDPOINT_TYPES = {"flick": ("flick",)}


def check_chart_connections(document, label, problems):
    """Whether the links between notes describe runs that can actually be followed.

    JSON Schema can say a connection is a {type, fromNoteId, toNoteId} object; it cannot
    say the ids name notes that exist in *this* chart, that a run goes forwards, or that
    no note is joined onwards twice. Those are facts about the document as a whole.

    Note what is *not* checked separately: a loop. A connection must run strictly forwards
    in time, so a sequence of them can never return to where it began - the forward rule
    makes a cycle unrepresentable rather than merely forbidden.
    """
    connections = document.get("connections")
    if not connections:
        return

    by_id = {note["id"]: note for note in document.get("notes", [])}
    seen_pairs = set()
    outgoing = set()
    incoming = set()

    for connection in connections:
        source = connection["fromNoteId"]
        target = connection["toNoteId"]

        if source == target:
            problems.add(
                "chart/connection-self",
                "{0}: a connection joins note {1!r} to itself".format(label, source),
            )
            continue

        missing = [note_id for note_id in (source, target) if note_id not in by_id]
        if missing:
            problems.add(
                "chart/connection-unknown-note",
                "{0}: a connection names {1}, which is not in the chart".format(
                    label, ", ".join(repr(note_id) for note_id in missing)
                ),
            )
            continue

        wanted = CONNECTION_ENDPOINT_TYPES.get(connection["type"])
        if wanted is not None:
            wrong = [
                note_id for note_id in (source, target)
                if by_id[note_id]["type"] not in wanted
            ]
            if wrong:
                problems.add(
                    "chart/connection-endpoint-kind",
                    "{0}: a {1} connection joins {2}, which is not {3}".format(
                        label, connection["type"],
                        ", ".join(repr(note_id) for note_id in wrong),
                        " or ".join(wanted),
                    ),
                )

        if by_id[source]["timeSec"] >= by_id[target]["timeSec"]:
            problems.add(
                "chart/connection-not-forward",
                "{0}: the connection {1!r} -> {2!r} does not run forwards in time".format(
                    label, source, target
                ),
            )

        pair = (source, target)
        if pair in seen_pairs:
            problems.add(
                "chart/connection-duplicate",
                "{0}: {1!r} -> {2!r} appears more than once".format(label, source, target),
            )
        seen_pairs.add(pair)

        # One way onward and one way back, so every run is a simple chain that can be
        # followed without choosing between branches.
        if source in outgoing:
            problems.add(
                "chart/connection-branches",
                "{0}: note {1!r} is connected onwards more than once".format(label, source),
            )
        if target in incoming:
            problems.add(
                "chart/connection-branches",
                "{0}: note {1!r} is connected back to more than once".format(label, target),
            )
        outgoing.add(source)
        incoming.add(target)


def check_slide_waypoints(note, note_id, lane_count, label, problems):
    """The rules the schema cannot state about a multi-point slide.

    JSON Schema can say a waypoint is a {timeSec, lane} object; it cannot say the points
    have to march forwards in time, that they must stay inside *this* chart's playfield,
    or that only a slide travels. Those are cross-field facts, so they live here with the
    other ones.
    """
    waypoints = note.get("waypoints")
    if waypoints is None:
        return

    if note["type"] != "slide":
        problems.add(
            "chart/waypoints-not-on-slide",
            "{0}: {1} note {2!r} carries waypoints; only a slide travels".format(
                label, note["type"], note_id
            ),
        )

    end_time = note.get("endTimeSec")
    end_lane = note.get("endLane")
    if end_time is None or end_lane is None:
        # Waypoints are the middle of a journey. Without an end there is no journey, and
        # a reader that ignored `waypoints` would see a lone point rather than a slide -
        # so the documented fallback would disagree with the full reading.
        problems.add(
            "chart/waypoints-without-end",
            "{0}: note {1!r} has waypoints but no endTimeSec/endLane".format(
                label, note_id
            ),
        )

    for index, point in enumerate(waypoints):
        if not 0 <= point["lane"] < lane_count:
            problems.add(
                "chart/waypoint-lane-out-of-range",
                "{0}: note {1!r} waypoint {2} is in lane {3}, outside 0..{4}".format(
                    label, note_id, index, point["lane"], lane_count - 1
                ),
            )

    # Every point of the slide, start to end, must be strictly later than the one before.
    # Two points at the same instant are not a direction to travel in, and a point out of
    # order would make the drawn path double back on itself.
    times = [note["timeSec"]]
    times.extend(point["timeSec"] for point in waypoints)
    if end_time is not None:
        times.append(end_time)
    if any(later <= earlier for earlier, later in zip(times, times[1:])):
        problems.add(
            "chart/waypoints-not-ascending",
            "{0}: note {1!r} has points at {2}, which do not strictly ascend".format(
                label, note_id, times
            ),
        )


def check_chart_decorations(document, label, problems):
    """The rules a Decoration must obey that JSON Schema cannot state.

    Decorations are presentation, not gameplay, so nothing here reaches into the notes:
    a decoration names no note, and no rule below needs one. What is checked is that each
    is identifiable, that it occupies a real stretch of time, that a decoration claiming
    to be text has something to draw, and that the list is ordered - the same streaming
    guarantee `notes` gives a Player, for the same reason.
    """
    seen = set()
    for decoration in document.get("decorations", []):
        decoration_id = decoration["id"]
        if decoration_id in seen:
            problems.add(
                "chart/duplicate-decoration-id",
                "{0}: decoration id {1!r} appears more than once".format(
                    label, decoration_id
                ),
            )
        seen.add(decoration_id)

        start = decoration["startTimeSec"]
        end = decoration.get("endTimeSec")
        if end is not None and end <= start:
            # chart.schema.json states endTimeSec "must be greater than startTimeSec":
            # a decoration shown for no time is not shown.
            problems.add(
                "chart/decoration-end-not-after-start",
                "{0}: decoration {1!r} ends at {2} but starts at {3}".format(
                    label, decoration_id, end, start
                ),
            )

        # `text` is optional on the shared shape because a later decoration kind will not
        # have one, and required by this kind - the same arrangement `hold` and
        # `endTimeSec` already have.
        if decoration["type"] == "text" and decoration.get("text") is None:
            problems.add(
                "chart/text-decoration-missing-text",
                "{0}: text decoration {1!r} has no text".format(label, decoration_id),
            )

    starts = [
        decoration["startTimeSec"] for decoration in document.get("decorations", [])
    ]
    if not is_ascending(starts):
        problems.add(
            "chart/decorations-not-ascending",
            "{0}: decorations[].startTimeSec is not in ascending order".format(label),
        )


def check_chart(document, label, problems):
    lane_count = document["playfield"]["laneCount"]

    note_ids = set()
    for note in document.get("notes", []):
        note_id = note["id"]
        if note_id in note_ids:
            problems.add(
                "chart/duplicate-note-id",
                "{0}: note id {1!r} appears more than once".format(label, note_id),
            )
        note_ids.add(note_id)

        lane = note["lane"]
        if not 0 <= lane < lane_count:
            problems.add(
                "chart/lane-out-of-range",
                "{0}: note {1!r} is in lane {2}, outside 0..{3}".format(
                    label, note_id, lane, lane_count - 1
                ),
            )
        end_lane = note.get("endLane")
        if end_lane is not None and not 0 <= end_lane < lane_count:
            problems.add(
                "chart/end-lane-out-of-range",
                "{0}: note {1!r} ends in lane {2}, outside 0..{3}".format(
                    label, note_id, end_lane, lane_count - 1
                ),
            )

        end_time = note.get("endTimeSec")
        if end_time is not None and end_time <= note["timeSec"]:
            # chart.schema.json states endTimeSec "must be greater than timeSec": a
            # zero-length hold is not a hold.
            problems.add(
                "chart/end-not-after-start",
                "{0}: note {1!r} ends at {2} but starts at {3}".format(
                    label, note_id, end_time, note["timeSec"]
                ),
            )
        # A hold with no end is not a hold. A slide with no end is a single judgement
        # point that has not been joined to another one yet - a legitimate thing to have
        # saved halfway through building a slide, and the shape the Editor places one
        # point at a time.
        if note["type"] == "hold" and end_time is None:
            problems.add(
                "chart/hold-missing-end",
                "{0}: hold note {1!r} has no endTimeSec".format(label, note_id),
            )

        check_slide_waypoints(note, note_id, lane_count, label, problems)
        check_note_end_action(note, note_id, label, problems)

    check_chart_connections(document, label, problems)
    check_chart_decorations(document, label, problems)

    times = [note["timeSec"] for note in document.get("notes", [])]
    if not is_ascending(times):
        problems.add(
            "chart/notes-not-ascending",
            "{0}: notes[].timeSec is not in ascending order".format(label),
        )

    changes = [change["timeSec"] for change in document["timing"].get("bpmChanges", [])]
    if not is_ascending(changes):
        problems.add(
            "chart/bpm-changes-not-ascending",
            "{0}: timing.bpmChanges[].timeSec is not in ascending order".format(label),
        )


def check_analysis_chart(analysis, chart, chart_label, problems):
    """The only link between the two documents: a note's optional provenance."""
    event_ids = {event["id"] for event in analysis.get("events", [])}
    for note in chart.get("notes", []):
        source = note.get("sourceEventId")
        if source is not None and source not in event_ids:
            problems.add(
                "cross/unknown-source-event",
                "{0}: note {1!r} has sourceEventId {2!r}, which is not an event in the "
                "project's analysis".format(chart_label, note["id"], source),
            )


def resolve_document_ref(reference, base_dir, label, problems):
    """Return (document, resolved_path). Either may be None."""
    if reference is None:
        return None, None
    if reference.get("kind") == "inline":
        return reference["data"], None
    target = (base_dir / reference["path"]).resolve()
    if not target.exists():
        problems.add(
            "project/missing-reference",
            "{0}: references {1!r}, which does not exist".format(label, reference["path"]),
        )
        return None, target
    return load_json(target, problems), target


def check_project_consistency(project, project_path, analysis, analysis_path, chart,
                              chart_path, problems):
    """A project asserts that its audio, analysis and chart belong together."""
    base = project_path.parent

    def audio_path_of(document, document_path):
        if document is None:
            return None
        path = document.get("audio", {}).get("path")
        if path is None:
            return None
        anchor = document_path.parent if document_path is not None else base
        return (anchor / path).resolve()

    label = rel(project_path)
    entries = [
        ("project", audio_path_of(project, project_path), project.get("audio", {})),
        ("analysis", audio_path_of(analysis, analysis_path),
         (analysis or {}).get("audio", {})),
        ("chart", audio_path_of(chart, chart_path), (chart or {}).get("audio", {})),
    ]
    known = [(name, path, audio) for name, path, audio in entries if path is not None]

    reference_name, reference_path, reference_audio = known[0]
    for name, path, audio in known[1:]:
        if path != reference_path:
            problems.add(
                "cross/audio-mismatch",
                "{0}: the {1} points at {2} but the {3} points at {4}".format(
                    label, name, rel(path), reference_name, rel(reference_path)
                ),
            )
        for field, code in (
            ("durationSec", "cross/audio-duration-mismatch"),
            ("sha256", "cross/audio-sha256-mismatch"),
        ):
            mine, theirs = audio.get(field), reference_audio.get(field)
            if mine is not None and theirs is not None and mine != theirs:
                problems.add(
                    code,
                    "{0}: the {1} says audio {2} is {3!r}, the {4} says {5!r}".format(
                        label, name, field, mine, reference_name, theirs
                    ),
                )


# --------------------------------------------------------------------------------
# Bundles: run every applicable check over a set of documents
# --------------------------------------------------------------------------------


def validate_bundle(paths, schemas, problems):
    """Validate whichever of analysis / chart / project are present in `paths`.

    `paths` maps a document kind to a path on disk. A project pulls in the analysis and
    the chart it references, so a project fixture needs nothing else. Checks that need
    two documents run only when both are available, which keeps every fixture as small
    as the case it covers.
    """
    paths = {kind: Path(path).resolve() for kind, path in paths.items()}
    seen = set(paths.values())

    def schema_check(document, kind, path):
        """Return the document, or None when it does not match its schema."""
        if document is None:
            return None
        schema = schemas.get(kind)
        if schema is None:
            return document
        before = len(problems)
        validate_against_schema(document, schema, rel(path), problems)
        # The structural checks below index into the document, so a document of the
        # wrong shape is dropped here rather than crashing later.
        return document if len(problems) == before else None

    documents = {}
    for kind, path in paths.items():
        documents[kind] = schema_check(load_json(path, problems), kind, path)

    analysis = documents.get("analysis")
    chart = documents.get("chart")
    project = documents.get("project")
    analysis_path = paths.get("analysis")
    chart_path = paths.get("chart")
    project_path = paths.get("project")

    if project is not None:
        base = project_path.parent
        for kind in ("analysis", "chart"):
            document, path = resolve_document_ref(
                project.get(kind), base, rel(project_path) + " -> " + kind, problems
            )
            if document is None or documents.get(kind) is not None:
                continue
            if path is not None and path not in seen:
                seen.add(path)
                document = schema_check(document, kind, path)
            if kind == "analysis":
                analysis, analysis_path = document, path
            else:
                chart, chart_path = document, path

    if analysis is not None:
        check_analysis(analysis, rel(analysis_path) if analysis_path else "analysis", problems)
    if chart is not None:
        check_chart(chart, rel(chart_path) if chart_path else "chart", problems)

    if project is not None:
        check_project_consistency(
            project, project_path, analysis, analysis_path, chart, chart_path, problems
        )

    if analysis is not None and chart is not None:
        check_analysis_chart(
            analysis, chart, rel(chart_path) if chart_path else "chart", problems
        )


# --------------------------------------------------------------------------------
# Test runs
# --------------------------------------------------------------------------------


class Report:
    def __init__(self, quiet=False):
        self.quiet = quiet
        self.failures = 0

    def ok(self, message):
        if not self.quiet:
            print("  [ok]   " + message)

    def fail(self, message):
        self.failures += 1
        print("  [FAIL] " + message)

    def note(self, message):
        if not self.quiet:
            print("  " + message)

    def heading(self, message):
        if not self.quiet:
            print("\n== " + message + " ==")


def load_schemas(report):
    """Parse the schemas, check their meta-schema and that every $ref resolves."""
    schemas = {}
    for path in sorted((REPO_ROOT / "schemas").glob("*.schema.json")):
        kind = path.name[: -len(".schema.json")]
        problems = Problems()
        document = load_json(path, problems)
        if document is None:
            for code, message in problems.items:
                report.fail("{0}: {1}".format(code, message))
            continue

        if document.get("$schema") != META_SCHEMA:
            report.fail(
                "schema/meta: {0} declares {1!r}, expected the 2020-12 meta-schema".format(
                    rel(path), document.get("$schema")
                )
            )
            continue

        bad_ref = None
        for match in re.finditer(r'"\$ref"\s*:\s*"([^"]+)"', json.dumps(document)):
            ref = match.group(1)
            if not ref.startswith("#/"):
                bad_ref = ref + " (external refs are not supported)"
                break
            node = document
            try:
                for part in ref[2:].split("/"):
                    node = node[part]
            except (KeyError, TypeError):
                bad_ref = ref
                break
        if bad_ref is not None:
            report.fail("schema/bad-ref: {0}: {1}".format(rel(path), bad_ref))
            continue

        unsupported = unsupported_keywords(document)
        if unsupported:
            for where, keyword in unsupported:
                report.fail(
                    "schema/unsupported-keyword: {0}: {1} uses {2!r}, which the contract "
                    "test does not enforce".format(rel(path), where, keyword)
                )
            continue

        schemas[kind] = document
        report.ok(
            "{0} parses, declares 2020-12, every $ref resolves, and every keyword is "
            "enforced".format(rel(path))
        )
    return schemas


def run_positive(schemas, report):
    """Every example must parse, conform, and satisfy every cross-document rule."""
    example_dir = REPO_ROOT / "examples"
    on_disk = {
        path.name[: -len(".schema.json")]
        for path in (REPO_ROOT / "schemas").glob("*.schema.json")
    }
    examples = {}
    for path in sorted(example_dir.glob("*.example.json")):
        kind = path.name[: -len(".example.json")]
        if kind not in schemas:
            # A schema that exists but failed to load was already reported above;
            # saying it is missing as well would be misleading.
            if kind not in on_disk:
                report.fail("contract/unpaired-example: {0} has no schema".format(rel(path)))
            continue
        examples[kind] = path
    for kind in schemas:
        if kind not in examples:
            report.fail(
                "contract/unpaired-example: schemas/{0}.schema.json has no example".format(kind)
            )

    if not examples:
        return

    problems = Problems()
    validate_bundle(examples, schemas, problems)

    reported = set()
    for kind, path in sorted(examples.items()):
        related = [
            (code, message) for code, message in problems.items if rel(path) in message
        ]
        for code, message in related:
            reported.add(message)
            report.fail("{0}: {1}".format(code, message))
        if not related:
            report.ok("{0} conforms and satisfies every contract check".format(rel(path)))

    for code, message in problems.items:
        if message not in reported:
            report.fail("{0}: {1}".format(code, message))

    if not problems:
        report.ok("cross-document: sourceEventId resolves, project references exist, "
                  "audio agrees across documents")


def run_negative(schemas, report):
    """Every broken fixture must fail, for exactly the expected reason."""
    problems = Problems()
    cases_document = load_json(CASES_FILE, problems)
    if cases_document is None:
        for code, message in problems.items:
            report.fail("{0}: {1}".format(code, message))
        return set()

    covered = set()
    for case in cases_document["cases"]:
        expected = set(case["expect"])
        covered |= expected
        paths = {
            kind: REPO_ROOT / relative for kind, relative in case["documents"].items()
        }
        case_problems = Problems()
        try:
            validate_bundle(paths, schemas, case_problems)
        except Exception as exc:  # a fixture must never crash the validator
            report.fail(
                "{0}: the validator raised {1}: {2}".format(
                    case["name"], type(exc).__name__, exc
                )
            )
            continue

        actual = case_problems.codes()
        if actual == expected:
            report.ok(
                "{0} -> {1}".format(case["name"], ", ".join(sorted(actual)) or "(nothing)")
            )
        elif not actual:
            report.fail(
                "{0}: expected {1} but the document passed every check".format(
                    case["name"], ", ".join(sorted(expected))
                )
            )
        else:
            report.fail(
                "{0}: expected {1} but got {2}".format(
                    case["name"], ", ".join(sorted(expected)), ", ".join(sorted(actual))
                )
            )
            for code, message in case_problems.items:
                report.note("         {0}: {1}".format(code, message))
    return covered


def report_coverage(covered, report):
    uncovered = sorted(set(CODES) - covered)
    if not uncovered:
        report.ok("every problem code has a negative fixture")
        return
    report.note(
        "{0} of {1} problem codes have a negative fixture; not yet covered:".format(
            len(covered), len(CODES)
        )
    )
    for code in uncovered:
        report.note("         - {0} ({1})".format(code, CODES[code]))


EXTERNAL_KINDS = {
    "analysis": ("analysis.schema.json", check_analysis, "Analysis"),
    "chart": ("chart.schema.json", check_chart, "Chart"),
}


def run_external_document(path, report, kind):
    """Validate one Analysis or Chart document that lives outside the repository.

    Only that one contract is exercised: the schema, then the same semantic checks the
    repository's own examples go through. No project, no cross-document checks, no
    fixtures, and nothing in the repository is copied or modified.

    A Chart written by the Editor is the case this exists for: the document lives beside
    the audio in a working directory that is deliberately not part of this repository, so
    there has to be a way to hold it to the contract from outside.
    """
    schema_name, semantic_check, label = EXTERNAL_KINDS[kind]
    target = Path(path).expanduser().resolve()
    if not report.quiet:
        print("Chart Forge {0} validation".format(label))
        print("repository: " + str(REPO_ROOT))
        print("document:   " + str(target))

    report.heading("schema")
    problems = Problems()
    schema_path = REPO_ROOT / "schemas" / schema_name
    schema = load_json(schema_path, problems)
    if schema is None:
        for code, message in problems.items:
            report.fail("{0}: {1}".format(code, message))
        return 1
    unsupported = unsupported_keywords(schema)
    if unsupported:
        for where, keyword in unsupported:
            report.fail(
                "schema/unsupported-keyword: {0}: {1} uses {2!r}, which the contract "
                "test does not enforce".format(rel(schema_path), where, keyword)
            )
        return 1
    report.ok("{0} loaded".format(rel(schema_path)))

    report.heading("document")
    document = load_json(target, problems, label=str(target))
    for code, message in problems.items:
        report.fail("{0}: {1}".format(code, message))
    if document is None:
        print()
        print("FAILED: {0} problem(s)".format(report.failures))
        return 1

    schema_problems = Problems()
    validate_against_schema(document, schema, str(target), schema_problems)
    for code, message in schema_problems.items:
        report.fail("{0}: {1}".format(code, message))
    if not schema_problems:
        report.ok("conforms to {0}".format(schema_name))

    if schema_problems:
        report.note("skipping semantic checks: the document does not match its schema")
    else:
        semantic = Problems()
        semantic_check(document, str(target), semantic)
        for code, message in semantic.items:
            report.fail("{0}: {1}".format(code, message))
        if not semantic:
            report.ok("satisfies every {0} semantic check".format(label))

    print()
    if report.failures:
        print("FAILED: {0} problem(s)".format(report.failures))
        return 1
    print("PASSED")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="Two modes: with no arguments the full repository contract suite runs "
               "(schemas, examples, negative fixtures, coverage). With --analysis or "
               "--chart, only the given document is validated against its own schema in "
               "schemas/ and that document type's semantic checks.",
    )
    parser.add_argument(
        "--repo-root", default=None, help="repository root (default: the parent of tests/)"
    )
    parser.add_argument(
        "--analysis", default=None, metavar="PATH",
        help="validate a single Analysis JSON document at PATH (absolute or relative) "
             "instead of running the repository suite; exits 0 when it is valid",
    )
    parser.add_argument(
        "--chart", default=None, metavar="PATH",
        help="validate a single Chart JSON document at PATH (absolute or relative) "
             "instead of running the repository suite; exits 0 when it is valid",
    )
    parser.add_argument("--quiet", action="store_true", help="print failures only")
    args = parser.parse_args(argv)

    global REPO_ROOT, FIXTURES, CASES_FILE
    if args.repo_root:
        REPO_ROOT = Path(args.repo_root).resolve()
        FIXTURES = REPO_ROOT / "tests" / "fixtures"
        CASES_FILE = FIXTURES / "cases.json"

    report = Report(quiet=args.quiet)

    if args.analysis and args.chart:
        parser.error("--analysis and --chart validate one document each; give only one")
    if args.analysis:
        return run_external_document(args.analysis, report, "analysis")
    if args.chart:
        return run_external_document(args.chart, report, "chart")

    if not args.quiet:
        print("Chart Forge contract tests")
        print("repository: " + str(REPO_ROOT))

    report.heading("schemas")
    schemas = load_schemas(report)

    report.heading("examples")
    if schemas:
        run_positive(schemas, report)
    else:
        report.fail("no usable schema was loaded; skipping the example checks")

    report.heading("negative fixtures")
    covered = run_negative(schemas, report) if schemas else set()

    report.heading("coverage")
    report_coverage(covered, report)

    print()
    if report.failures:
        print("FAILED: {0} problem(s)".format(report.failures))
        return 1
    print("PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
