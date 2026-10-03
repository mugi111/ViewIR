export type Visibility = "visible" | "offscreen" | "hidden";
export type Confidence = "low" | "medium" | "high";

export interface ElementRecord {
  id: string;
  role: string;
  name: string;
  kind: string;
  properties?: Record<string, string | number | boolean>;
}

export interface Placement {
  elementId: string;
  visibility: Visibility;
  bounds?: [number, number, number, number];
  order: number;
  states?: string[];
  /** View-local group inferred from geometric proximity; never a DOM parent identifier. */
  region?: string;
  regionBasis?: "geometry-inferred";
}

export interface ViewRecord {
  id: string;
  observationId: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  placements: Placement[];
}

export interface ObservationRecord {
  id: string;
  capturedAt: string;
  source: string;
  context?: string;
  title?: string;
  url?: string;
  diagnostics?: string[];
}

export interface TransitionRecord {
  fromView: string;
  toView: string;
  action: string;
  targetElement?: string;
  evidence: string[];
}

export interface HypothesisRecord {
  id: string;
  elementId: string;
  condition: string;
  effect: string;
  confidence: Confidence;
  /** Observation IDs that support the existence of this inference. */
  basis: string[];
  /** Rule or observed constraint from which the proposed condition was inferred. */
  inferenceBasis?: string;
  supportedBy: string[];
}

export interface ViewIR {
  version: 1;
  revision: number;
  page: { key: string; title: string; url: string };
  elements: ElementRecord[];
  views: ViewRecord[];
  observations: ObservationRecord[];
  transitions: TransitionRecord[];
  hypotheses: HypothesisRecord[];
}

export interface ObservationElement {
  role: string;
  name: string;
  kind: string;
  bounds?: [number, number, number, number];
  visibility: Visibility;
  states?: string[];
  properties?: Record<string, string | number | boolean>;
}

export interface Observation {
  id: string;
  capturedAt: string;
  source: string;
  title: string;
  url: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  context?: string;
  diagnostics?: string[];
  after?: { action: string; target?: { role?: string; name?: string } };
  elements: ObservationElement[];
}

export interface Diagnostic {
  code: string;
  message: string;
  line?: number;
  severity: "error" | "warning";
}

export interface IngestResult {
  document: ViewIR;
  duplicate: boolean;
  viewId?: string;
  addedElements: number;
  diagnostics: Diagnostic[];
}

export interface ContextOptions {
  view?: string | "latest";
  query?: string;
  maxTokens?: number;
}

export function createDocument(page: Partial<ViewIR["page"]> = {}): ViewIR {
  return {
    version: 1,
    revision: 0,
    page: { key: page.key ?? "", title: page.title ?? "", url: sanitizeUrl(page.url ?? "") },
    elements: [], views: [], observations: [], transitions: [], hypotheses: []
  };
}

export function sanitizeUrl(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? "";
  }
}

export function validateObservation(value: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (field: string, message: string) => diagnostics.push({ code: "observation-shape", message: `${field}: ${message}`, severity: "error" });
  if (!isObject(value)) return [{ code: "observation-shape", message: "Observation must be an object", severity: "error" }];
  for (const field of ["id", "capturedAt", "source", "title", "url"] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string") error(field, "must be a string");
    else if (field === "id" && fieldValue.length === 0) error(field, "must be a non-empty string");
  }
  if (typeof value.capturedAt === "string" && Number.isNaN(Date.parse(value.capturedAt))) error("capturedAt", "must be a valid date-time");
  for (const field of ["width", "height", "scrollX", "scrollY"] as const) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) error(field, "must be finite");
  }
  if (typeof value.width === "number" && value.width < 0) error("width", "must be non-negative");
  if (typeof value.height === "number" && value.height < 0) error("height", "must be non-negative");
  if (!Array.isArray(value.elements)) error("elements", "must be an array");
  else value.elements.forEach((element: unknown, index: number) => {
    const prefix = `elements[${index}]`;
    if (!isObject(element)) { error(prefix, "must be an object"); return; }
    for (const field of ["role", "name", "kind"] as const) if (typeof element[field] !== "string") error(`${prefix}.${field}`, "must be a string");
    if (!["visible", "offscreen", "hidden"].includes(String(element.visibility))) error(`${prefix}.visibility`, "must be visible, offscreen, or hidden");
    if (element.bounds !== undefined) {
      const bounds = element.bounds;
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) error(`${prefix}.bounds`, "must be four finite numbers with non-negative width and height");
      else if ((bounds[2] as number) < 0 || (bounds[3] as number) < 0) error(`${prefix}.bounds`, "must have non-negative width and height");
    }
    if (element.states !== undefined && (!Array.isArray(element.states) || !element.states.every((s: unknown) => typeof s === "string"))) error(`${prefix}.states`, "must be an array of strings");
    if (element.properties !== undefined) {
      if (!isObject(element.properties)) error(`${prefix}.properties`, "must be an object");
      else {
        for (const [key, propertyValue] of Object.entries(element.properties)) {
          const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
          if (normalizedKey.includes("value") || ["textcontent", "innertext", "innerhtml", "password", "secret"].includes(normalizedKey)) error(`${prefix}.properties.${key}`, "contains a prohibited value-like field");
          if (!["string", "number", "boolean"].includes(typeof propertyValue) || (typeof propertyValue === "number" && !Number.isFinite(propertyValue))) error(`${prefix}.properties.${key}`, "must be a finite number, string, or boolean");
        }
      }
    }
  });
  if (value.context !== undefined && typeof value.context !== "string") error("context", "must be a string");
  if (value.diagnostics !== undefined && (!Array.isArray(value.diagnostics) || !value.diagnostics.every((d: unknown) => typeof d === "string"))) error("diagnostics", "must be an array of strings");
  if (value.after !== undefined) {
    const after = value.after;
    if (!isObject(after) || typeof after.action !== "string" || after.action.length === 0) error("after", "must contain a non-empty action");
    else {
      const target = after.target;
      if (target !== undefined && (!isObject(target) || (target.role !== undefined && typeof target.role !== "string") || (target.name !== undefined && typeof target.name !== "string"))) error("after.target", "role and name must be strings when provided");
    }
  }
  return diagnostics;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
