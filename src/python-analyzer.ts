/**
 * python-analyzer.ts — Static analysis for Python MCP server source.
 *
 * Checks the same 6 rules as the TypeScript analyzer but targets Python MCP SDK
 * conventions:
 *   1. @mcp.tool() decorator (fastmcp / mcp.server.fastmcp / mcp.server.MCPServer)
 *   2. @server.list_tools() with Tool(name=, description=, inputSchema=) (v1 low-level)
 *   3. Pydantic BaseModel with Field(description=...) for tool input models
 *
 * Uses regex-based heuristics on source text since we don't have a Python AST parser
 * available in the VS Code extension host. Deliberately skips anything passed via
 * variables or imported constants rather than guessing.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface LintFixEdit {
  start: number;
  end: number;
  newText: string;
}

export interface LintFix {
  title: string;
  edits: LintFixEdit[];
}

export interface LintIssue {
  code: string;
  message: string;
  severity: Severity;
  start: number;
  end: number;
  fix?: LintFix;
}

export interface AnalyzeOptions {
  maxDescriptionTokens: number;
  genericParamNames: string[];
  requireParamDescriptions: boolean;
}

export const DEFAULT_OPTIONS: AnalyzeOptions = {
  maxDescriptionTokens: 120,
  genericParamNames: [
    'data', 'input', 'value', 'values', 'params', 'arg', 'args',
    'obj', 'object', 'item', 'items', 'x', 'y', 'temp', 'foo', 'bar', 'payload', 'body',
  ],
  requireParamDescriptions: true,
};

// ── helpers ──────────────────────────────────────────────────────────────────

function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Build an array of character offsets for the start of each line (0-indexed). */
function buildLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Return the 0-based character offset of (line, column). */
function pos(lineStarts: number[], line: number, col: number): number {
  return lineStarts[line] + col;
}

/** Find the column of the first occurrence of `needle` in `line`. */
function colOf(line: string, needle: string): number {
  const idx = line.indexOf(needle);
  return idx === -1 ? 0 : idx;
}

// ── pattern matchers ─────────────────────────────────────────────────────────

/**
 * Given source text and a start line, consume a balanced-parenthesis expression
 * (e.g. decorator args or a function call). Returns the full text of the
 * expression (including newlines) and the line number *after* the closing paren.
 */
function consumeParenExpr(
  lines: string[],
  startLine: number
): { text: string; nextLine: number } | null {
  let depth = 0;
  let started = false;
  let text = '';
  let i = startLine;
  for (; i < lines.length; i++) {
    const l = lines[i];
    for (let c = 0; c < l.length; c++) {
      if (l[c] === '(') {
        depth++;
        started = true;
      } else if (l[c] === ')') {
        depth--;
      }
    }
    if (started) text += l + '\n';
    if (started && depth === 0) {
      return { text, nextLine: i + 1 };
    }
  }
  return null; // unbalanced
}

/**
 * Consume a triple-quoted string ("""...""") that may span multiple lines.
 * Returns the text between the quotes and the line after the closing quotes.
 */
function consumeTripleQuotedString(
  lines: string[],
  startLine: number,
  startCol: number
): { text: string; nextLine: number } | null {
  // The opening """ is at (startLine, startCol).
  // Scan forward for the closing """.
  let text = '';
  let found = false;
  for (let i = startLine; i < lines.length; i++) {
    const l = lines[i];
    const searchFrom = i === startLine ? startCol + 3 : 0;
    const closeIdx = l.indexOf('"""', searchFrom);
    if (closeIdx !== -1) {
      // Found closing quotes on this line
      if (i === startLine) {
        text += l.substring(startCol + 3, closeIdx);
      } else {
        text += '\n' + l.substring(0, closeIdx);
      }
      found = true;
      return { text, nextLine: i + 1 };
    } else {
      if (i === startLine) {
        text += l.substring(startCol + 3);
      } else {
        text += '\n' + l;
      }
    }
  }
  return found ? { text, nextLine: lines.length } : null;
}

/**
 * Extract a keyword argument value from a Python call expression text.
 * e.g. extractKwarg('name="foo", description="bar"', 'name') => 'foo'
 */
function extractKwarg(exprText: string, key: string): string | undefined {
  const re = new RegExp(`${key}\\s*=\\s*["']([^"']*)["']`);
  const m = exprText.match(re);
  return m ? m[1] : undefined;
}

/**
 * Find the full match of a kwarg including quotes for offset calculation.
 */
function extractKwargFull(exprText: string, key: string): { value: string; start: number; end: number } | undefined {
  const re = new RegExp(`${key}\\s*=\\s*(["'][^"']*["'])`);
  const m = re.exec(exprText);
  if (!m) return undefined;
  // The value without quotes
  const raw = m[1];
  const value = raw.slice(1, -1);
  return { value, start: m.index, end: m.index + m[0].length };
}

// ── main entry point ─────────────────────────────────────────────────────────

export function analyzePythonSource(
  sourceText: string,
  _fileName: string,
  options: AnalyzeOptions = DEFAULT_OPTIONS
): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = sourceText.split('\n');
  const lineStarts = buildLineStarts(sourceText);

  // Track tool names for duplicate detection: name -> [{line, col}]
  const seenNames = new Map<string, { line: number; col: number }[]>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Pattern 1: @mcp.tool() decorator ─────────────────────────────────
    const toolDecoratorMatch = trimmed.match(/^@(\w+)\.tool\s*\(/);
    if (toolDecoratorMatch) {
      const decoratorStartLine = i;
      const decoratorStartCol = colOf(line, '@');

      // Consume the decorator args (may span multiple lines)
      const parenResult = consumeParenExpr(lines, i);
      const decoratorText = parenResult ? parenResult.text : trimmed;
      i = parenResult ? parenResult.nextLine : i + 1;

      // Skip blank lines and chained decorators to find the function def
      while (i < lines.length) {
        const nl = lines[i].trim();
        if (nl === '' || nl.startsWith('@') || nl.startsWith('#')) {
          i++;
          continue;
        }
        break;
      }

      if (i >= lines.length) break;

      const funcMatch = lines[i].match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (!funcMatch) continue;

      const funcName = funcMatch[1];
      const funcLine = i;
      const funcCol = colOf(lines[i], 'def ');

      // Determine tool name: explicit name= kwarg wins, else function name
      const explicitName = extractKwarg(decoratorText, 'name');
      const toolName = explicitName ?? funcName;

      // Determine description: explicit description= kwarg wins, else docstring
      const explicitDesc = extractKwargFull(decoratorText, 'description');
      let description: string | undefined;
      let descStart: number | undefined;
      let descEnd: number | undefined;

      if (explicitDesc) {
        description = explicitDesc.value;
        // Approximate offset within the decorator text, then map to source
        const decoratorFullStart = pos(lineStarts, decoratorStartLine, decoratorStartCol);
        descStart = decoratorFullStart + explicitDesc.start;
        descEnd = decoratorFullStart + explicitDesc.end;
      } else {
        // Look for docstring after the def line
        let docLine = funcLine + 1;
        while (docLine < lines.length && lines[docLine].trim() === '') docLine++;
        if (docLine < lines.length) {
          const docLineText = lines[docLine];
          const docMatch = docLineText.match(/^\s*"""/);
          if (docMatch) {
            const docCol = docLineText.indexOf('"""');
            const docResult = consumeTripleQuotedString(lines, docLine, docCol);
            if (docResult) {
              description = docResult.text.trim();
              descStart = pos(lineStarts, docLine, docCol);
              // Find the closing """ to compute end
              const closeLine = docResult.nextLine - 1;
              const closeLineText = lines[closeLine];
              const closeIdx = closeLine === docLine
                ? closeLineText.indexOf('"""', docCol + 3)
                : closeLineText.indexOf('"""');
              descEnd = pos(lineStarts, closeLine, closeIdx + 3);
            }
          }
        }
      }

      // Check description
      if (!description || description.trim().length === 0) {
        issues.push({
          code: 'mcp-lint/missing-description',
          message:
            'Tool has no description. Agents choose which tool to call based on this text — a missing description makes the tool effectively invisible.',
          severity: 'error',
          start: pos(lineStarts, funcLine, funcCol),
          end: pos(lineStarts, funcLine, funcCol + 4 + funcName.length),
        });
      } else {
        const count = tokenCount(description);
        if (count > options.maxDescriptionTokens) {
          issues.push({
            code: 'mcp-lint/description-bloat',
            message: `Tool description is ${count} tokens (threshold ${options.maxDescriptionTokens}). Long descriptions cost context on every call; trim to the essentials and move detail into per-parameter descriptions instead.`,
            severity: 'warning',
            start: descStart ?? pos(lineStarts, funcLine, funcCol),
            end: descEnd ?? pos(lineStarts, funcLine, funcCol + 4 + funcName.length),
          });
        }
      }

      // Track for duplicate detection
      const existing = seenNames.get(toolName) ?? [];
      existing.push({ line: funcLine, col: funcCol });
      seenNames.set(toolName, existing);

      // Check function parameters for generic names
      const paramsMatch = lines[funcLine].match(/\(([^)]*)\)/);
      if (paramsMatch) {
        const paramsStr = paramsMatch[1];
        const paramRegex = /(\w+)\s*(?::\s*[^,=]+)?\s*(?:=\s*[^,]+)?/g;
        let pm: RegExpExecArray | null;
        while ((pm = paramRegex.exec(paramsStr)) !== null) {
          const paramName = pm[1];
          if (paramName === 'self' || paramName === 'cls' || paramName === 'ctx') continue;
          if (options.genericParamNames.includes(paramName.toLowerCase())) {
            const pCol = lines[funcLine].indexOf(paramName, paramsMatch.index! + 1);
            issues.push({
              code: 'mcp-lint/generic-param-name',
              message: `Parameter name "${paramName}" is too generic for a model to infer meaning from. Prefer a descriptive name (e.g. "repositoryUrl" instead of "input").`,
              severity: 'warning',
              start: pos(lineStarts, funcLine, pCol),
              end: pos(lineStarts, funcLine, pCol + paramName.length),
            });
          }
        }
      }

      continue;
    }

    // ── Pattern 2: @server.list_tools() / @server.call_tool() ────────────
    const serverDecoratorMatch = trimmed.match(/^@(\w+)\.(list_tools|call_tool)\s*\(/);
    if (serverDecoratorMatch) {
      const methodName = serverDecoratorMatch[2];

      // Consume the decorator
      const parenResult = consumeParenExpr(lines, i);
      i = parenResult ? parenResult.nextLine : i + 1;

      // Skip to function def
      while (i < lines.length) {
        const nl = lines[i].trim();
        if (nl === '' || nl.startsWith('@') || nl.startsWith('#')) {
          i++;
          continue;
        }
        break;
      }
      if (i >= lines.length) break;

      const funcMatch = lines[i].match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (!funcMatch) continue;

      const funcStartLine = i;
      const funcIndent = (lines[funcStartLine].match(/^(\s*)/) as RegExpMatchArray)[1].length;
      i++;

      // For list_tools, scan the function body for Tool(...) calls
      if (methodName === 'list_tools') {
        while (i < lines.length) {
          const l = lines[i];
          const currentIndent = (l.match(/^(\s*)/) as RegExpMatchArray)[1].length;

          // If we're back to function indent or less (and not blank), we've left the body
          if (l.trim() !== '' && currentIndent <= funcIndent) break;

          const toolCallMatch = l.match(/\bTool\s*\(/);
          if (toolCallMatch) {
            const toolCallLine = i;
            const toolCallCol = colOf(l, 'Tool');
            const callResult = consumeParenExpr(lines, i);
            const callText = callResult ? callResult.text : l;
            i = callResult ? callResult.nextLine : i + 1;

            // Extract name
            const tName = extractKwarg(callText, 'name');
            if (tName) {
              const existing = seenNames.get(tName) ?? [];
              existing.push({ line: toolCallLine, col: toolCallCol });
              seenNames.set(tName, existing);

              // Check description
              const tDesc = extractKwarg(callText, 'description');
              if (!tDesc || tDesc.trim().length === 0) {
                issues.push({
                  code: 'mcp-lint/missing-description',
                  message:
                    'Tool has no description. Agents choose which tool to call based on this text — a missing description makes the tool effectively invisible.',
                  severity: 'error',
                  start: pos(lineStarts, toolCallLine, toolCallCol),
                  end: pos(lineStarts, toolCallLine, toolCallCol + 4),
                });
              } else {
                const count = tokenCount(tDesc);
                if (count > options.maxDescriptionTokens) {
                  issues.push({
                    code: 'mcp-lint/description-bloat',
                    message: `Tool description is ${count} tokens (threshold ${options.maxDescriptionTokens}). Long descriptions cost context on every call; trim to the essentials.`,
                    severity: 'warning',
                    start: pos(lineStarts, toolCallLine, toolCallCol),
                    end: pos(lineStarts, toolCallLine, toolCallCol + 4),
                  });
                }
              }

              // Check inputSchema for empty dict
              if (/inputSchema\s*=\s*\{\s*\}/.test(callText)) {
                issues.push({
                  code: 'mcp-lint/malformed-schema',
                  message:
                    'Input schema is an empty object. Either define the parameters this tool accepts, or omit the schema argument entirely for a no-input tool.',
                  severity: 'warning',
                  start: pos(lineStarts, toolCallLine, toolCallCol),
                  end: pos(lineStarts, toolCallLine, toolCallCol + 4),
                });
              }

              // Check inputSchema properties for generic names
              const propsMatch = callText.match(/"properties"\s*:\s*\{([^}]*)\}/s);
              if (propsMatch) {
                const propsBlock = propsMatch[1];
                const propNameRegex = /"(\w+)"\s*:/g;
                let pnMatch: RegExpExecArray | null;
                while ((pnMatch = propNameRegex.exec(propsBlock)) !== null) {
                  const propName = pnMatch[1];
                  if (options.genericParamNames.includes(propName.toLowerCase())) {
                    issues.push({
                      code: 'mcp-lint/generic-param-name',
                      message: `Parameter name "${propName}" is too generic for a model to infer meaning from. Prefer a descriptive name.`,
                      severity: 'warning',
                      start: pos(lineStarts, toolCallLine, toolCallCol),
                      end: pos(lineStarts, toolCallLine, toolCallCol + 4),
                    });
                  }
                }
              }
            }
            continue;
          }
          i++;
        }
      }
      // For call_tool, there's not much to lint — the tool definitions are in list_tools.
      // Just skip the function body.
      continue;
    }

    // ── Pattern 3: Pydantic BaseModel ────────────────────────────────────
    const modelMatch = trimmed.match(/^class\s+(\w+)\s*\(\s*(?:.*\.)?BaseModel\s*\)\s*:/);
    if (modelMatch) {
      const classLine = i;
      const classIndent = (line.match(/^(\s*)/) as RegExpMatchArray)[1].length;
      i++;

      while (i < lines.length) {
        const l = lines[i];
        const currentIndent = (l.match(/^(\s*)/) as RegExpMatchArray)[1].length;

        // If we're back to class indent or less (and not blank/comment), we've left the class body
        if (l.trim() !== '' && !l.trim().startsWith('#') && currentIndent <= classIndent) break;

        // Skip blank lines, comments, docstrings, and method definitions
        if (
          l.trim() === '' ||
          l.trim().startsWith('#') ||
          l.trim().startsWith('"""') ||
          l.trim().startsWith("'''") ||
          /^\s+def\s/.test(l) ||
          /^\s+@/.test(l)
        ) {
          i++;
          continue;
        }

        // Match field definition: name: typeAnnotation [= default]
        // Also handles: name: Annotated[type, Field(...)] = default
        const fieldMatch = l.match(/^(\s+)(\w+)\s*:\s*(.+)$/);
        if (fieldMatch) {
          const fieldName = fieldMatch[2];
          const fieldRest = fieldMatch[3];
          const fieldCol = colOf(l, fieldName);

          // Skip private fields, ClassVar, PrivateAttr
          if (
            fieldName.startsWith('_') ||
            fieldRest.includes('PrivateAttr') ||
            fieldRest.includes('ClassVar')
          ) {
            i++;
            continue;
          }

          // Check for generic param names
          if (options.genericParamNames.includes(fieldName.toLowerCase())) {
            issues.push({
              code: 'mcp-lint/generic-param-name',
              message: `Parameter name "${fieldName}" is too generic for a model to infer meaning from. Prefer a descriptive name (e.g. "repositoryUrl" instead of "input").`,
              severity: 'warning',
              start: pos(lineStarts, i, fieldCol),
              end: pos(lineStarts, i, fieldCol + fieldName.length),
            });
          }

          // Check for Field(description=...) or Annotated[..., Field(description=...)]
          if (options.requireParamDescriptions) {
            const hasFieldDesc =
              /Field\s*\([^)]*description\s*=/.test(fieldRest) ||
              /Annotated\s*\[[^\]]*Field\s*\([^)]*description\s*=/.test(fieldRest);
            if (!hasFieldDesc) {
              issues.push({
                code: 'mcp-lint/missing-param-description',
                message: `Field "${fieldName}" has no description. Add Field(description="...") to help a model understand what value to provide for this parameter.`,
                severity: 'info',
                start: pos(lineStarts, i, fieldCol),
                end: pos(lineStarts, i, fieldCol + fieldName.length),
              });
            }
          }
        }
        i++;
      }
      continue;
    }

    i++;
  }

  // ── Duplicate tool name check ──────────────────────────────────────────
  for (const [, occurrences] of seenNames) {
    if (occurrences.length > 1) {
      for (let idx = 1; idx < occurrences.length; idx++) {
        const occ = occurrences[idx];
        issues.push({
          code: 'mcp-lint/duplicate-tool-name',
          message:
            'Duplicate tool name. Registering two tools with the same name means only one is reachable at runtime.',
          severity: 'error',
          start: pos(lineStarts, occ.line, occ.col),
          end: pos(lineStarts, occ.line, occ.col + 4),
        });
      }
    }
  }

  return issues.sort((a, b) => a.start - b.start);
}
