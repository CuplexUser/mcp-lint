# Changelog

## 0.2.0

- Extension icon.
- New rule: `missing-param-description` — flags input schema parameters (Zod validators) with no
  `.describe(...)` call. Configurable via `mcpLint.requireParamDescriptions` (default `true`).
- Quick fixes (Code Actions) for the most common issues: insert a TODO description, unwrap a
  `z.object(...)` call into a raw shape, scaffold an empty input schema, and add a TODO
  `.describe(...)` call to an undocumented parameter.
- Command: "MCP Lint: Scan Workspace for Problems" — lints every TypeScript/JavaScript file in
  the workspace at once (not just open editors) and reports a summary.
- Status bar item showing the live MCP Lint problem count across the workspace; click to open
  the Problems panel.
- One-time "What's New" notification with a link to this changelog when the extension updates
  to a new version (not shown on first install).

## 0.1.0 - Initial release

- Static analysis of `server.tool(...)` / `server.registerTool(...)` calls in TypeScript and
  JavaScript: missing/empty descriptions, missing or malformed input schema, duplicate tool
  names, overly generic parameter names, and description token-bloat.
- Diagnostics surface inline (squiggles) and in the Problems panel, updated on open/edit/save.
- Command: "MCP Lint: Run MCP Inspector CLI on This File" — shells out to
  `npx @modelcontextprotocol/inspector --cli` and surfaces the result as a diagnostic plus a
  dedicated output channel.
- Example fixtures: `examples/good-server.ts` (clean), `examples/bad-server.ts` (trips every rule).
