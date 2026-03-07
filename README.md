# spec

`spec` turns human-written or LLM-written Markdown into executable browser-style test plans in a Bun-first TypeScript codebase. It compiles specs into a strict runtime format, runs them through the Bun CLI flow, and saves compiled plans plus result artifacts under `.spec/`.

## Quick Start

Install dependencies:

```bash
bun install
```

Set project defaults in `.spec/spec.toml`:

```toml
[spec]
base_url = "http://localhost:3000"
results_dir = ".spec/results"

[spec.browser]
browser = "chromium"
viewport = "desktop"
locale = "en-US"
```

Launch it from Bun:

```bash
bun run spec
```

## Workflow

- `bun run spec` opens an interactive picker for discovered markdown specs.
- `bun run spec init` creates `.spec/spec.toml` and `.spec/results/`.
- `bun run spec compile tests/specs/example.md` writes `.spec/compiled/<name>.json`.
- `bun run spec run tests/specs/example.md` writes suite artifacts to `.spec/results/<suite-id>/`.
- `bun run spec report .spec/results/<suite-id>/result.json --format markdown` regenerates reports.

Inside the interactive runner you can:

- choose a markdown file
- run `Compile + Run`
- run `Compile Only`

## Output Layout

- `.spec/compiled/<spec-name>.json`
- `.spec/results/<suite-id>/result.json`
- `.spec/results/<suite-id>/report.md`
- `.spec/results/<suite-id>/report.html`
- `.spec/results/<suite-id>/summary.json`

## Testing

```bash
bun test
```
