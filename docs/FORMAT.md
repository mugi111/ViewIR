# ViewIR compact line format, version 1

The format is UTF-8 text. Each non-empty line is a record. A record is an ASCII tag, one ASCII space, and a compact JSON value. JSON strings provide all escaping, including quotes, backslashes, control characters, and Unicode. JSON payloads must be a single line; use ordinary JSON escaping for embedded line breaks. Record order is preserved by the writer in the canonical order below. Parsers ignore blank lines.

## Store grammar

```text
VIR1                         exactly one header, first non-empty line
R {"revision": integer}     exactly one revision record
P {page object}              exactly one page record
E {element object}           zero or more
O {observation object}       zero or more
V {view metadata object}     zero or more
N {placement object}         follows its referenced V record
T {transition object}        zero or more
H {hypothesis object}        zero or more
X... {JSON value}            optional extension record; ignored by v1 readers
```

Known records use the public TypeScript interfaces in `src/model.ts`. Required fields:

- Page: `key`, `title`, `url` (URL has userinfo, query, and fragment removed).
- Element: `id`, `role`, `name`, `kind`; optional safe `properties`.
- Observation: `id`, `capturedAt`, `source`; optional `context`, `title`, `url`, `diagnostics`.
- View metadata: `id`, `observationId`, `width`, `height`, `scrollX`, `scrollY`.
- Placement: `viewId`, `elementId`, `visibility`, `order`; optional `bounds` `[x,y,width,height]`, `states`, and view-local `region` with `regionBasis:"geometry-inferred"`.
- Transition: `fromView`, `toView`, `action`, `evidence`; optional `targetElement`.
- Hypothesis: `id`, `elementId`, `condition`, `effect`, `confidence`, `basis`, `supportedBy`.

Unknown record tags are rejected, except tags starting with `X`, which are ignored and are not preserved by parse/serialize. Unknown fields inside known record objects are retained by the runtime parser where the object is not normalized; integrations should not rely on unknown-field round-tripping.

## Observation exchange

An adapter emits one standalone observation:

```text
VIR1O
O {observation metadata and viewport}
E {one observed element}
E {next observed element}
```

The observation metadata includes `id`, `capturedAt`, `source`, `title`, `url`, `width`, `height`, `scrollX`, `scrollY`, and optional `context`, `after`, and `diagnostics`. Each `E` payload includes `role`, `name`, `kind`, `visibility`, and optional `bounds`, `states`, and safe `properties`. Form values and secret browser state are prohibited.

## Semantics

- Element IDs are document-local references, never durable DOM identities.
- Placement order is a deterministic top-to-bottom/left-to-right approximation based on captured rectangles, not DOM order.
- Region IDs (`g1`, `g2`, ...) are view-local geometric clusters inferred from nearby visible rectangles. They do not claim semantic or DOM ancestry; `regionBasis` marks the grouping as inferred.
- `visible` means rendered and intersecting the viewport according to the adapter; it does not guarantee unobscured pixels or human legibility. `offscreen` is rendered outside the viewport; `hidden` is not rendered.
- Observed placements are evidence. `H` records are low-confidence inferences and must not be treated as observations.
- `ingest` appends a new view. A unique `(role,name,kind)` identity is reused directly. Repeated matching controls are paired one-to-one with the immediately previous view by rectangle-center distance plus placement-order distance; close/tied alternatives remain separate IDs with a diagnostic.
- Inferred hypotheses cite supporting observation IDs in `basis`; `inferenceBasis` names the rule or input constraint that led to the inference.
- Revision increases once per newly ingested observation. Reingesting the same observation ID is an idempotent no-op.
- The `after` field is caller-supplied context; it does not mean ViewIR performed the action.
- URLs are sanitized by removing userinfo, query, and fragment. Capture does not read input values, cookies, or storage.
- Observation exchange payloads are checked for required fields, supported visibility, finite viewport/rectangle numbers, non-negative rectangle dimensions, and primitive safe properties before serialization or ingest. Invalid observations fail before the store is cloned or written.
- Properties whose names contain `value`, or equal `textContent`, `innerText`, `innerHTML`, `password`, or `secret` (case/punctuation-insensitive) are rejected. Contenteditable bodies are not read; checked, unchecked, selected, and ARIA toggle states are represented as state labels only.

## Agent projection

`context --query` uses NFKC-normalized, lowercased Unicode script runs (Han, Hiragana, Katakana, Latin/digits) and includes placements whose role, name, kind, or safe properties contain any query term. This supports phrases without whitespace in Japanese while remaining deterministic; it is lexical filtering, not semantic relevance ranking.

`context --max-tokens` estimates one token per four string code units (rounded up) and removes transitions, hypotheses, then placements until the estimate fits. When anything is omitted, an `X` record reports the budget and omitted counts. Any retained transition whose target placement was omitted is removed; hypotheses for omitted placements are removed as well. If the fixed header and truncation record exceed the requested budget, the diagnostic is still returned because explaining truncation takes precedence over a hard token ceiling.

## Versioning and errors

The header `VIR1` identifies the major grammar and semantic version. Unknown majors fail closed. Record payload parse errors report the source line. A parser may ignore `X` extension records only within a recognized major format.
