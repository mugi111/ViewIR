import { validateObservation } from "./model.js";
import type { Observation, ViewIR } from "./model.js";

export class ViewIRParseError extends Error {
  constructor(message: string, readonly line: number) { super(`${message} (line ${line})`); this.name = "ViewIRParseError"; }
}

const json = (value: unknown): string => JSON.stringify(value);
function record(line: string, lineNo: number): [string, unknown] {
  const i = line.indexOf(" ");
  if (i < 0) throw new ViewIRParseError("Expected record payload", lineNo);
  const tag = line.slice(0, i);
  try { return [tag, JSON.parse(line.slice(i + 1)) as unknown]; }
  catch { throw new ViewIRParseError("Invalid JSON record payload", lineNo); }
}

export function serialize(document: ViewIR): string {
  const lines = ["VIR1", `R ${json({ revision: document.revision })}`, `P ${json(document.page)}`];
  for (const item of document.elements) lines.push(`E ${json(item)}`);
  for (const item of document.observations) lines.push(`O ${json(item)}`);
  for (const view of document.views) {
    lines.push(`V ${json({ id: view.id, observationId: view.observationId, width: view.width, height: view.height, scrollX: view.scrollX, scrollY: view.scrollY })}`);
    for (const placement of view.placements) lines.push(`N ${json({ viewId: view.id, ...placement })}`);
  }
  for (const item of document.transitions) lines.push(`T ${json(item)}`);
  for (const item of document.hypotheses) lines.push(`H ${json(item)}`);
  return `${lines.join("\n")}\n`;
}

export function serializeObservation(observation: Observation): string {
  const diagnostics = validateObservation(observation);
  if (diagnostics.length) throw new Error(diagnostics.map((item) => item.message).join("; "));
  const lines = ["VIR1O", `O ${json({ ...observation, elements: undefined })}`];
  for (const element of observation.elements) lines.push(`E ${json(element)}`);
  return `${lines.join("\n")}\n`;
}

export function parseObservation(source: string): Observation {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines[0] !== "VIR1O") throw new ViewIRParseError("Expected VIR1O header", 1);
  let result: Record<string, unknown> | undefined;
  const elements: unknown[] = [];
  lines.slice(1).forEach((line, index) => {
    const [tag, value] = record(line, index + 2);
    if (tag === "O" && result === undefined && isRecord(value)) result = value;
    else if (tag === "E") elements.push(value);
    else throw new ViewIRParseError(`Unknown or misplaced record ${tag}`, index + 2);
  });
  if (!result) throw new ViewIRParseError("Missing observation record", 2);
  result.elements = elements;
  const diagnostics = validateObservation(result);
  if (diagnostics.length) throw new ViewIRParseError(diagnostics.map((item) => item.message).join("; "), 2);
  return result as unknown as Observation;
}

export function parse(source: string): ViewIR {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines[0] !== "VIR1") throw new ViewIRParseError("Expected VIR1 header", 1);
  const doc = { version: 1, revision: 0, page: { key: "", title: "", url: "" }, elements: [], views: [], observations: [], transitions: [], hypotheses: [] } as ViewIR;
  const views = new Map<string, ViewIR["views"][number]>();
  const placements = new Map<string, ViewIR["views"][number]["placements"]>();
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const [tag, value] = record(lines[i]!, lineNo);
    if (!isRecord(value)) throw new ViewIRParseError("Record payload must be an object", lineNo);
    switch (tag) {
      case "R": if (typeof value.revision !== "number") throw new ViewIRParseError("Invalid revision", lineNo); else doc.revision = value.revision; break;
      case "P": doc.page = value as unknown as ViewIR["page"]; break;
      case "E": doc.elements.push(value as unknown as ViewIR["elements"][number]); break;
      case "O": doc.observations.push(value as unknown as ViewIR["observations"][number]); break;
      case "V": {
        const view = { ...value, placements: [] } as unknown as ViewIR["views"][number];
        if (views.has(view.id)) throw new ViewIRParseError(`Duplicate view ${view.id}`, lineNo);
        views.set(view.id, view); placements.set(view.id, view.placements); break;
      }
      case "N": {
        const viewId = value.viewId;
        if (typeof viewId !== "string" || !placements.has(viewId)) throw new ViewIRParseError("Placement references unknown view", lineNo);
        const { viewId: _viewId, ...placement } = value;
        placements.get(viewId)!.push(placement as unknown as ViewIR["views"][number]["placements"][number]); break;
      }
      case "T": doc.transitions.push(value as unknown as ViewIR["transitions"][number]); break;
      case "H": doc.hypotheses.push(value as unknown as ViewIR["hypotheses"][number]); break;
      default: if (!tag.startsWith("X")) throw new ViewIRParseError(`Unknown record ${tag}`, lineNo);
    }
  }
  doc.views = [...views.values()];
  return doc;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
