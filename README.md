# ViewIR

ViewIR stores compact observations of rendered web interfaces so an AI Agent can choose UI targets while carrying out a test. It does not interpret the test case, navigate, operate the page, or decide pass/fail.

## MVP layout

- Core: versioned IR, parser/writer, validation, accumulation, and Agent projection.
- Playwright adapter: read-only capture from an existing `Page`; install `playwright-core` in the consuming project.
- CLI: validate, ingest an observation file, project a view for an Agent, and inspect counts.
- Skill: [`skills/view-ir/SKILL.md`](skills/view-ir/SKILL.md).

## API

```ts
import { capture } from "@mugi111/view-ir/playwright";
import { serializeObservation } from "@mugi111/view-ir";
import { writeFile } from "node:fs/promises";

const observation = await capture(page, {
  context: "after submitting invalid email",
  after: { action: "click", target: { role: "button", name: "Register" } }
});
await writeFile("observation.vir", serializeObservation(observation));
```

Then invoke the CLI:

```sh
view-ir ingest ui.vir observation.vir
view-ir context ui.vir --view latest --query "email"
```

`capture` does not click, type, submit, or navigate. It never reads form values, contenteditable body text, cookies, or storage; checkbox/radio and ARIA checked/selected states are captured as booleans. It includes common rendered text blocks such as paragraphs, list items, table cells, and quotations, omitting a text container when nested text blocks are captured separately. URLs have userinfo, query, and fragment removed. The captured bounds are viewport-relative CSS pixels; layout order and nearby visual regions are inferred from rendered rectangles, not DOM ancestry.

## CLI

```text
view-ir validate <file>
view-ir ingest <store> <observation-file>
view-ir context <store> [--view <id|latest>] [--query <text>] [--max-tokens <n>]
view-ir inspect <store>
```

The store format is defined in [`docs/FORMAT.md`](docs/FORMAT.md). `context --query` tokenizes normalized Japanese and Latin text into deterministic Unicode script runs and returns placements matching any query term. For example, `--query "メールアドレスの形式エラー"` matches an element named `メールアドレス`. This is a lexical filter, not semantic ranking. `context --max-tokens` uses a conservative character-based estimate (`ceil(chars/4)`), not a model tokenizer. If content is omitted, an `X` truncation record reports the omitted element, hypothesis, and transition counts.

## Development

The package targets Node.js 20+, TypeScript, and ESM. Build with `npm run build` after installing dependencies.

## License

The license has not been selected. Do not publish or redistribute this package until its license is confirmed.
