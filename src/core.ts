import { createDocument, sanitizeUrl, validateObservation } from "./model.js";
import type { ContextOptions, Diagnostic, ElementRecord, HypothesisRecord, IngestResult, Observation, ViewIR } from "./model.js";
import { serialize } from "./format.js";

export { createDocument, sanitizeUrl } from "./model.js";

export function validate(document: ViewIR): Diagnostic[] {
  const out: Diagnostic[] = [];
  const fail = (code: string, message: string) => out.push({ code, message, severity: "error" as const });
  if (document.version !== 1) fail("version", "Unsupported ViewIR version");
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) fail("revision", "Revision must be a non-negative integer");
  const elements = new Set<string>();
  for (const e of document.elements ?? []) {
    if (!e.id || elements.has(e.id)) fail("element-id", `Missing or duplicate element id: ${e.id}`);
    elements.add(e.id);
    if (!e.role || !e.kind || typeof e.name !== "string") fail("element", `Invalid element ${e.id}`);
  }
  const obs = new Set<string>();
  for (const o of document.observations ?? []) {
    if (!o.id || obs.has(o.id)) fail("observation-id", `Missing or duplicate observation id: ${o.id}`);
    obs.add(o.id);
  }
  const views = new Set<string>();
  for (const v of document.views ?? []) {
    if (!v.id || views.has(v.id)) fail("view-id", `Missing or duplicate view id: ${v.id}`);
    views.add(v.id);
    if (!obs.has(v.observationId)) fail("view-observation", `${v.id} references missing observation ${v.observationId}`);
    if (![v.width, v.height, v.scrollX, v.scrollY].every(Number.isFinite) || v.width < 0 || v.height < 0) fail("view-metrics", `Invalid viewport metrics for ${v.id}`);
    const placed = new Set<string>();
    for (const p of v.placements ?? []) {
      if (!elements.has(p.elementId)) fail("placement-element", `${v.id} references missing element ${p.elementId}`);
      if (placed.has(p.elementId)) fail("placement-duplicate", `${v.id} places ${p.elementId} more than once`);
      placed.add(p.elementId);
      if (p.bounds && (p.bounds.length !== 4 || !p.bounds.every(Number.isFinite) || p.bounds[2] < 0 || p.bounds[3] < 0)) fail("bounds", `Invalid bounds for ${p.elementId}`);
      if (p.region !== undefined && (typeof p.region !== "string" || p.regionBasis !== "geometry-inferred")) fail("region", `Region for ${p.elementId} must identify geometric inference`);
      if (p.region === undefined && p.regionBasis !== undefined) fail("region", `Region basis without region for ${p.elementId}`);
    }
  }
  for (const t of document.transitions ?? []) {
    if (!views.has(t.fromView) || !views.has(t.toView)) fail("transition-view", "Transition references a missing view");
    if (t.targetElement && !elements.has(t.targetElement)) fail("transition-element", `Transition references missing element ${t.targetElement}`);
    for (const id of t.evidence) if (!obs.has(id)) fail("transition-evidence", `Transition references missing observation ${id}`);
  }
  for (const h of document.hypotheses ?? []) {
    if (!elements.has(h.elementId)) fail("hypothesis-element", `Hypothesis references missing element ${h.elementId}`);
    for (const id of [...h.basis, ...h.supportedBy]) if (!obs.has(id)) fail("hypothesis-evidence", `Hypothesis references missing observation ${id}`);
  }
  return out;
}

export function ingest(input: ViewIR, observation: Observation): IngestResult {
  const observationDiagnostics = validateObservation(observation);
  if (observationDiagnostics.some((item) => item.severity === "error")) {
    return { document: input, duplicate: false, addedElements: 0, diagnostics: observationDiagnostics };
  }
  const document = structuredClone(input);
  const diagnostics: Diagnostic[] = [];
  if (document.observations.some((item) => item.id === observation.id)) {
    return { document, duplicate: true, addedElements: 0, diagnostics: [{ code: "duplicate-observation", message: `Observation ${observation.id} already exists`, severity: "warning" }] };
  }
  const obs: Observation = { ...observation, url: sanitizeUrl(observation.url) };
  const previous = document.views.at(-1);
  const groups = new Map<string, ElementRecord[]>();
  for (const e of document.elements) {
    const key = elementKey(e.role, e.name, e.kind);
    const list = groups.get(key) ?? []; list.push(e); groups.set(key, list);
  }
  const previousGroups = new Map<string, Array<{ element: ElementRecord; placement: ViewIR["views"][number]["placements"][number] }>>();
  if (previous) for (const placement of previous.placements) {
    const element = document.elements.find((item) => item.id === placement.elementId);
    if (!element) continue;
    const key = elementKey(element.role, element.name, element.kind);
    const list = previousGroups.get(key) ?? []; list.push({ element, placement }); previousGroups.set(key, list);
  }
  const incomingGroups = new Map<string, number[]>();
  obs.elements.forEach((element, index) => {
    const key = elementKey(element.role, element.name, element.kind);
    const list = incomingGroups.get(key) ?? []; list.push(index); incomingGroups.set(key, list);
  });
  let nextElement = nextId(document.elements.map((e) => e.id), "e");
  let addedElements = 0;
  const elementByIndex = Array<string>(obs.elements.length);
  for (const [key, indices] of incomingGroups) {
    const prior = previousGroups.get(key) ?? [];
    const global = groups.get(key) ?? [];
    const source = obs.elements[indices[0]!]!;
    let matches = new Map<number, ElementRecord>();
    if (prior.length === 1 && indices.length === 1) matches.set(indices[0]!, prior[0]!.element);
    else if (prior.length === indices.length && indices.length > 1) matches = matchRepeatedElements(indices, obs.elements, prior);
    else if (prior.length === 0 && global.length === 1 && indices.length === 1) matches.set(indices[0]!, global[0]!);
    if (prior.length > 0 && matches.size !== indices.length) {
      diagnostics.push({ code: "ambiguous-element", message: `Spatial identity for repeated ${source.role} ${JSON.stringify(source.name)} could not be established; unmatched instances retained separately`, severity: "warning" });
    }
    for (const index of indices) {
      const item = obs.elements[index]!;
      const matched = matches.get(index);
      if (matched) { elementByIndex[index] = matched.id; continue; }
      const id = nextElement();
      const record: ElementRecord = { id, role: item.role, name: item.name, kind: item.kind };
      if (item.properties && Object.keys(item.properties).length) record.properties = item.properties;
      document.elements.push(record); addedElements++;
      elementByIndex[index] = id;
    }
  }
  const viewId = nextId(document.views.map((v) => v.id), "v")();
  const observationRecord: ViewIR["observations"][number] = {
    id: obs.id, capturedAt: obs.capturedAt, source: obs.source, title: obs.title, url: obs.url
  };
  if (obs.context) observationRecord.context = obs.context;
  if (obs.diagnostics?.length) observationRecord.diagnostics = obs.diagnostics;
  document.observations.push(observationRecord);
  const regions = inferRegions(obs.elements);
  document.views.push({
    id: viewId, observationId: obs.id, width: obs.width, height: obs.height, scrollX: obs.scrollX, scrollY: obs.scrollY,
    placements: obs.elements.map((e, i) => ({ elementId: elementByIndex[i]!, visibility: e.visibility, ...(e.bounds ? { bounds: e.bounds } : {}), order: i + 1, ...(e.states?.length ? { states: e.states } : {}), ...(regions[i] ? { region: regions[i], regionBasis: "geometry-inferred" as const } : {}) }))
  });
  for (const [index, source] of obs.elements.entries()) {
    const type = source.properties?.type;
    const required = source.properties?.required === true;
    if (type === "email" || required) {
      const elementId = elementByIndex[index]!;
      const condition = type === "email" ? "invalid-email-value" : "empty-required-value";
      const id = nextId(document.hypotheses.map((h) => h.id), "h")();
      const hypothesis: HypothesisRecord = { id, elementId, condition, effect: "validation-message-may-appear", confidence: "low", basis: [obs.id], inferenceBasis: "input-constraints", supportedBy: [obs.id] };
      if (!document.hypotheses.some((h) => h.elementId === elementId && h.condition === condition)) document.hypotheses.push(hypothesis);
    }
  }
  if (previous && obs.after) {
    const targetMatches = obs.after.target ? document.elements.filter((e) => e.role === obs.after!.target!.role && e.name === obs.after!.target!.name) : [];
    document.transitions.push({ fromView: previous.id, toView: viewId, action: obs.after.action, ...(targetMatches.length === 1 ? { targetElement: targetMatches[0]!.id } : {}), evidence: [previous.observationId, obs.id] });
    if (obs.after.target && targetMatches.length !== 1) diagnostics.push({ code: "ambiguous-transition-target", message: "Transition target could not be uniquely resolved", severity: "warning" });
  }
  document.revision++;
  diagnostics.push(...validate(document));
  return { document, duplicate: false, viewId, addedElements, diagnostics };
}

export function createAgentContext(document: ViewIR, options: ContextOptions = {}): string {
  const view = options.view === "latest" || options.view === undefined ? document.views.at(-1) : document.views.find((item) => item.id === options.view);
  if (!view) throw new Error(`View not found: ${options.view ?? "latest"}`);
  const placements = [...view.placements].sort((a, b) => a.order - b.order);
  const allIds = new Set(placements.map((p) => p.elementId));
  const query = options.query ? tokenizeQuery(options.query) : [];
  let selected = placements.filter((p) => {
    if (query.length === 0) return true;
    const e = document.elements.find((item) => item.id === p.elementId);
    return !!e && queryMatches(query, `${e.role} ${e.name} ${e.kind} ${Object.entries(e.properties ?? {}).map(([k, v]) => `${k} ${v}`).join(" ")}`);
  });
  let hypotheses = document.hypotheses.filter((h) => allIds.has(h.elementId) && (query.length === 0 || selected.some((p) => p.elementId === h.elementId)));
  let transitions = document.transitions.filter((t) => (t.fromView === view.id || t.toView === view.id) && (!t.targetElement || selected.some((p) => p.elementId === t.targetElement)));
  const initialCounts = { elements: selected.length, hypotheses: hypotheses.length, transitions: transitions.length };
  const budget = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : undefined;
  const render = (): string => {
    const lines = [`VIR1`, `V ${view.id} ${view.width} ${view.height} ${view.scrollX} ${view.scrollY}`];
    for (const p of selected) {
      const e = document.elements.find((item) => item.id === p.elementId)!;
      lines.push(`E ${JSON.stringify(e)}`);
      lines.push(`N ${JSON.stringify({ visibility: p.visibility, ...(p.bounds ? { bounds: p.bounds } : {}), order: p.order, ...(p.states ? { states: p.states } : {}), ...(p.region ? { region: p.region, regionBasis: p.regionBasis } : {}) })}`);
    }
    for (const h of hypotheses) lines.push(`H ${JSON.stringify(h)}`);
    for (const t of transitions) lines.push(`T ${JSON.stringify(t)}`);
    const removed = { elements: initialCounts.elements - selected.length, hypotheses: initialCounts.hypotheses - hypotheses.length, transitions: initialCounts.transitions - transitions.length };
    if (removed.elements + removed.hypotheses + removed.transitions > 0) {
      lines.push(`X ${JSON.stringify({ truncated: true, reason: "max-tokens", budget, omitted: removed })}`);
    }
    return `${lines.join("\n")}\n`;
  };
  let result = render();
  if (budget) {
    // Keep current-view elements first. Drop lower-priority history and inferred data before placements.
    while (estimateTokens(result) > budget && transitions.length) { transitions.pop(); result = render(); }
    while (estimateTokens(result) > budget && hypotheses.length) { hypotheses.pop(); result = render(); }
    while (estimateTokens(result) > budget && selected.length) {
      selected.pop();
      const ids = new Set(selected.map((p) => p.elementId));
      hypotheses = hypotheses.filter((h) => ids.has(h.elementId));
      transitions = transitions.filter((t) => !t.targetElement || ids.has(t.targetElement));
      result = render();
    }
    if (estimateTokens(result) > budget && !result.includes('"reason":"budget-below-minimum-context"')) {
      result = result.replace(/\n$/, `X ${JSON.stringify({ truncated: true, reason: "budget-below-minimum-context", budget })}\n`);
    }
  }
  return result;
}

function tokenizeQuery(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  return normalized.match(/[\p{Script=Han}]+|[\p{Script=Hiragana}]+|[\p{Script=Katakana}]+|[a-z0-9]+/gu) ?? [];
}
function queryMatches(query: string[], candidate: string): boolean {
  const words = tokenizeQuery(candidate);
  return query.some((term) => words.some((word) => word.includes(term) || term.includes(word)));
}

function matchRepeatedElements(
  indices: number[],
  incoming: Observation["elements"],
  previous: Array<{ element: ElementRecord; placement: ViewIR["views"][number]["placements"][number] }>
): Map<number, ElementRecord> {
  const edges = indices.flatMap((index) => previous.map((candidate, previousIndex) => ({
    index, previousIndex, element: candidate.element,
    cost: placementCost(incoming[index]!, index + 1, candidate.placement)
  }));
  const sorted = [...edges].sort((a, b) => a.cost - b.cost || a.index - b.index || a.previousIndex - b.previousIndex);
  const result = new Map<number, ElementRecord>();
  const usedPrevious = new Set<number>();
  for (const edge of sorted) {
    if (result.has(edge.index) || usedPrevious.has(edge.previousIndex) || edge.cost > 240) continue;
    const nextForInput = edges.filter((item) => item.index === edge.index && item.previousIndex !== edge.previousIndex).sort((a, b) => a.cost - b.cost)[0];
    const nextForPrevious = edges.filter((item) => item.previousIndex === edge.previousIndex && item.index !== edge.index).sort((a, b) => a.cost - b.cost)[0];
    if ((nextForInput && nextForInput.cost - edge.cost < 16) || (nextForPrevious && nextForPrevious.cost - edge.cost < 16)) continue;
    result.set(edge.index, edge.element);
    usedPrevious.add(edge.previousIndex);
  }
  return result;
}

function placementCost(current: Observation["elements"][number], currentOrder: number, previous: ViewIR["views"][number]["placements"][number]): number {
  const orderCost = Math.abs(currentOrder - previous.order) * 18;
  if (!current.bounds || !previous.bounds) return orderCost;
  const [x1, y1, w1, h1] = current.bounds;
  const [x2, y2, w2, h2] = previous.bounds;
  const centerDistance = Math.hypot((x1 + w1 / 2) - (x2 + w2 / 2), (y1 + h1 / 2) - (y2 + h2 / 2));
  return centerDistance + orderCost;
}

function inferRegions(elements: Observation["elements"]): Array<string | undefined> {
  const visible = elements.map((element, index) => ({ element, index })).filter(({ element }) => element.visibility === "visible" && element.bounds);
  const parent = visible.map((_, index) => index);
  const root = (index: number): number => { while (parent[index] !== index) { parent[index] = parent[parent[index]!]!; index = parent[index]!; } return index; };
  const join = (a: number, b: number) => { const ra = root(a); const rb = root(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
    const a = visible[i]!.element.bounds!; const b = visible[j]!.element.bounds!;
    const horizontalOverlap = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const verticalOverlap = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const verticalGap = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
    const horizontalGap = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
    const verticalStack = verticalGap <= 44 && horizontalOverlap >= Math.min(a[2], b[2]) * 0.25;
    const horizontalRow = horizontalGap <= 36 && verticalOverlap >= Math.min(a[3], b[3]) * 0.25;
    if (verticalStack || horizontalRow) join(i, j);
  }
  const components = new Map<number, number[]>();
  visible.forEach((item, localIndex) => { const key = root(localIndex); const list = components.get(key) ?? []; list.push(item.index); components.set(key, list); });
  const clusters = [...components.values()].filter((indices) => indices.length > 1).sort((a, b) => Math.min(...a) - Math.min(...b));
  const result: Array<string | undefined> = Array(elements.length).fill(undefined);
  clusters.forEach((indices, clusterIndex) => indices.forEach((index) => { result[index] = `g${clusterIndex + 1}`; }));
  return result;
}

export function inspect(document: ViewIR): Record<string, unknown> {
  return { revision: document.revision, page: document.page, views: document.views.length, elements: document.elements.length, observations: document.observations.length, hypotheses: { total: document.hypotheses.length, unconfirmed: document.hypotheses.length }, transitions: document.transitions.length, diagnostics: validate(document) };
}

export function newEmptyDocument(): ViewIR { return createDocument(); }
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function elementKey(role: string, name: string, kind: string): string { return `${role}\0${name}\0${kind}`; }
function nextId(existing: string[], prefix: string): () => string {
  const used = new Set(existing);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return () => { while (used.has(`${prefix}${n}`)) n++; const result = `${prefix}${n++}`; used.add(result); return result; };
}
