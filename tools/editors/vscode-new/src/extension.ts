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
import { KanagawaInlayHintsProvider } from './providers/inlayHints';
import { OutlineFilterManager } from './service/outlineFilters';
import { KeyedDebouncer } from './utils/debounce';
import { perfLogger, PerfLogLevel } from './utils/perfLogger';
import { registerDependencyGraphCommands } from './views/dependencyGraph';
import { IndexStatusBar } from './views/statusBar';
import { healthMonitor } from './service/healthMonitor';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Kanagawa "LSP-Lite" is activating...');

    try {
        // Initialize performance logger (off by default)
        perfLogger.init(context);
        
        // Start health monitoring
        healthMonitor.start();
        context.subscriptions.push(healthMonitor);

        const service = new TreeSitterService(context);
        const initSuccess = await service.init();
        
        if (!initSuccess) {
            vscode.window.showErrorMessage(
                'Kanagawa: Failed to initialize parser. Some features may not work.',
                'Retry'
            ).then(choice => {
                if (choice === 'Retry') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
            // Continue with partial functionality - providers will gracefully degrade
        }

        const queryManager = new QueryManager(context);
    
    // Preload all queries with graceful error handling
    const queryNames = ['highlights', 'definitions', 'outline'] as const;
    const queryResults = await Promise.allSettled(
        queryNames.map(name => queryManager.loadQuery(name))
    );
    
    // Check for failures and notify user
    const failedQueries = queryResults
        .map((result, idx) => ({ result, name: queryNames[idx] }))
        .filter(({ result }) => result.status === 'rejected' || 
                               (result.status === 'fulfilled' && !result.value));
    
    if (failedQueries.length > 0) {
        const failedNames = failedQueries.map(f => f.name).join(', ');
        vscode.window.showWarningMessage(
            `Kanagawa: Failed to load queries (${failedNames}). Some features may not work.`,
            'Retry',
            'Show Diagnostics'
        ).then(choice => {
            if (choice === 'Retry') {
                queryManager.clearFailedQueries();
                vscode.commands.executeCommand('kanagawa.restart');
            } else if (choice === 'Show Diagnostics') {
                vscode.commands.executeCommand('kanagawa.diagnostics');
            }
        });
    }

    const outlineFilters = new OutlineFilterManager();
    
    // Support multi-root workspaces - pass all workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const indexer = new WorkspaceIndexer(service, queryManager, workspaceFolders);
    await indexer.init(context);
    const diagnosticsProvider = new KanagawaDiagnosticsProvider(service);
    const inlayHintsProvider = new KanagawaInlayHintsProvider(service, indexer);
    
    // Create status bar for index visibility
    const statusBar = new IndexStatusBar();
    context.subscriptions.push(statusBar);
    
    // Connect indexer status to status bar
    indexer.setStatusCallback((state, symbolCount, fileCount, error) => {
        statusBar.update({ state, symbolCount, fileCount, errorMessage: error });
    });
    
    // Helper function to read performance configuration
    const getPerformanceConfig = () => {
        const config = vscode.workspace.getConfiguration('kanagawa.performance');
        return {
            debounceDelay: config.get<number>('debounceDelay', 200),
            memberCacheLimit: config.get<number>('memberCacheLimit', 500),
            indexChunkSize: config.get<number>('indexChunkSize', 10)
        };
    };
    
    // Get initial performance config and apply to indexer
    const perfConfig = getPerformanceConfig();
    indexer.updatePerformanceConfig({
        indexChunkSize: perfConfig.indexChunkSize,
        memberCacheLimit: perfConfig.memberCacheLimit
    });
    
    // Debouncer for document change events - prevents excessive parsing during rapid typing
    // Uses configured debounce delay (default 200ms)
    const parseDebouncer = new KeyedDebouncer<string>(perfConfig.debounceDelay);
    context.subscriptions.push(parseDebouncer);

    // Create semantic tokens provider with change notification support
    const semanticTokensProvider = new KanagawaSemanticTokensProvider(service, queryManager);

    // Register Providers FIRST - extension is immediately usable
    // (providers will work with empty/partial index, improving as indexing completes)
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('kanagawa', new KanagawaHoverProvider(service, indexer)),
        vscode.languages.registerDefinitionProvider('kanagawa', new KanagawaDefinitionProvider(service, indexer)),
        vscode.languages.registerDocumentSemanticTokensProvider('kanagawa', semanticTokensProvider, legend),
        vscode.languages.registerDocumentSymbolProvider('kanagawa', new KanagawaDocumentSymbolProvider(service, queryManager, outlineFilters)),
        vscode.languages.registerWorkspaceSymbolProvider(new KanagawaWorkspaceSymbolProvider(indexer, outlineFilters)),
        vscode.languages.registerFoldingRangeProvider('kanagawa', new KanagawaFoldingRangeProvider(service)),
        vscode.languages.registerCompletionItemProvider('kanagawa', new KanagawaCompletionItemProvider(indexer, service), '.'),
        vscode.languages.registerSignatureHelpProvider('kanagawa', new KanagawaSignatureHelpProvider(service, indexer), {
            triggerCharacters: ['(', ',', '<'],
            retriggerCharacters: [')', ',', ' ', '>']
        }),
        vscode.languages.registerCodeLensProvider({ language: 'kanagawa' }, new KanagawaTypePeekCodeLensProvider(service, indexer)),
        vscode.languages.registerReferenceProvider('kanagawa', new KanagawaReferencesProvider(service, indexer)),
        vscode.languages.registerCallHierarchyProvider('kanagawa', new KanagawaCallHierarchyProvider(service, indexer)),
        vscode.languages.registerInlayHintsProvider('kanagawa', inlayHintsProvider),
        diagnosticsProvider,
        outlineFilters,
        semanticTokensProvider
    );

    // Background indexing - starts after a short delay to let the UI settle
    // The extension is usable immediately; indexing improves completions/go-to-def over time
    setTimeout(() => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Indexing Kanagawa Workspace..."
        }, async () => {
            await indexer.scanWorkspace();
        }).then(undefined, (err) => {
            console.error('Kanagawa: Background indexing failed:', err);
            // Ensure status bar shows error state
            statusBar.update({ 
                state: 'error', 
                symbolCount: 0, 
                fileCount: 0, 
                errorMessage: String(err) 
            });
        });
    }, 100); // 100ms delay lets VS Code finish loading

    // Register dependency graph commands
    registerDependencyGraphCommands(context, indexer);

    // Events - document lifecycle management
    context.subscriptions.push(
        // Debounced document change handler - waits for typing to pause before parsing
        vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
            if (event.document.languageId === 'kanagawa') {
                const uri = event.document.uri.toString();
                
                // Immediately invalidate inlay hints cache for responsive UI
                // (inlay hints will be recalculated when VS Code requests them)
                inlayHintsProvider.invalidateCache(event.document.uri);
                
                // Note: We intentionally do NOT pass contentChanges to parse() here.
                // When debouncing, the contentChanges captured at event time become stale
                // by the time the callback runs (the document has changed further).
                // A full reparse with the current document text is more reliable.
                // Incremental parsing is still used for non-debounced scenarios.
                
                // Debounce parsing and diagnostics to avoid excessive processing during rapid typing
                // The debouncer handles async callbacks safely with proper error catching
                parseDebouncer.debounce(uri, async () => {
                    // Verify document is still open (it could have been closed during the delay)
                    if (!event.document.isClosed) {
                        // Full reparse - document text is current, incremental changes are stale
                        await service.parse(event.document);
                        await diagnosticsProvider.updateDiagnostics(event.document);
                        
                        // Signal VS Code to refresh semantic tokens now that we have a fresh parse tree
                        // This fixes desync issues where tokens were computed from stale trees
                        semanticTokensProvider.notifyTokensChanged();
                    }
                });
            }
        }),

        // Document open handler - parse asynchronously and ensure file is indexed
        // Uses setImmediate pattern to avoid blocking the event loop during rapid file opens
        vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                console.log('Kanagawa: Document opened:', doc.uri.toString());
                
                // Defer parsing to avoid blocking the event loop
                // This is especially important during activation when multiple files may be open
                setTimeout(async () => {
                    try {
                        // Verify document is still open (could have been closed during the yield)
                        if (!doc.isClosed) {
                            await service.parse(doc);
                            await diagnosticsProvider.updateDiagnostics(doc);
                            
                            // Signal semantic tokens refresh after initial parse
                            semanticTokensProvider.notifyTokensChanged();
                            
                            // Priority index: ensure this file is indexed for hover/go-to-def
                            // This runs in background and doesn't block the document opening
                            indexer.ensureFileIndexed(doc.uri).catch((err) => {
                                console.error('Kanagawa: Failed to index opened file:', err);
                            });
                        }
                    } catch (err) {
                        // Don't let errors in parsing/diagnostics crash the extension
                        console.error('Kanagawa: Error handling document open:', err);
                    }
                }, 0);
            }
        }),

        // Document close handler - cleanup resources to prevent memory leaks
        vscode.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                const uri = doc.uri.toString();
                console.log('Kanagawa: Document closed:', uri);
                
                // Cancel any pending debounced operations for this document
                parseDebouncer.cancel(uri);
                
                // Remove cached parse tree (use sync version since we can't await in event handler)
                service.removeSync(doc);
                
                // Clear diagnostics for closed document
                diagnosticsProvider.clearDiagnostics(doc);
                
                // Clear inlay hints cache for closed document
                inlayHintsProvider.invalidateCache(doc.uri);
                
                // Clear resolved imports cache for this document to prevent memory growth
                indexer.invalidateResolvedImports(doc.uri);
            }
        }),

        // Document save handler - update the workspace index
        // Error handling ensures index update failures don't crash the extension
        vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
            if (doc.languageId === 'kanagawa') {
                console.log('Kanagawa: Document saved, updating index:', doc.uri.toString());
                indexer.updateFile(doc.uri).catch((err) => {
                    console.error('Kanagawa: Failed to update index on save:', err);
                });
            }
        }),
        
        // Configuration change handler - update performance settings
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('kanagawa.performance')) {
                const newConfig = getPerformanceConfig();
                indexer.updatePerformanceConfig({
                    indexChunkSize: newConfig.indexChunkSize,
                    memberCacheLimit: newConfig.memberCacheLimit
                });
                console.log('Kanagawa: Performance configuration updated:', newConfig);
            }
        })
    );

    // Parse currently active editor - run asynchronously to avoid blocking activation
    // The extension is usable immediately; parsing improves features as it completes
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'kanagawa') {
        // Use setImmediate-style pattern to yield control back to VS Code
        setTimeout(async () => {
            try {
                const doc = vscode.window.activeTextEditor?.document;
                if (doc && doc.languageId === 'kanagawa') {
                    await service.parse(doc);
                    await diagnosticsProvider.updateDiagnostics(doc);
                }
            } catch (err) {
                console.error('Kanagawa: Failed to parse active editor on activation:', err);
            }
        }, 0);
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
            try {
                indexer.clearIndex();
                vscode.window.showInformationMessage('Kanagawa index cleared. Use "Rebuild Index" to re-index the workspace.');
            } catch (error) {
                console.error('Kanagawa: Failed to clear index:', error);
                vscode.window.showErrorMessage(
                    `Kanagawa: Failed to clear index: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }),
        vscode.commands.registerCommand('kanagawa.index.rebuild', async () => {
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Kanagawa: Rebuilding index...',
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ message: 'Clearing existing index...' });
                    indexer.clearIndex();
                    
                    progress.report({ message: 'Scanning workspace...' });
                    await indexer.scanWorkspace(token);
                    
                    if (token.isCancellationRequested) {
                        vscode.window.showWarningMessage('Kanagawa: Index rebuild cancelled.');
                        return;
                    }
                    
                    const stats = indexer.getStats();
                    progress.report({ message: `Indexed ${stats.totalSymbols} symbols` });
                });
                
                const stats = indexer.getStats();
                vscode.window.showInformationMessage(
                    `Kanagawa index rebuilt: ${stats.totalSymbols} symbols from ${stats.uniqueFiles} files.`
                );
            } catch (error) {
                console.error('Kanagawa: Failed to rebuild index:', error);
                vscode.window.showErrorMessage(
                    `Kanagawa: Failed to rebuild index: ${error instanceof Error ? error.message : String(error)}`,
                    'Show Diagnostics'
                ).then(choice => {
                    if (choice === 'Show Diagnostics') {
                        vscode.commands.executeCommand('kanagawa.diagnostics');
                    }
                });
            }
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
        }),
        // Performance logging commands
        vscode.commands.registerCommand('kanagawa.perf.toggle', async () => {
            const currentLevel = perfLogger.getLevel();
            const options = [
                { label: 'Off', description: 'Disable performance logging', level: PerfLogLevel.Off },
                { label: 'Summary', description: 'Log only slow operations (>100ms)', level: PerfLogLevel.Summary },
                { label: 'Verbose', description: 'Log all operations', level: PerfLogLevel.Verbose }
            ];
            const pick = await vscode.window.showQuickPick(options, {
                placeHolder: `Current level: ${PerfLogLevel[currentLevel]}. Select new level:`
            });
            if (pick) {
                perfLogger.setLevel(pick.level);
                vscode.window.showInformationMessage(`Kanagawa performance logging: ${pick.label}`);
            }
        }),
        vscode.commands.registerCommand('kanagawa.perf.showSummary', () => {
            perfLogger.printSummary();
        }),
        vscode.commands.registerCommand('kanagawa.perf.clear', () => {
            perfLogger.clearStats();
            vscode.window.showInformationMessage('Kanagawa performance stats cleared.');
        }),
        vscode.commands.registerCommand('kanagawa.perf.setThreshold', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Set slow operation threshold in milliseconds',
                value: '100',
                validateInput: (v) => {
                    const n = parseInt(v, 10);
                    return isNaN(n) || n < 0 ? 'Enter a positive number' : undefined;
                }
            });
            if (value) {
                perfLogger.setSlowThreshold(parseInt(value, 10));
                vscode.window.showInformationMessage(`Kanagawa slow threshold set to ${value}ms`);
            }
        }),
        // Diagnostics command - shows extension health status
        vscode.commands.registerCommand('kanagawa.diagnostics', async () => {
            const diagOutput = vscode.window.createOutputChannel('Kanagawa Diagnostics');
            diagOutput.clear();
            diagOutput.show(true);
            
            diagOutput.appendLine('═══════════════════════════════════════════════════════════');
            diagOutput.appendLine('                   KANAGAWA DIAGNOSTICS');
            diagOutput.appendLine('═══════════════════════════════════════════════════════════');
            diagOutput.appendLine('');
            
            // Tree-sitter status
            diagOutput.appendLine('▶ Tree-sitter Service:');
            const treeSitterOk = service.isReady();
            diagOutput.appendLine(`    Status: ${treeSitterOk ? '✓ Initialized' : '✗ NOT INITIALIZED'}`);
            if (!treeSitterOk) {
                diagOutput.appendLine('    ⚠ Parse tree features will not work. Try "Kanagawa: Restart Extension".');
            }
            diagOutput.appendLine('');
            
            // Index status
            diagOutput.appendLine('▶ Workspace Index:');
            const stats = indexer.getStats();
            diagOutput.appendLine(`    Total symbols: ${stats.totalSymbols}`);
            diagOutput.appendLine(`    Files indexed: ${stats.uniqueFiles}`);
            diagOutput.appendLine(`    Verbose mode: ${stats.verbose ? 'enabled' : 'disabled'}`);
            if (stats.totalSymbols === 0) {
                diagOutput.appendLine('    ⚠ No symbols indexed. Try "Kanagawa: Rebuild Index".');
            }
            diagOutput.appendLine('');
            
            // Configuration status
            diagOutput.appendLine('▶ Configuration:');
            const config = vscode.workspace.getConfiguration('kanagawa');
            const importPaths = config.get<string[]>('index.importPaths') ?? [];
            const stdlibPath = config.get<string>('index.stdlibPath') ?? '';
            const excludePatterns = config.get<string[]>('index.exclude') ?? [];
            diagOutput.appendLine(`    Import paths: ${importPaths.length > 0 ? importPaths.join(', ') : '(none)'}`);
            diagOutput.appendLine(`    Stdlib path: ${stdlibPath || '(not set)'}`);
            diagOutput.appendLine(`    Exclude patterns: ${excludePatterns.length > 0 ? excludePatterns.join(', ') : '(none)'}`);
            diagOutput.appendLine('');
            
            // kanagawa.config.json status
            diagOutput.appendLine('▶ Project Configuration (kanagawa.config.json):');
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const configUri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'kanagawa.config.json');
                    try {
                        const configDoc = await vscode.workspace.openTextDocument(configUri);
                        const configJson = JSON.parse(configDoc.getText());
                        diagOutput.appendLine(`    Found: ${configUri.fsPath}`);
                        if (configJson.importPaths) {
                            diagOutput.appendLine(`    importPaths: ${JSON.stringify(configJson.importPaths)}`);
                        }
                        if (configJson.stdlibPath) {
                            diagOutput.appendLine(`    stdlibPath: ${configJson.stdlibPath}`);
                        }
                    } catch {
                        diagOutput.appendLine('    Not found or invalid (using VS Code settings instead)');
                    }
                } else {
                    diagOutput.appendLine('    No workspace folder open');
                }
            } catch (e) {
                diagOutput.appendLine(`    Error checking config: ${e}`);
            }
            diagOutput.appendLine('');
            
            // Workspace status
            diagOutput.appendLine('▶ Workspace:');
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                for (const folder of folders) {
                    diagOutput.appendLine(`    Folder: ${folder.uri.fsPath}`);
                }
            } else {
                diagOutput.appendLine('    No workspace folders open');
            }
            diagOutput.appendLine('');
            
            // Recovery options
            diagOutput.appendLine('═══════════════════════════════════════════════════════════');
            diagOutput.appendLine('                    RECOVERY OPTIONS');
            diagOutput.appendLine('═══════════════════════════════════════════════════════════');
            diagOutput.appendLine('');
            diagOutput.appendLine('If you encounter issues, try these commands:');
            diagOutput.appendLine('  • "Kanagawa: Clear Index" - Clears cached symbols');
            diagOutput.appendLine('  • "Kanagawa: Rebuild Index" - Re-scans workspace files');
            diagOutput.appendLine('  • "Kanagawa: Restart Extension" - Reinitializes everything');
            diagOutput.appendLine('  • "Developer: Reload Window" - Full VS Code reload');
            diagOutput.appendLine('');
            
            // Health Monitor Statistics
            diagOutput.appendLine('▶ Provider Health Statistics:');
            const healthStats = healthMonitor.getStats();
            let unhealthyCount = 0;
            for (const [operation, opStats] of healthStats) {
                const total = opStats.successes + opStats.failures;
                if (total === 0) {
                    diagOutput.appendLine(`    ${operation}: No activity`);
                } else {
                    const failureRate = total > 0 ? Math.round((opStats.failures / total) * 100) : 0;
                    const status = opStats.consecutiveFailures >= 5 
                        ? '⚠️ UNHEALTHY' 
                        : failureRate > 50 
                            ? '⚠️ DEGRADED' 
                            : '✓ OK';
                    if (opStats.consecutiveFailures >= 5 || failureRate > 50) {
                        unhealthyCount++;
                    }
                    diagOutput.appendLine(`    ${operation}: ${status} (${opStats.successes}/${total} success, ${opStats.consecutiveFailures} consecutive failures)`);
                    if (opStats.lastError) {
                        diagOutput.appendLine(`        Last error: ${opStats.lastError.substring(0, 100)}`);
                    }
                }
            }
            diagOutput.appendLine('');
            
            // Overall health
            const isHealthy = treeSitterOk && stats.totalSymbols > 0 && unhealthyCount === 0;
            diagOutput.appendLine('═══════════════════════════════════════════════════════════');
            diagOutput.appendLine(`Overall Status: ${isHealthy ? '✓ HEALTHY' : '⚠ ISSUES DETECTED'}`);
            diagOutput.appendLine('═══════════════════════════════════════════════════════════');
        }),
        // Restart command - reinitializes the extension
        vscode.commands.registerCommand('kanagawa.restart', async () => {
            const choice = await vscode.window.showWarningMessage(
                'Restart Kanagawa extension? This will clear all caches and reinitialize.',
                'Restart',
                'Cancel'
            );
            
            if (choice !== 'Restart') {
                return;
            }
            
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Kanagawa: Restarting...',
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: 'Clearing caches...' });
                    indexer.clearIndex();
                    perfLogger.clearStats();
                    healthMonitor.reset();
                    
                    progress.report({ message: 'Reinitializing Tree-sitter...' });
                    await service.init();
                    
                    progress.report({ message: 'Rebuilding index...' });
                    await indexer.scanWorkspace();
                    
                    const stats = indexer.getStats();
                    progress.report({ message: `Done! Indexed ${stats.totalSymbols} symbols.` });
                });
                
                vscode.window.showInformationMessage('Kanagawa extension restarted successfully.');
            } catch (error) {
                console.error('Kanagawa: Failed to restart:', error);
                vscode.window.showErrorMessage(
                    `Kanagawa: Failed to restart: ${error instanceof Error ? error.message : String(error)}`,
                    'Reload Window'
                ).then(choice => {
                    if (choice === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            }
        }),
        // Open or create project configuration file
        vscode.commands.registerCommand('kanagawa.openConfig', async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showWarningMessage('Kanagawa: No workspace folder open.');
                return;
            }

            const configUri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'kanagawa.config.json');
            
            try {
                // Try to open existing config
                const doc = await vscode.workspace.openTextDocument(configUri);
                await vscode.window.showTextDocument(doc);
            } catch {
                // Config doesn't exist - offer to create it
                const choice = await vscode.window.showInformationMessage(
                    'No kanagawa.config.json found. Create one?',
                    'Create',
                    'Cancel'
                );
                
                if (choice === 'Create') {
                    const defaultConfig = {
                        importPaths: [],
                        stdlibPath: "",
                        exclude: [
                            "**/generated/**",
                            "**/*.gen.k"
                        ]
                    };
                    
                    const edit = new vscode.WorkspaceEdit();
                    edit.createFile(configUri, { ignoreIfExists: true });
                    await vscode.workspace.applyEdit(edit);
                    
                    const doc = await vscode.workspace.openTextDocument(configUri);
                    const editor = await vscode.window.showTextDocument(doc);
                    
                    await editor.edit(editBuilder => {
                        editBuilder.insert(new vscode.Position(0, 0), JSON.stringify(defaultConfig, null, 4));
                    });
                    
                    await doc.save();
                }
            }
        })
    );
    } catch (error) {
        console.error('Kanagawa: Critical error during activation:', error);
        vscode.window.showErrorMessage(
            `Kanagawa: Extension failed to activate: ${error instanceof Error ? error.message : String(error)}`,
            'Reload Window'
        ).then(choice => {
            if (choice === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }
}

export function deactivate(): void {
    console.log('Kanagawa "LSP-Lite" is deactivating.');
}
