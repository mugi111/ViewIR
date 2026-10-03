#!/usr/bin/env node
import { readFile, rename, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentContext, ingest, inspect, newEmptyDocument, validate } from "./core.js";
import { parse, parseObservation, serialize } from "./format.js";

const args = process.argv.slice(2);
const command = args.shift();

async function main(): Promise<number> {
  if (!command || command === "help" || command === "--help" || command === "-h") { help(); return 0; }
  if (command === "validate") {
    const path = args[0]; if (!path) throw new Error("Usage: view-ir validate <file>");
    const document = parse(await readFile(resolve(path), "utf8"));
    const diagnostics = validate(document);
    process.stdout.write(`${JSON.stringify({ valid: diagnostics.every((d) => d.severity !== "error"), diagnostics })}\n`);
    return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
  }
  if (command === "ingest") {
    const storePath = args[0]; const observationPath = args[1];
    if (!storePath || !observationPath) throw new Error("Usage: view-ir ingest <store> <observation-file>");
    const absoluteStore = resolve(storePath);
    const existing = await readOptional(absoluteStore);
    const document = existing === undefined ? newEmptyDocument() : parse(existing);
    const observation = parseObservation(await readFile(resolve(observationPath), "utf8"));
    const result = ingest(document, observation);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      process.stderr.write(`${JSON.stringify({ ok: false, diagnostics: result.diagnostics })}\n`);
      return 1;
    }
    if (!result.duplicate) await atomicWrite(absoluteStore, serialize(result.document));
    process.stdout.write(`${JSON.stringify({ ok: true, duplicate: result.duplicate, viewId: result.viewId, addedElements: result.addedElements, diagnostics: result.diagnostics })}\n`);
    return 0;
  }
  if (command === "context") {
    const path = args.shift(); if (!path) throw new Error("Usage: view-ir context <store> [--view <id|latest>] [--query <text>] [--max-tokens <n>]");
    const opts = options(args);
    const document = parse(await readFile(resolve(path), "utf8"));
    process.stdout.write(createAgentContext(document, { view: opts.view ?? "latest", ...(opts.query ? { query: opts.query } : {}), ...(opts.maxTokens ? { maxTokens: Number(opts.maxTokens) } : {}) }));
    return 0;
  }
  if (command === "inspect") {
    const path = args[0]; if (!path) throw new Error("Usage: view-ir inspect <store>");
    process.stdout.write(`${JSON.stringify(inspect(parse(await readFile(resolve(path), "utf8"))))}\n`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

function options(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const key = token.slice(2); const value = tokens[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    if (!["view", "query", "max-tokens"].includes(key)) throw new Error(`Unknown option ${token}`);
    out[key === "max-tokens" ? "maxTokens" : key] = value;
  }
  if (out.maxTokens && (!Number.isSafeInteger(Number(out.maxTokens)) || Number(out.maxTokens) < 1)) throw new Error("--max-tokens must be a positive integer");
  return out;
}
async function readOptional(path: string): Promise<string | undefined> { try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function atomicWrite(path: string, value: string): Promise<void> {
  const temp = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try { await writeFile(temp, value, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temp, path); }
  catch (error) { try { await import("node:fs/promises").then(({ unlink }) => unlink(temp)); } catch { /* temp may not exist */ } throw error; }
}
function help(): void {
  process.stdout.write("view-ir validate <file>\nview-ir ingest <store> <observation-file>\nview-ir context <store> [--view <id|latest>] [--query <text>] [--max-tokens <n>]\nview-ir inspect <store>\n");
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
