import * as vscode from 'vscode';
import { TreeSitterService } from './service/treeSitter';
import { WorkspaceIndexer } from './service/indexer';
import { QueryManager } from './service/query';
import { KanagawaHoverProvider } from './providers/hover';
import { KanagawaDefinitionProvider } from './providers/definition';
import { KanagawaSemanticTokensProvider, legend } from './providers/semanticTokens';
import { KanagawaDocumentSymbolProvider } from './providers/documentSymbol';
import { KanagawaWorkspaceSymbolProvider } from './providers/workspaceSymbol';
import { KanagawaFoldingRangeProvider } from './providers/folding';
import { KanagawaCompletionItemProvider } from './providers/completion';
import { KanagawaDiagnosticsProvider } from './providers/diagnostics';
import { KanagawaTypePeekCodeLensProvider } from './providers/typePeek';
import { KanagawaSignatureHelpProvider } from './providers/signatureHelp';
import { KanagawaReferencesProvider, KanagawaCallHierarchyProvider } from './providers/references';
import { OutlineFilterManager } from './service/outlineFilters';

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

    const outlineFilters = new OutlineFilterManager();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const indexer = new WorkspaceIndexer(service, queryManager, workspaceFolder);
    await indexer.init(context);
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
        vscode.languages.registerDocumentSymbolProvider('kanagawa', new KanagawaDocumentSymbolProvider(service, queryManager, outlineFilters)),
        vscode.languages.registerWorkspaceSymbolProvider(new KanagawaWorkspaceSymbolProvider(indexer, outlineFilters)),
        vscode.languages.registerFoldingRangeProvider('kanagawa', new KanagawaFoldingRangeProvider(service)),
        vscode.languages.registerCompletionItemProvider('kanagawa', new KanagawaCompletionItemProvider(indexer, service), '.'),
        vscode.languages.registerSignatureHelpProvider('kanagawa', new KanagawaSignatureHelpProvider(service, indexer), '(', ',', ')'),
        vscode.languages.registerCodeLensProvider({ language: 'kanagawa' }, new KanagawaTypePeekCodeLensProvider(service, indexer)),
        vscode.languages.registerReferenceProvider('kanagawa', new KanagawaReferencesProvider(service, indexer)),
        vscode.languages.registerCallHierarchyProvider('kanagawa', new KanagawaCallHierarchyProvider(service, indexer)),
        diagnosticsProvider,
        outlineFilters
    );

    // Events
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
            if (event.document.languageId === 'kanagawa') {
                // console.log('Kanagawa: Document changed:', event.document.uri.toString());
                service.parse(event.document);
                diagnosticsProvider.updateDiagnostics(event.document);
            }
        }),
        vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                console.log('Kanagawa: Document opened:', doc.uri.toString());
                service.parse(doc);
                diagnosticsProvider.updateDiagnostics(doc);
            }
        }),
        vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                console.log('Kanagawa: Document saved, updating index:', doc.uri.toString());
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

    const output = vscode.window.createOutputChannel('Kanagawa Index');
    const typePeekOutput = vscode.window.createOutputChannel('Kanagawa Type Peek');

    context.subscriptions.push(
        vscode.commands.registerCommand('kanagawa.index.clear', async () => {
            indexer.clearIndex();
            vscode.window.showInformationMessage('Kanagawa index cleared.');
        }),
        vscode.commands.registerCommand('kanagawa.index.rebuild', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: 'Rebuilding Kanagawa index...'
            }, async () => {
                indexer.clearIndex();
                await indexer.scanWorkspace();
            });
            vscode.window.showInformationMessage('Kanagawa index rebuilt.');
        }),
        vscode.commands.registerCommand('kanagawa.index.toggleVerbose', () => {
            const state = indexer.toggleVerbose();
            vscode.window.showInformationMessage(`Kanagawa verbose indexing ${state ? 'enabled' : 'disabled'}.`);
        }),
        vscode.commands.registerCommand('kanagawa.index.showStats', () => {
            const stats = indexer.getStats();
            output.clear();
            output.show(true);
            output.appendLine('Kanagawa Index Statistics');
            output.appendLine(`Total symbol names: ${stats.totalSymbols}`);
            output.appendLine(`Files contributing symbols: ${stats.uniqueFiles}`);
            output.appendLine(`Symbols added in last scan: ${stats.recentlyIndexed}`);
            output.appendLine(`Verbose logging: ${stats.verbose ? 'on' : 'off'}`);
        }),
        vscode.commands.registerCommand('kanagawa.typePeek.show', (info?: { name: string; type: string; document: string; line: number }) => {
            if (!info) { return; }
            typePeekOutput.show(true);
            typePeekOutput.appendLine(`Inferred type for ${info.name} (${info.document}:${info.line})`);
            typePeekOutput.appendLine(`    ${info.type}`);
        }),
        vscode.commands.registerCommand('kanagawa.outline.selectCategories', async () => {
            const snapshot = outlineFilters.getFilters();
            const options = outlineFilters.getCategoryOptions();
            const picks = await vscode.window.showQuickPick(options.map(option => ({
                label: option.label,
                description: option.description,
                picked: snapshot.categories.has(option.value),
                option
            })), {
                canPickMany: true,
                placeHolder: 'Select Kanagawa symbol categories to display in the outline (empty = all)'
            });

            if (!picks) { return; }

            const selected = picks.map(pick => pick.option.value);
            await outlineFilters.setCategories(selected);
            vscode.commands.executeCommand('workbench.action.outline.toggleSortByPosition');
            vscode.commands.executeCommand('workbench.action.outline.toggleSortByPosition');
        }),
        vscode.commands.registerCommand('kanagawa.outline.setModulePrefix', async () => {
            const snapshot = outlineFilters.getFilters();
            const value = await vscode.window.showInputBox({
                prompt: 'Filter outline by module prefix (leave blank for all modules)',
                value: snapshot.modulePrefix ?? ''
            });
            if (value === undefined) { return; }
            await outlineFilters.setModulePrefix(value.trim() === '' ? undefined : value.trim());
            vscode.commands.executeCommand('workbench.action.outline.toggleSortByPosition');
            vscode.commands.executeCommand('workbench.action.outline.toggleSortByPosition');
        }),
        vscode.commands.registerCommand('kanagawa.outline.clearModulePrefix', async () => {
            await outlineFilters.setModulePrefix(undefined);
            vscode.commands.executeCommand('workbench.action.outline.toggleSortByPosition');
            vscode.commands.executeCommand('workbench.action.outline.toggleSortByPosition');
        })
    );
}

export function deactivate(): void {
    console.log('Kanagawa "LSP-Lite" is deactivating.');
}
