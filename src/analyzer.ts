import * as ts from 'typescript';

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

const TODO_DESCRIPTION = 'TODO: describe this tool';

const TOOL_METHOD_NAMES = new Set(['tool', 'registerTool']);

function scriptKindForFile(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Statically scan a source file for MCP TypeScript/JavaScript SDK tool registrations
 * (`server.tool(...)` and `server.registerTool(...)`) and flag common authoring mistakes.
 *
 * This is deliberately a set of shallow, syntax-level heuristics rather than a full type
 * checker: it only reasons about arguments that are literal (string/object literals) in the
 * source text, and silently skips anything passed in via a variable or imported constant
 * rather than guessing.
 */
export function analyzeSource(
  sourceText: string,
  fileName: string,
  options: AnalyzeOptions = DEFAULT_OPTIONS
): LintIssue[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName)
  );

  const issues: LintIssue[] = [];
  const seenNames = new Map<string, ts.Node[]>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && TOOL_METHOD_NAMES.has(callee.name.text)) {
        handleToolCall(callee.name.text, node, sourceFile, options, issues, seenNames);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  for (const nodes of seenNames.values()) {
    if (nodes.length > 1) {
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        issues.push({
          code: 'mcp-lint/duplicate-tool-name',
          message: `Duplicate tool name ${JSON.stringify(getLiteralText(n) ?? '')}. Registering two tools with the same name means only one is reachable at runtime.`,
          severity: 'error',
          start: n.getStart(sourceFile),
          end: n.getEnd(),
        });
      }
    }
  }

  return issues.sort((a, b) => a.start - b.start);
}

function getLiteralText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function checkDescriptionNode(
  descNode: ts.Node | undefined,
  anchor: ts.Node,
  sourceFile: ts.SourceFile,
  options: AnalyzeOptions,
  issues: LintIssue[],
  fix?: LintFix
): void {
  if (!descNode) {
    issues.push({
      code: 'mcp-lint/missing-description',
      message:
        'Tool has no description. Agents choose which tool to call based on this text -- a missing description makes the tool effectively invisible.',
      severity: 'error',
      start: anchor.getStart(sourceFile),
      end: anchor.getEnd(),
      fix,
    });
    return;
  }
  if (!ts.isStringLiteralLike(descNode)) {
    // Not statically analyzable (e.g. a variable or a template literal with expressions).
    return;
  }
  const text = descNode.text;
  if (text.trim().length === 0) {
    issues.push({
      code: 'mcp-lint/missing-description',
      message: 'Tool description is empty. Agents choose which tool to call based on this text.',
      severity: 'error',
      start: descNode.getStart(sourceFile),
      end: descNode.getEnd(),
      fix: {
        title: 'Insert a TODO description',
        edits: [{ start: descNode.getStart(sourceFile), end: descNode.getEnd(), newText: JSON.stringify(TODO_DESCRIPTION) }],
      },
    });
    return;
  }
  const count = tokenCount(text);
  if (count > options.maxDescriptionTokens) {
    issues.push({
      code: 'mcp-lint/description-bloat',
      message: `Tool description is ${count} tokens (threshold ${options.maxDescriptionTokens}). Long descriptions cost context on every call; trim to the essentials and move detail into per-parameter descriptions instead.`,
      severity: 'warning',
      start: descNode.getStart(sourceFile),
      end: descNode.getEnd(),
    });
  }
}

function checkSchemaShape(
  schemaNode: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  options: AnalyzeOptions,
  issues: LintIssue[]
): void {
  if (!schemaNode) return;

  if (ts.isCallExpression(schemaNode)) {
    const calleeText = schemaNode.expression.getText(sourceFile);
    if (/\.object$/.test(calleeText) || /^z\.object$/.test(calleeText)) {
      const firstArg = schemaNode.arguments[0];
      const fix: LintFix | undefined =
        firstArg && ts.isObjectLiteralExpression(firstArg)
          ? {
              title: 'Unwrap z.object(...) into a raw shape',
              edits: [
                {
                  start: schemaNode.getStart(sourceFile),
                  end: schemaNode.getEnd(),
                  newText: firstArg.getText(sourceFile),
                },
              ],
            }
          : undefined;
      issues.push({
        code: 'mcp-lint/malformed-schema',
        message:
          'Input schema should be a plain object of Zod validators (a ZodRawShape), not a z.object(...) call. Pass the shape directly, e.g. { foo: z.string() }.',
        severity: 'error',
        start: schemaNode.getStart(sourceFile),
        end: schemaNode.getEnd(),
        fix,
      });
    }
    return;
  }

  if (!ts.isObjectLiteralExpression(schemaNode)) {
    return; // e.g. a variable reference -- not statically analyzable, don't guess.
  }

  if (schemaNode.properties.length === 0) {
    issues.push({
      code: 'mcp-lint/malformed-schema',
      message:
        'Input schema is an empty object. Either define the parameters this tool accepts, or omit the schema argument entirely for a no-input tool.',
      severity: 'warning',
      start: schemaNode.getStart(sourceFile),
      end: schemaNode.getEnd(),
      fix: {
        title: 'Add a TODO placeholder parameter',
        edits: [
          {
            start: schemaNode.getStart(sourceFile),
            end: schemaNode.getEnd(),
            newText: "{ /* TODO: define input parameters, e.g. exampleParam: z.string().describe('what this controls') */ }",
          },
        ],
      },
    });
    return;
  }

  for (const prop of schemaNode.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const nameNode = prop.name;
    let name: string | undefined;
    if (nameNode && ts.isIdentifier(nameNode)) name = nameNode.text;
    else if (nameNode && ts.isStringLiteralLike(nameNode)) name = nameNode.text;
    if (!name) continue;
    if (options.genericParamNames.includes(name.toLowerCase())) {
      issues.push({
        code: 'mcp-lint/generic-param-name',
        message: `Parameter name "${name}" is too generic for a model to infer meaning from. Prefer a descriptive name (e.g. "repositoryUrl" instead of "input").`,
        severity: 'warning',
        start: nameNode.getStart(sourceFile),
        end: nameNode.getEnd(),
      });
    }
    if (options.requireParamDescriptions && ts.isPropertyAssignment(prop)) {
      const initText = prop.initializer.getText(sourceFile).trim();
      if (/^z\s*\./.test(initText) && !/\.describe\s*\(/.test(initText)) {
        issues.push({
          code: 'mcp-lint/missing-param-description',
          message: `Parameter "${name}" has no .describe(...) call. Per-parameter descriptions help a model fill in the right value without guessing from the name alone.`,
          severity: 'info',
          start: nameNode.getStart(sourceFile),
          end: nameNode.getEnd(),
          fix: {
            title: 'Add a TODO .describe(...) call',
            edits: [
              {
                start: prop.initializer.getEnd(),
                end: prop.initializer.getEnd(),
                newText: ".describe('TODO')",
              },
            ],
          },
        });
      }
    }
  }
}

function handleToolCall(
  methodName: string,
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  options: AnalyzeOptions,
  issues: LintIssue[],
  seenNames: Map<string, ts.Node[]>
): void {
  const args = node.arguments;
  if (args.length === 0) return;

  const nameArg = args[0];
  if (ts.isStringLiteralLike(nameArg)) {
    const list = seenNames.get(nameArg.text) ?? [];
    list.push(nameArg);
    seenNames.set(nameArg.text, list);
  }

  if (methodName === 'registerTool') {
    // registerTool(name, { title?, description, inputSchema?, outputSchema?, annotations? }, callback)
    const config = args[1];
    if (!config || !ts.isObjectLiteralExpression(config)) {
      checkDescriptionNode(undefined, nameArg, sourceFile, options, issues);
      return;
    }
    let descProp: ts.Expression | undefined;
    let schemaProp: ts.Expression | undefined;
    for (const prop of config.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name) ? prop.name.text : undefined;
      if (key === 'description') descProp = prop.initializer;
      if (key === 'inputSchema') schemaProp = prop.initializer;
    }
    const configInsertFix: LintFix = {
      title: 'Insert a TODO description',
      edits: [
        {
          start: config.getStart(sourceFile) + 1,
          end: config.getStart(sourceFile) + 1,
          newText: ` description: ${JSON.stringify(TODO_DESCRIPTION)},`,
        },
      ],
    };
    checkDescriptionNode(descProp, config, sourceFile, options, issues, descProp ? undefined : configInsertFix);
    checkSchemaShape(schemaProp, sourceFile, options, issues);
    return;
  }

  // methodName === 'tool' -- overloaded signature in the SDK:
  //   tool(name, cb)
  //   tool(name, description, cb)
  //   tool(name, paramsSchema, cb)
  //   tool(name, description, paramsSchema, cb)
  //   tool(name, description, paramsSchema, annotations, cb)
  const second = args[1];
  if (!second) {
    checkDescriptionNode(undefined, nameArg, sourceFile, options, issues);
    return;
  }
  const insertAfterNameFix: LintFix = {
    title: 'Insert a TODO description',
    edits: [{ start: nameArg.getEnd(), end: nameArg.getEnd(), newText: `, ${JSON.stringify(TODO_DESCRIPTION)}` }],
  };
  if (ts.isStringLiteralLike(second)) {
    checkDescriptionNode(second, nameArg, sourceFile, options, issues);
    const third = args[2];
    if (third && !isFunctionLike(third)) {
      checkSchemaShape(third, sourceFile, options, issues);
    }
    return;
  }
  if (isFunctionLike(second)) {
    // tool(name, cb) -- no description, no schema.
    checkDescriptionNode(undefined, nameArg, sourceFile, options, issues, insertAfterNameFix);
    return;
  }
  // tool(name, paramsSchema, cb) -- schema given, description omitted.
  checkDescriptionNode(undefined, nameArg, sourceFile, options, issues, insertAfterNameFix);
  checkSchemaShape(second, sourceFile, options, issues);
}
