import type { Page } from "playwright-core";
import { randomUUID } from "node:crypto";
import { sanitizeUrl } from "./model.js";
import type { Observation, ObservationElement, Visibility } from "./model.js";

export interface CaptureOptions {
  id?: string;
  context?: string;
  after?: Observation["after"];
  maxElements?: number;
  maxTextLength?: number;
}

interface BrowserElement {
  role: string;
  name: string;
  kind: string;
  bounds: [number, number, number, number];
  visibility: Visibility;
  states: string[];
  properties: Record<string, string | number | boolean>;
}

/** Read-only page capture. Values, cookies, storage, and arbitrary attributes are never read. */
export async function capture(page: Page, options: CaptureOptions = {}): Promise<Observation> {
  const maxElements = Math.max(1, Math.min(options.maxElements ?? 1200, 5000));
  const maxTextLength = Math.max(16, Math.min(options.maxTextLength ?? 240, 1000));
  const raw = await page.evaluate(({ maxElements: cap, maxTextLength: textLimit }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
    const textBlockSelector = "p,li,td,th,blockquote,figcaption,dt,dd,pre,code";
    const selector = ["a[href]", "button", "input", "select", "textarea", "[role]", "[contenteditable=true]", "summary", "h1,h2,h3,h4,h5,h6", "label", "img[alt]", textBlockSelector].join(",");
    const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const elements: BrowserElement[] = [];
    let truncated = false;
    for (const el of all) {
      if (elements.length >= cap) { truncated = true; break; }
      const tag = el.tagName.toLowerCase();
      const isTextBlock = el.matches(textBlockSelector);
      if (isTextBlock && el.querySelector(textBlockSelector)) continue;
      const type = tag === "input" ? ((el.getAttribute("type") || "text").toLowerCase()) : "";
      if (tag === "input" && ["hidden", "submit", "reset", "button", "image"].includes(type)) {
        if (type !== "submit" && type !== "button" && type !== "reset") continue;
      }
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hidden = style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0 || el.hidden;
      const intersects = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
      const visibility: Visibility = hidden ? "hidden" : intersects ? "visible" : "offscreen";
      let blockText = (isTextBlock || el.isContentEditable || ["input", "textarea", "select"].includes(tag)) ? "" : el.innerText || "";
      if (isTextBlock && !el.isContentEditable) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        let textNode: Node | null;
        while ((textNode = walker.nextNode())) {
          let parent = textNode.parentElement;
          let nestedInteractive = false;
          while (parent && parent !== el) {
            if (parent.matches("a[href],button,input,select,textarea,[role=button],[role=link],[contenteditable=true]")) { nestedInteractive = true; break; }
            parent = parent.parentElement;
          }
          if (!nestedInteractive && textNode.nodeValue) parts.push(textNode.nodeValue);
        }
        blockText = parts.join(" ");
      }
      const safeTextFallback = el.isContentEditable || ["input", "textarea", "select"].includes(tag) ? "" : blockText;
      const label = el.getAttribute("aria-label") || el.getAttribute("title") || ("labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map((item) => item.innerText).join(" ") : "") || (tag === "img" ? el.getAttribute("alt") : "") || safeTextFallback;
      const name = label.replace(/\s+/g, " ").trim().slice(0, textLimit);
      const explicitRole = el.getAttribute("role");
      let role = explicitRole || "generic";
      if (!explicitRole) {
        if (tag === "a") role = "link";
        else if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type))) role = "button";
        else if (tag === "input" && ["checkbox", "radio"].includes(type)) role = type;
        else if (tag === "input" || tag === "textarea") role = type === "search" ? "searchbox" : "textbox";
        else if (tag === "select") role = el.hasAttribute("multiple") ? "listbox" : "combobox";
        else if (/^h[1-6]$/.test(tag)) role = "heading";
        else if (tag === "summary") role = "button";
        else if (tag === "img") role = "img";
        else if (tag === "label") role = "label";
        else if (tag === "p") role = "paragraph";
        else if (tag === "li") role = "listitem";
        else if (tag === "td" || tag === "th") role = "cell";
        else if (tag === "blockquote") role = "blockquote";
        else if (tag === "dt") role = "term";
        else if (tag === "dd") role = "definition";
        else if (tag === "pre" || tag === "code") role = "text";
      }
      const kind = ["input", "textarea", "select"].includes(tag) ? "input" : tag === "a" ? "link" : ["button", "summary"].includes(tag) ? "button" : /^h[1-6]$/.test(tag) ? "heading" : tag === "img" ? "image" : isTextBlock ? "text" : "element";
      const states: string[] = [];
      if (el.getAttribute("aria-expanded") === "true") states.push("expanded");
      if (el.getAttribute("aria-expanded") === "false") states.push("collapsed");
      if (el.getAttribute("aria-invalid") === "true") states.push("invalid");
      if (el.hasAttribute("disabled") || (el as HTMLButtonElement).disabled === true) states.push("disabled");
      if (el.hasAttribute("required")) states.push("required");
      const ariaChecked = el.getAttribute("aria-checked");
      if (ariaChecked === "true" || ariaChecked === "mixed") states.push(ariaChecked === "mixed" ? "checked-mixed" : "checked");
      else if (ariaChecked === "false") states.push("unchecked");
      else if (tag === "input" && ["checkbox", "radio"].includes(type)) states.push((el as HTMLInputElement).checked ? "checked" : "unchecked");
      const ariaSelected = el.getAttribute("aria-selected");
      if (ariaSelected === "true") states.push("selected");
      else if (ariaSelected === "false") states.push("not-selected");
      const ariaPressed = el.getAttribute("aria-pressed");
      if (ariaPressed === "true") states.push("pressed");
      else if (ariaPressed === "false") states.push("not-pressed");
      const properties: Record<string, string | number | boolean> = {};
      if (type) properties.type = type;
      if (el.hasAttribute("required")) properties.required = true;
      if (el.hasAttribute("multiple")) properties.multiple = true;
      if (el.hasAttribute("minlength")) properties.minLength = Number(el.getAttribute("minlength"));
      if (el.hasAttribute("maxlength")) properties.maxLength = Number(el.getAttribute("maxlength"));
      if (el.hasAttribute("min")) properties.min = el.getAttribute("min") || "";
      if (el.hasAttribute("max")) properties.max = el.getAttribute("max") || "";
      if (el.hasAttribute("pattern")) properties.pattern = el.getAttribute("pattern") || "";
      elements.push({ role, name, kind, bounds: [Math.round(rect.x * 10) / 10, Math.round(rect.y * 10) / 10, Math.round(rect.width * 10) / 10, Math.round(rect.height * 10) / 10], visibility, states, properties });
    }
    // Visual reading order: top-to-bottom rows, then left-to-right within each row.
    elements.sort((a, b) => {
      const dy = a.bounds[1] - b.bounds[1];
      if (Math.abs(dy) > 8) return dy;
      return a.bounds[0] - b.bounds[0];
    });
    return { viewport, elements, truncated, title: document.title.slice(0, textLimit) };
  }, { maxElements, maxTextLength });
  const url = sanitizeUrl(page.url());
  const elements: ObservationElement[] = raw.elements.map((element) => ({
    role: element.role, name: element.name, kind: element.kind, bounds: element.bounds,
    visibility: element.visibility, ...(element.states.length ? { states: element.states } : {}),
    ...(Object.keys(element.properties).length ? { properties: element.properties } : {})
  }));
  const observation: Observation = {
    id: options.id ?? randomUUID(), capturedAt: new Date().toISOString(), source: "playwright",
    title: raw.title, url, width: raw.viewport.width, height: raw.viewport.height,
    scrollX: raw.viewport.scrollX, scrollY: raw.viewport.scrollY, elements
  };
  if (options.context) observation.context = options.context.slice(0, 1000);
  if (options.after) observation.after = options.after;
  if (raw.truncated) observation.diagnostics = [`capture-truncated:max-elements=${maxElements}`];
  return observation;
}
