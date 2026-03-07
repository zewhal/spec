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

## Example

Create a markdown spec at `tests/specs/login.md`:

```md
# Suite: Login Flow

## Test: User can open the home page

### Steps
1. Navigate to /
2. Wait for text "Welcome"

### Expect
- URL should contain /
- Text "Welcome" should be visible
```

Run it from the TUI:

```bash
bun run spec
```

Or run it directly:

```bash
bun run spec run tests/specs/login.md
```

That produces:

- `.spec/compiled/login.json`
- `.spec/results/Login-Flow/result.json`
- `.spec/results/Login-Flow/report.md`
- `.spec/results/Login-Flow/report.html`

## Authoring Modes

`spec` always uses `auto` mode by default.

- It tries fixed grammar first for lower token cost and more deterministic parsing.
- If a test does not look structured, it falls back to freeflow mode and lets the LLM extract steps and expectations.

Fixed grammar example:

```md
# Suite: Checkout

## Test: Buyer completes checkout

### Steps
1. Navigate to /
2. Click the "Buy now" button
3. Wait for text "Checkout"

### Expect
- URL should contain /checkout
- Text "Checkout" should be visible
```

Freeflow example:

```md
# Suite: Checkout

## Test: Buyer completes checkout

Open the storefront, click buy now, continue to checkout, and confirm the checkout page is visible.
```

Recommendation:

- Use fixed grammar for CI-critical and frequently edited tests.
- Use freeflow when non-devs or PMs need to author tests quickly.
- Let auto mode handle both in the same repo.

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
