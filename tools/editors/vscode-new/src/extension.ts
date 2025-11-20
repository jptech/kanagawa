import * as vscode from 'vscode';
import { TreeSitterService } from './service/treeSitter';
import { WorkspaceIndexer } from './service/indexer';
import { QueryManager } from './service/query';
import { KanagawaHoverProvider } from './providers/hover';
import { KanagawaDefinitionProvider } from './providers/definition';
import { KanagawaSemanticTokensProvider, legend } from './providers/semanticTokens';
import { KanagawaDocumentSymbolProvider } from './providers/documentSymbol';
import { KanagawaFoldingRangeProvider } from './providers/folding';
import { KanagawaCompletionItemProvider } from './providers/completion';
import { KanagawaDiagnosticsProvider } from './providers/diagnostics';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Kanagawa "LSP-Lite" is activating...');

    const service = new TreeSitterService(context);
    await service.init();

    const queryManager = new QueryManager(context);
    
    // Preload all queries
    await Promise.all([
        queryManager.loadQuery('highlights'),
        queryManager.loadQuery('definitions'),
        queryManager.loadQuery('outline')
    ]);

    const indexer = new WorkspaceIndexer(service, queryManager);
    const diagnosticsProvider = new KanagawaDiagnosticsProvider(service);
    
    // Initial scan
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: "Indexing Kanagawa Workspace..."
    }, async () => {
        await indexer.scanWorkspace();
    });

    // Register Providers
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('kanagawa', new KanagawaHoverProvider(service, indexer)),
        vscode.languages.registerDefinitionProvider('kanagawa', new KanagawaDefinitionProvider(service, indexer)),
        vscode.languages.registerDocumentSemanticTokensProvider('kanagawa', new KanagawaSemanticTokensProvider(service, queryManager), legend),
        vscode.languages.registerDocumentSymbolProvider('kanagawa', new KanagawaDocumentSymbolProvider(service, queryManager)),
        vscode.languages.registerFoldingRangeProvider('kanagawa', new KanagawaFoldingRangeProvider(service)),
        vscode.languages.registerCompletionItemProvider('kanagawa', new KanagawaCompletionItemProvider(indexer), '.'),
        diagnosticsProvider
    );

    // Events
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
            if (event.document.languageId === 'kanagawa') {
                service.parse(event.document);
                diagnosticsProvider.updateDiagnostics(event.document);
            }
        }),
        vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                service.parse(doc);
                diagnosticsProvider.updateDiagnostics(doc);
            }
        }),
        vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                indexer.updateFile(doc.uri);
            }
        })
    );

    // Parse currently active editor
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'kanagawa') {
        service.parse(vscode.window.activeTextEditor.document);
        diagnosticsProvider.updateDiagnostics(vscode.window.activeTextEditor.document);
    }

    // Debug Command
    context.subscriptions.push(
        vscode.commands.registerCommand('kanagawa.debugParseTree', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const tree = service.getTree(editor.document);
            if (tree) {
                const output = vscode.window.createOutputChannel("Kanagawa Parse Tree");
                output.show();
                output.append(tree.rootNode.toString());
            } else {
                vscode.window.showInformationMessage("No parse tree available.");
            }
        })
    );
}

export function deactivate() {}
