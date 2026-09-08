/**
 * What the selected decoration says, and every property of it an author can change.
 *
 * A sibling of the note inspector rather than an extension of it. The two describe
 * different objects with different fields, and one panel that switched between them would
 * be one panel with two halves that were always both nearly wrong.
 *
 * The fields are grouped the way an author thinks about them - what it says, when, where,
 * how it looks, how it arrives - because a single flat column of sixteen inputs is a
 * panel nobody reads. Each group is a `<details>` that remembers nothing: the text and
 * the timing are open, the rest closed, so the panel opens on the two things that are
 * always being adjusted and the rest is one click away.
 *
 * Every numeric input is committed on change and clamped by the command behind it, so an
 * out-of-range number cannot reach the document; and every edit is one command, so it is
 * one step of undo.
 */

import {
  ANIMATION_KINDS, DEFAULT_TEXT_STYLE, FONT_FAMILIES, TEXT_ALIGNMENTS,
  displayWindow, isTextDecoration, resolveTextStyle,
  type AnimationKind, type ChartDecoration, type FontFamily, type TextAlign,
} from "../core/decoration";
import {
  DEFAULT_METEOR_COLOR, DEFAULT_METEOR_INTENSITY, DEFAULT_METEOR_RATE,
  DEFAULT_SHIMMER_INTENSITY, DEFAULT_SHIMMER_PERIOD_SEC,
  DEFAULT_SPARKLE_INTENSITY, DEFAULT_SPARKLE_RATE,
  DEFAULT_GLOW_COLOR, DEFAULT_GLOW_INTENSITY, DEFAULT_GLOW_RADIUS,
  METEOR_DIRECTIONS, type MeteorDirection,
} from "../core/decorationEffects";
import {
  APPEARANCE_PRESETS, matchingPreset, presetById, presetPatch,
} from "../core/decorationPresets";

export interface DecorationInspectorProps {
  readonly decorations: readonly ChartDecoration[];
  readonly onText: (text: string) => void;
  readonly onStart: (startTimeSec: number) => void;
  readonly onEnd: (endTimeSec: number) => void;
  readonly onPosition: (x: number, y: number) => void;
  readonly onStyle: (patch: Record<string, unknown>) => void;
  readonly onAnimation: (patch: Record<string, unknown>) => void;
  /** Change what runs while the decoration is shown. */
  readonly onEffects: (patch: Record<string, unknown>) => void;
  /** Apply a preset: one command that sets the style and the effects together. */
  readonly onPreset: (
    style: Record<string, unknown>,
    effects: Record<string, unknown>,
  ) => void;
  readonly onZIndex: (zIndex: number) => void;
  readonly onDelete: () => void;
}

/**
 * The contract stores a fraction of the playfield's height; the panel shows a percentage.
 *
 * `0.06` is a number an author has to be told how to read. `6%` says what it is on sight,
 * and it is the same quantity - so the conversion lives here, in the one place that draws
 * the control, and the document keeps the unit it always had.
 */
const asPercent = (fraction: number): number => Math.round(fraction * 1000) / 10;
const fromPercent = (percent: number): number => percent / 100;

/** Read a number out of an input, or null when it is not one. */
function numberOf(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface FieldProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function Field({ label, children }: FieldProps): React.JSX.Element {
  return (
    <label className="dec-field">
      <span className="dec-label">{label}</span>
      {children}
    </label>
  );
}

export function DecorationInspector(
  props: DecorationInspectorProps,
): React.JSX.Element | null {
  const {
    decorations, onText, onStart, onEnd, onPosition, onStyle, onAnimation, onEffects,
    onPreset, onZIndex, onDelete,
  } = props;

  if (decorations.length === 0) return null;

  // Several: a count and the way out. Sixteen inputs applied to twelve captions at once
  // is an editor nobody can predict, and the one thing an author wants here is Delete.
  if (decorations.length > 1) {
    return (
      <section className="inspector">
        <h2>Selected text</h2>
        <p className="inspector-count">{`${decorations.length} Decorations Selected`}</p>
        <p className="inspector-hint">
          Drag on the timeline to move them in time, or on the stage to move them across
          the playfield.
        </p>
        <button type="button" className="inspector-delete" onClick={onDelete}>
          Delete Selected
        </button>
      </section>
    );
  }

  const decoration = decorations[0] as ChartDecoration;
  if (!isTextDecoration(decoration)) {
    // A kind from a later version of the contract. It is in the document and it is drawn
    // as a bar, but this Editor has no idea what its fields mean, so it offers nothing
    // but the truth and a way to remove it.
    return (
      <section className="inspector">
        <h2>Selected decoration</h2>
        <p className="inspector-hint">
          {`This is a "${decoration.type}" decoration, which this Editor does not know how ` +
            "to edit. It is kept exactly as it was written."}
        </p>
        <button type="button" className="inspector-delete" onClick={onDelete}>
          Delete
        </button>
      </section>
    );
  }

  const style = resolveTextStyle(decoration.style);
  const window = displayWindow(decoration);
  const stated = decoration.endTimeSec !== undefined;

  return (
    <section className="inspector">
      <h2>Selected text</h2>
      <p className="inspector-id">{decoration.id}</p>

      <details className="dec-group" open>
        <summary>Text</summary>
        <textarea
          className="dec-text"
          value={decoration.text ?? ""}
          rows={2}
          placeholder="Type here"
          onChange={(event) => onText(event.target.value)}
        />
      </details>

      <details className="dec-group" open>
        <summary>Timing</summary>
        <Field label="Start">
          <input
            type="number"
            step="0.01"
            min="0"
            value={decoration.startTimeSec}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onStart(value);
            }}
          />
        </Field>
        <Field label="End">
          <input
            type="number"
            step="0.01"
            min="0"
            value={window.endSec}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onEnd(value);
            }}
          />
        </Field>
        <p className="dec-note">
          {stated
            ? `Lasts ${(window.endSec - window.startSec).toFixed(3)}s.`
            : `No end recorded, so it is shown for the default ` +
              `${(window.endSec - window.startSec).toFixed(2)}s. Setting one records it.`}
        </p>
      </details>

      <details className="dec-group" open>
        <summary>Position</summary>
        <Field label="X">
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={decoration.position.x}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onPosition(value, decoration.position.y);
            }}
          />
        </Field>
        <Field label="Y">
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={decoration.position.y}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onPosition(decoration.position.x, value);
            }}
          />
        </Field>
        <p className="dec-note">0 to 1 across the playfield. 1 is the judgement line.</p>
      </details>

      <details className="dec-group" open>
        <summary>Appearance</summary>
        <Field label="Preset">
          <select
            value={matchingPreset(decoration.style, decoration.effects)?.id ?? "custom"}
            onChange={(event) => {
              const preset = presetById(event.target.value);
              if (!preset) return;
              const patch = presetPatch(preset);
              onPreset(patch.style, patch.effects);
            }}
          >
            {/* Only shown once something has been changed by hand: it is a report of
                where the settings are, not somewhere to navigate to. */}
            {matchingPreset(decoration.style, decoration.effects) === null && (
              <option value="custom">Custom</option>
            )}
            {APPEARANCE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id} title={preset.hint}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="dec-note">
          A preset writes ordinary properties and is not stored by name. Adjust anything
          below and it becomes Custom.
        </p>
      </details>

      <details className="dec-group">
        <summary>Fill and glow</summary>
        <Field label="Rainbow">
          <input
            type="checkbox"
            checked={decoration.style?.gradient !== undefined}
            onChange={(event) =>
              onStyle({
                gradient: event.target.checked
                  ? (presetById("rainbow")?.style.gradient ?? undefined)
                  : undefined,
              })
            }
          />
        </Field>
        {decoration.style?.gradient !== undefined && (
          <Field label="Cycle s">
            <input
              type="number"
              step="0.5"
              min="0"
              max="600"
              value={decoration.style.gradient.cycleSec ?? 0}
              onChange={(event) => {
                const value = numberOf(event.target.value);
                if (value === null) return;
                const gradient = decoration.style?.gradient;
                if (!gradient) return;
                onStyle({ gradient: { ...gradient, cycleSec: value } });
              }}
            />
          </Field>
        )}
        <Field label="Glow">
          <input
            type="checkbox"
            checked={decoration.style?.glow !== undefined}
            onChange={(event) =>
              onStyle({
                glow: event.target.checked
                  ? {
                      color: DEFAULT_GLOW_COLOR,
                      radius: DEFAULT_GLOW_RADIUS,
                      intensity: DEFAULT_GLOW_INTENSITY,
                    }
                  : undefined,
              })
            }
          />
        </Field>
        {decoration.style?.glow !== undefined && (
          <>
            <Field label="Glow colour">
              <input
                type="color"
                value={decoration.style.glow.color ?? DEFAULT_GLOW_COLOR}
                onChange={(event) => {
                  const glow = decoration.style?.glow;
                  if (!glow) return;
                  onStyle({ glow: { ...glow, color: event.target.value } });
                }}
              />
            </Field>
            <Field label="Glow %">
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={asPercent(decoration.style.glow.intensity ?? DEFAULT_GLOW_INTENSITY)}
                onChange={(event) => {
                  const value = numberOf(event.target.value);
                  const glow = decoration.style?.glow;
                  if (value === null || !glow) return;
                  onStyle({ glow: { ...glow, intensity: fromPercent(value) } });
                }}
              />
            </Field>
          </>
        )}
      </details>

      <details className="dec-group">
        <summary>Effects</summary>
        <Field label="Shimmer">
          <input
            type="checkbox"
            checked={decoration.effects?.shimmer !== undefined}
            onChange={(event) =>
              onEffects({
                shimmer: event.target.checked
                  ? { periodSec: DEFAULT_SHIMMER_PERIOD_SEC, intensity: DEFAULT_SHIMMER_INTENSITY }
                  : undefined,
              })
            }
          />
        </Field>
        {decoration.effects?.shimmer !== undefined && (
          <Field label="Every s">
            <input
              type="number"
              step="0.5"
              min="0.1"
              max="600"
              value={decoration.effects.shimmer.periodSec ?? DEFAULT_SHIMMER_PERIOD_SEC}
              onChange={(event) => {
                const value = numberOf(event.target.value);
                const shimmer = decoration.effects?.shimmer;
                if (value === null || !shimmer) return;
                onEffects({ shimmer: { ...shimmer, periodSec: value } });
              }}
            />
          </Field>
        )}
        <Field label="Sparkle">
          <input
            type="checkbox"
            checked={decoration.effects?.sparkle !== undefined}
            onChange={(event) =>
              onEffects({
                sparkle: event.target.checked
                  ? { ratePerSec: DEFAULT_SPARKLE_RATE, intensity: DEFAULT_SPARKLE_INTENSITY }
                  : undefined,
              })
            }
          />
        </Field>
        {decoration.effects?.sparkle !== undefined && (
          <Field label="Per second">
            <input
              type="number"
              step="0.5"
              min="0"
              max="60"
              value={decoration.effects.sparkle.ratePerSec ?? DEFAULT_SPARKLE_RATE}
              onChange={(event) => {
                const value = numberOf(event.target.value);
                const sparkle = decoration.effects?.sparkle;
                if (value === null || !sparkle) return;
                onEffects({ sparkle: { ...sparkle, ratePerSec: value } });
              }}
            />
          </Field>
        )}
        <Field label="Meteor">
          <input
            type="checkbox"
            checked={decoration.effects?.meteor !== undefined}
            onChange={(event) =>
              onEffects({
                meteor: event.target.checked
                  ? {
                      ratePerSec: DEFAULT_METEOR_RATE,
                      direction: "downRight" as MeteorDirection,
                      color: DEFAULT_METEOR_COLOR,
                      intensity: DEFAULT_METEOR_INTENSITY,
                    }
                  : undefined,
              })
            }
          />
        </Field>
        {decoration.effects?.meteor !== undefined && (
          <>
            <Field label="Per second">
              <input
                type="number"
                step="0.05"
                min="0"
                max="20"
                value={decoration.effects.meteor.ratePerSec ?? DEFAULT_METEOR_RATE}
                onChange={(event) => {
                  const value = numberOf(event.target.value);
                  const meteor = decoration.effects?.meteor;
                  if (value === null || !meteor) return;
                  onEffects({ meteor: { ...meteor, ratePerSec: value } });
                }}
              />
            </Field>
            <Field label="Direction">
              <select
                value={decoration.effects.meteor.direction ?? "downRight"}
                onChange={(event) => {
                  const meteor = decoration.effects?.meteor;
                  if (!meteor) return;
                  onEffects({
                    meteor: { ...meteor, direction: event.target.value as MeteorDirection },
                  });
                }}
              >
                {METEOR_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>{direction}</option>
                ))}
              </select>
            </Field>
          </>
        )}
      </details>

      <details className="dec-group">
        <summary>Style</summary>
        <Field label="Font">
          <select
            value={style.fontFamily}
            onChange={(event) => onStyle({ fontFamily: event.target.value as FontFamily })}
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family}>{family}</option>
            ))}
          </select>
        </Field>
        <Field label="Size %">
          <input
            type="number"
            step="0.5"
            min="0.5"
            max="100"
            value={asPercent(style.fontSize)}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onStyle({ fontSize: fromPercent(value) });
            }}
          />
        </Field>
        <Field label="Weight">
          <select
            value={style.fontWeight}
            onChange={(event) => onStyle({ fontWeight: Number(event.target.value) })}
          >
            {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
              <option key={weight} value={weight}>{weight}</option>
            ))}
          </select>
        </Field>
        <Field label="Align">
          <select
            value={style.align}
            onChange={(event) => onStyle({ align: event.target.value as TextAlign })}
          >
            {TEXT_ALIGNMENTS.map((align) => (
              <option key={align} value={align}>{align}</option>
            ))}
          </select>
        </Field>
        <Field label="Rotation">
          <input
            type="number"
            step="1"
            min="-360"
            max="360"
            value={style.rotationDeg}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onStyle({ rotationDeg: value });
            }}
          />
        </Field>
        <Field label="Opacity">
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={style.opacity}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onStyle({ opacity: value });
            }}
          />
        </Field>
        <Field label="Colour">
          <input
            type="color"
            value={style.color}
            onChange={(event) => onStyle({ color: event.target.value })}
          />
        </Field>
        <Field label="Outline">
          <input
            type="color"
            value={style.strokeColor}
            onChange={(event) => onStyle({ strokeColor: event.target.value })}
          />
        </Field>
        <Field label="Outline %">
          <input
            type="number"
            step="0.1"
            min="0"
            max="100"
            value={asPercent(style.strokeWidth)}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onStyle({ strokeWidth: fromPercent(value) });
            }}
          />
        </Field>
        <p className="dec-note">
          Size and outline are a percentage of the playfield&apos;s height, so text keeps
          its proportions on any screen.
        </p>
        <button
          type="button"
          className="inspector-action"
          onClick={() =>
            onStyle(
              Object.fromEntries(
                Object.keys(DEFAULT_TEXT_STYLE).map((key) => [key, undefined]),
              ),
            )
          }
        >
          Reset style
        </button>
      </details>

      <details className="dec-group">
        <summary>Animation</summary>
        <Field label="Enter">
          <select
            value={decoration.animation?.enter ?? "none"}
            onChange={(event) =>
              onAnimation({ enter: event.target.value as AnimationKind })
            }
          >
            {ANIMATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
        </Field>
        <Field label="Enter secs">
          <input
            type="number"
            step="0.02"
            min="0"
            value={decoration.animation?.enterDurationSec ?? 0}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onAnimation({ enterDurationSec: value });
            }}
          />
        </Field>
        <Field label="Exit">
          <select
            value={decoration.animation?.exit ?? "none"}
            onChange={(event) => onAnimation({ exit: event.target.value as AnimationKind })}
          >
            {ANIMATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
        </Field>
        <Field label="Exit secs">
          <input
            type="number"
            step="0.02"
            min="0"
            value={decoration.animation?.exitDurationSec ?? 0}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onAnimation({ exitDurationSec: value });
            }}
          />
        </Field>
        <Field label="Layer">
          <input
            type="number"
            step="1"
            min="0"
            max="1000"
            value={decoration.zIndex ?? 0}
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value !== null) onZIndex(Math.round(value));
            }}
          />
        </Field>
      </details>

      <button type="button" className="inspector-delete" onClick={onDelete}>
        Delete
      </button>
    </section>
  );
}
