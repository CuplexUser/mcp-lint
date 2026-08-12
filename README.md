# MCP Lint

Real-time diagnostics for MCP (Model Context Protocol) server source, right in the editor, as
you write it — not a separate CLI or web tool you run after the fact.

Existing MCP tooling (MCP Inspector, mcp-registry-validator, `@samsec/mcpx`, etc.) is either a
standalone CLI/web app you point at a *running* server, or an extension that runs the reverse
direction (exposing VS Code's own diagnostics *as* an MCP server for agents to query). MCP Lint
instead watches the source file you're authoring and reports problems the moment you introduce
them, the same way ESLint or a type checker would.

## What it catches (free tier: TypeScript / JavaScript)

Scans `server.tool(...)` and `server.registerTool(...)` calls from the MCP TypeScript/JS SDK:

- **Missing or empty tool descriptions** — agents pick tools by reading this text; no
  description means the tool is effectively invisible.
- **Missing or malformed input schema** — empty `{}` shapes, or a `z.object(...)` call passed
  where the SDK expects a raw Zod shape.
- **Duplicate tool names** — only one registration with a given name is reachable at runtime.
- **Overly generic parameter names** — `data`, `value`, `input`, etc. give a model nothing to
  reason about; configurable via `mcpLint.genericParamNames`.
- **Description token-bloat** — long descriptions cost context on every single call; configurable
  threshold via `mcpLint.maxDescriptionTokens` (default 120 tokens).
- **Missing per-parameter descriptions** — schema properties without a `.describe(...)` call give
  a model nothing to go on for that field; configurable via `mcpLint.requireParamDescriptions`.

Diagnostics appear as squiggly underlines and in the Problems panel, and update as you type
(debounced) and on save.

## Quick fixes

Most issues ship with a one-click Code Action (lightbulb menu, or `Ctrl+.` / `Cmd+.`):

- Insert a TODO description (missing description, on either call shape).
- Unwrap a `z.object(...)` call into a raw Zod shape.
- Scaffold an empty input schema with a TODO placeholder parameter.
- Add a TODO `.describe(...)` call to an undocumented parameter.

## MCP Inspector CLI bridge

Command palette → **"MCP Lint: Run MCP Inspector CLI on This File"** shells out to
`npx @modelcontextprotocol/inspector --cli <file>` (configurable via `mcpLint.inspectorCommand`)
and surfaces the result: a diagnostic on the file plus the full raw output in the
**"MCP Lint: Inspector"** output channel.

## Workspace-wide scan

Command palette → **"MCP Lint: Scan Workspace for Problems"** lints every `.ts`/`.tsx`/`.js`/`.jsx`
file in the workspace in one pass (not just open editors) and reports a summary. Useful before a
commit or PR. A status bar item (bottom right) shows the live total problem count across the
workspace at all times — click it to jump to the Problems panel.

## Install (from source, pre-Marketplace)

```bash
git clone https://github.com/CuplexUser/mcp-lint.git
cd mcp-lint
npm install
npm run compile
```

Open the folder in VS Code and press **F5** (Run → Start Debugging) to launch an Extension
Development Host with MCP Lint active. Open `examples/bad-server.ts` to see every rule fire, and
`examples/good-server.ts` to confirm a clean file reports zero problems.

## Package a `.vsix` locally

```bash
npm install -g @vscode/vsce
vsce package
```

Install the resulting `.vsix` from the Extensions view's "..." menu → **Install from VSIX**.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `mcpLint.enable` | `true` | Enable/disable all diagnostics. |
| `mcpLint.maxDescriptionTokens` | `120` | Token-bloat warning threshold. |
| `mcpLint.genericParamNames` | see `package.json` | Parameter names flagged as too generic. |
| `mcpLint.inspectorCommand` | `npx @modelcontextprotocol/inspector --cli` | Base command for the Inspector bridge. |
| `mcpLint.requireParamDescriptions` | `true` | Warn on schema parameters with no `.describe(...)` call. |

## Roadmap: Pro tier (not built this cycle)

A Python-SDK-aware Pro tier is scoped as a fast follow, not part of this repo yet:

- Static checks for the Python MCP SDK's `@server.call_tool()` / `@mcp.tool()` decorator style
  and Pydantic model schemas, mirroring the same five checks above.
- Planned pricing: **$9 one-time** or **~$4/mo**.
- Requires a payment link (Gumroad or Stripe) wired up by a human account holder — not something
  this repo's automation can provision itself.

## Contributing

Issues and PRs welcome. The analyzer (`src/analyzer.ts`) is a set of syntax-level heuristics on
top of the TypeScript compiler API, not a full type checker — it only reasons about literal
arguments in source text and intentionally skips anything passed in via a variable rather than
guessing.

## License

MIT — see [LICENSE](./LICENSE).
