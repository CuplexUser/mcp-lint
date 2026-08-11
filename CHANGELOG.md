# Changelog

## 0.1.0 - Initial release

- Static analysis of `server.tool(...)` / `server.registerTool(...)` calls in TypeScript and
  JavaScript: missing/empty descriptions, missing or malformed input schema, duplicate tool
  names, overly generic parameter names, and description token-bloat.
- Diagnostics surface inline (squiggles) and in the Problems panel, updated on open/edit/save.
- Command: "MCP Lint: Run MCP Inspector CLI on This File" — shells out to
  `npx @modelcontextprotocol/inspector --cli` and surfaces the result as a diagnostic plus a
  dedicated output channel.
- Example fixtures: `examples/good-server.ts` (clean), `examples/bad-server.ts` (trips every rule).
