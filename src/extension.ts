import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { analyzeSource, AnalyzeOptions, DEFAULT_OPTIONS, LintIssue } from './analyzer';

const DIAGNOSTIC_SOURCE = 'mcp-lint';
const RELEVANT_LANGUAGES = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'];
const WORKSPACE_SCAN_GLOB = '**/*.{ts,tsx,js,jsx}';
const WORKSPACE_SCAN_EXCLUDE = '**/{node_modules,out,dist,.git}/**';
const LAST_VERSION_KEY = 'mcpLint.lastVersion';

let diagnostics: vscode.DiagnosticCollection;
let inspectorChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Last analysis result per document, keyed by uri.toString() -- lets the CodeActionProvider
// recover the structured LintIssue (and its fix, if any) behind a vscode.Diagnostic.
const lastIssuesByUri = new Map<string, LintIssue[]>();

function readOptions(): AnalyzeOptions {
  const config = vscode.workspace.getConfiguration('mcpLint');
  const genericNames = config.get<string[]>('genericParamNames', DEFAULT_OPTIONS.genericParamNames);
  return {
    maxDescriptionTokens: config.get<number>('maxDescriptionTokens', DEFAULT_OPTIONS.maxDescriptionTokens),
    genericParamNames: genericNames.map((s) => s.toLowerCase()),
    requireParamDescriptions: config.get<boolean>('requireParamDescriptions', DEFAULT_OPTIONS.requireParamDescriptions),
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

function issuesToDiagnostics(issues: LintIssue[], document: vscode.TextDocument): vscode.Diagnostic[] {
  return issues.map((issue) => {
    const range = new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end));
    const diagnostic = new vscode.Diagnostic(range, issue.message, severityToVsCode(issue.severity));
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = issue.code;
    return diagnostic;
  });
}

function updateStatusBar(): void {
  let total = 0;
  diagnostics.forEach((_uri, diags) => {
    total += diags.length;
  });
  if (total === 0) {
    statusBarItem.text = '$(check) MCP Lint';
    statusBarItem.tooltip = 'MCP Lint: no problems found';
  } else {
    statusBarItem.text = `$(warning) MCP Lint: ${total}`;
    statusBarItem.tooltip = `MCP Lint: ${total} problem(s) across the workspace -- click to open the Problems panel.`;
  }
  statusBarItem.show();
}

function lintDocument(document: vscode.TextDocument): void {
  const config = vscode.workspace.getConfiguration('mcpLint');
  if (!config.get<boolean>('enable', true)) {
    diagnostics.delete(document.uri);
    lastIssuesByUri.delete(document.uri.toString());
    updateStatusBar();
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

  lastIssuesByUri.set(document.uri.toString(), issues);
  diagnostics.set(document.uri, issuesToDiagnostics(issues, document));
  updateStatusBar();
}

function scheduleLint(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => lintDocument(document), 300);
  debounceTimers.set(key, timer);
}

async function scanWorkspaceCommand(): Promise<void> {
  const options = readOptions();
  const files = await vscode.workspace.findFiles(WORKSPACE_SCAN_GLOB, WORKSPACE_SCAN_EXCLUDE);
  let filesWithIssues = 0;
  let totalIssues = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MCP Lint: scanning workspace', cancellable: false },
    async (progress) => {
      for (let i = 0; i < files.length; i++) {
        const uri = files[i];
        progress.report({ message: `${i + 1}/${files.length}`, increment: 100 / files.length });

        let document: vscode.TextDocument;
        try {
          document = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
          continue;
        }
        if (!isRelevantDocument(document)) continue;

        let issues: LintIssue[];
        try {
          issues = analyzeSource(document.getText(), document.fileName, options);
        } catch (err) {
          console.error('mcp-lint: workspace scan failed for', uri.fsPath, err);
          continue;
        }

        lastIssuesByUri.set(uri.toString(), issues);
        if (issues.length > 0) {
          filesWithIssues++;
          totalIssues += issues.length;
          diagnostics.set(uri, issuesToDiagnostics(issues, document));
        } else {
          diagnostics.delete(uri);
        }
      }
    }
  );

  updateStatusBar();

  if (totalIssues === 0) {
    vscode.window.showInformationMessage(`MCP Lint: scanned ${files.length} file(s), no problems found.`);
  } else {
    vscode.window.showWarningMessage(
      `MCP Lint: found ${totalIssues} problem(s) in ${filesWithIssues} of ${files.length} file(s). See the Problems panel.`
    );
  }
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
        updateStatusBar();
        resolve();
      }
    );
  });
}

class McpLintCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const issues = lastIssuesByUri.get(document.uri.toString());
    if (!issues || issues.length === 0) return [];

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
      const start = document.offsetAt(diagnostic.range.start);
      const end = document.offsetAt(diagnostic.range.end);
      const issue = issues.find((i) => i.code === diagnostic.code && i.start === start && i.end === end);
      if (!issue?.fix) continue;

      const action = new vscode.CodeAction(issue.fix.title, vscode.CodeActionKind.QuickFix);
      const edit = new vscode.WorkspaceEdit();
      for (const e of issue.fix.edits) {
        edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.newText);
      }
      action.edit = edit;
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      actions.push(action);
    }
    return actions;
  }
}

async function maybeShowUpdateNotification(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = (context.extension.packageJSON as { version?: string }).version;
  if (!currentVersion) return;

  const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
  if (lastVersion === currentVersion) return;
  await context.globalState.update(LAST_VERSION_KEY, currentVersion);

  if (lastVersion === undefined) return; // fresh install -- stay quiet, nothing to compare against

  const selection = await vscode.window.showInformationMessage(
    `MCP Lint updated to v${currentVersion}.`,
    'View Changelog'
  );
  if (selection === 'View Changelog') {
    const changelogUri = vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md');
    await vscode.commands.executeCommand('markdown.showPreview', changelogUri);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  inspectorChannel = vscode.window.createOutputChannel('MCP Lint: Inspector');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'workbench.actions.view.problems';
  context.subscriptions.push(diagnostics, inspectorChannel, statusBarItem);
  updateStatusBar();

  void maybeShowUpdateNotification(context);

  for (const document of vscode.workspace.textDocuments) {
    lintDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => lintDocument(document)),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleLint(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => lintDocument(document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      lastIssuesByUri.delete(document.uri.toString());
      updateStatusBar();
    }),
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
    vscode.commands.registerCommand('mcpLint.runInspector', () => runInspectorCommand()),
    vscode.commands.registerCommand('mcpLint.scanWorkspace', () => scanWorkspaceCommand()),
    vscode.languages.registerCodeActionsProvider(RELEVANT_LANGUAGES, new McpLintCodeActionProvider(), {
      providedCodeActionKinds: McpLintCodeActionProvider.providedCodeActionKinds,
    })
  );
}

export function deactivate(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}
