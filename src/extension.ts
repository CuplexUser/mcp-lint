import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { analyzeSource, AnalyzeOptions, DEFAULT_OPTIONS, LintIssue } from './analyzer';

const DIAGNOSTIC_SOURCE = 'mcp-lint';
const RELEVANT_LANGUAGES = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'];

let diagnostics: vscode.DiagnosticCollection;
let inspectorChannel: vscode.OutputChannel;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function readOptions(): AnalyzeOptions {
  const config = vscode.workspace.getConfiguration('mcpLint');
  const genericNames = config.get<string[]>('genericParamNames', DEFAULT_OPTIONS.genericParamNames);
  return {
    maxDescriptionTokens: config.get<number>('maxDescriptionTokens', DEFAULT_OPTIONS.maxDescriptionTokens),
    genericParamNames: genericNames.map((s) => s.toLowerCase()),
  };
}

function severityToVsCode(severity: LintIssue['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function isRelevantDocument(document: vscode.TextDocument): boolean {
  return RELEVANT_LANGUAGES.includes(document.languageId);
}

function lintDocument(document: vscode.TextDocument): void {
  const config = vscode.workspace.getConfiguration('mcpLint');
  if (!config.get<boolean>('enable', true)) {
    diagnostics.delete(document.uri);
    return;
  }
  if (!isRelevantDocument(document)) return;

  let issues: LintIssue[];
  try {
    issues = analyzeSource(document.getText(), document.fileName, readOptions());
  } catch (err) {
    // Never let a parse failure crash the extension host -- just skip this pass.
    console.error('mcp-lint: analysis failed', err);
    return;
  }

  const vsDiagnostics = issues.map((issue) => {
    const range = new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end));
    const diagnostic = new vscode.Diagnostic(range, issue.message, severityToVsCode(issue.severity));
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = issue.code;
    return diagnostic;
  });

  diagnostics.set(document.uri, vsDiagnostics);
}

function scheduleLint(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => lintDocument(document), 300);
  debounceTimers.set(key, timer);
}

async function runInspectorCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('MCP Lint: open the server file you want to check first.');
    return;
  }
  const document = editor.document;
  if (document.isUntitled) {
    vscode.window.showWarningMessage('MCP Lint: save the file before running the Inspector CLI on it.');
    return;
  }
  if (document.isDirty) {
    await document.save();
  }

  const config = vscode.workspace.getConfiguration('mcpLint');
  const baseCommand = config.get<string>('inspectorCommand', 'npx @modelcontextprotocol/inspector --cli');
  const filePath = document.fileName;
  const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(filePath);

  inspectorChannel.clear();
  inspectorChannel.show(true);
  inspectorChannel.appendLine(`$ ${baseCommand} ${filePath}`);
  inspectorChannel.appendLine('');

  await new Promise<void>((resolve) => {
    cp.exec(
      `${baseCommand} ${JSON.stringify(filePath)}`,
      { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stdout) inspectorChannel.append(stdout);
        if (stderr) inspectorChannel.append(stderr);

        const range = new vscode.Range(0, 0, 0, 0);
        const existing = diagnostics.get(document.uri) ?? [];
        const filtered = existing.filter((d) => d.code !== 'mcp-lint/inspector-cli');

        if (error) {
          const message = `MCP Inspector CLI reported a problem (exit ${
            error.code ?? 'unknown'
          }). See the "MCP Lint: Inspector" output channel for the full report.`;
          const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
          diagnostic.source = DIAGNOSTIC_SOURCE;
          diagnostic.code = 'mcp-lint/inspector-cli';
          diagnostics.set(document.uri, [...filtered, diagnostic]);
          vscode.window.showWarningMessage(message);
        } else {
          diagnostics.set(document.uri, filtered);
          vscode.window.showInformationMessage(
            'MCP Inspector CLI completed without errors. See "MCP Lint: Inspector" output for details.'
          );
        }
        resolve();
      }
    );
  });
}

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  inspectorChannel = vscode.window.createOutputChannel('MCP Lint: Inspector');
  context.subscriptions.push(diagnostics, inspectorChannel);

  for (const document of vscode.workspace.textDocuments) {
    lintDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => lintDocument(document)),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleLint(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => lintDocument(document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mcpLint')) {
        for (const document of vscode.workspace.textDocuments) {
          lintDocument(document);
        }
      }
    }),
    vscode.commands.registerCommand('mcpLint.relintDocument', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) lintDocument(editor.document);
    }),
    vscode.commands.registerCommand('mcpLint.runInspector', () => runInspectorCommand())
  );
}

export function deactivate(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}
