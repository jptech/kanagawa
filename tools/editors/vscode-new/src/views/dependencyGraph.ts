import * as vscode from 'vscode';
import { WorkspaceIndexer } from '../service/indexer';
import * as path from 'path';

/**
 * Module Dependency Graph visualization.
 * 
 * Shows import relationships between modules as:
 * - Text-based tree view in output channel
 * - Mermaid diagram in markdown preview
 */
export class DependencyGraphProvider {
    private outputChannel: vscode.OutputChannel;

    constructor(private indexer: WorkspaceIndexer) {
        this.outputChannel = vscode.window.createOutputChannel('Kanagawa Dependencies');
    }

    /**
     * Shows dependency graph for the current file.
     */
    async showForCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kanagawa') {
            vscode.window.showInformationMessage('Open a Kanagawa file first.');
            return;
        }

        const uri = editor.document.uri;
        const graph = await this.buildDependencyGraph();
        
        // Find the module for current file
        const currentModule = this.findModuleForUri(uri, graph);
        
        this.showTextGraph(currentModule, graph);
    }

    /**
     * Shows the full workspace dependency graph.
     */
    async showFullGraph(): Promise<void> {
        const graph = await this.buildDependencyGraph();
        this.showMermaidGraph(graph);
    }

    /**
     * Shows dependency graph in Quick Pick for navigation.
     */
    async showInteractive(): Promise<void> {
        const graph = await this.buildDependencyGraph();
        const modules = Array.from(graph.keys()).sort();

        if (modules.length === 0) {
            vscode.window.showInformationMessage('No modules found in workspace.');
            return;
        }

        const items: vscode.QuickPickItem[] = modules.map(mod => {
            const deps = graph.get(mod) ?? { imports: [], importedBy: [] };
            return {
                label: mod,
                description: `↓${deps.imports.length} ↑${deps.importedBy.length}`,
                detail: deps.imports.length > 0 
                    ? `imports: ${deps.imports.slice(0, 5).join(', ')}${deps.imports.length > 5 ? '...' : ''}`
                    : undefined
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a module to view its dependencies',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            this.showTextGraph(selected.label, graph);
        }
    }

    /**
     * Builds a dependency graph from the indexed workspace.
     * Returns Map of modulePath → { imports: [], importedBy: [] }
     */
    private async buildDependencyGraph(): Promise<Map<string, DependencyInfo>> {
        const graph = new Map<string, DependencyInfo>();
        const uris = this.indexer.getIndexedUris();

        // First pass: collect all module declarations and their imports
        for (const uri of uris) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const text = doc.getText();
                
                // Extract module declaration
                const moduleMatch = text.match(/^\s*module\s+([\w.]+)/m);
                const modulePath = moduleMatch?.[1];
                
                if (!modulePath) { continue; }
                
                // Initialize module entry
                if (!graph.has(modulePath)) {
                    graph.set(modulePath, { 
                        imports: [], 
                        importedBy: [], 
                        uri,
                        symbolCount: 0 
                    });
                }
                const entry = graph.get(modulePath)!;
                entry.uri = uri;
                
                // Extract imports
                const importRegex = /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/gm;
                let match;
                while ((match = importRegex.exec(text)) !== null) {
                    const importPath = match[1];
                    if (!entry.imports.includes(importPath)) {
                        entry.imports.push(importPath);
                    }
                }
                
            } catch (e) {
                // Ignore files that can't be read
            }
        }
        
        // Second pass: build reverse dependencies (importedBy)
        for (const [modulePath, info] of graph.entries()) {
            for (const importPath of info.imports) {
                // Ensure imported module exists in graph
                if (!graph.has(importPath)) {
                    graph.set(importPath, { imports: [], importedBy: [], uri: undefined, symbolCount: 0 });
                }
                const imported = graph.get(importPath)!;
                if (!imported.importedBy.includes(modulePath)) {
                    imported.importedBy.push(modulePath);
                }
            }
        }
        
        return graph;
    }

    private findModuleForUri(uri: vscode.Uri, graph: Map<string, DependencyInfo>): string | undefined {
        for (const [modulePath, info] of graph.entries()) {
            if (info.uri?.toString() === uri.toString()) {
                return modulePath;
            }
        }
        return undefined;
    }

    /**
     * Shows a text-based tree view of dependencies for a specific module.
     */
    private showTextGraph(modulePath: string | undefined, graph: Map<string, DependencyInfo>): void {
        this.outputChannel.clear();
        this.outputChannel.show(true);
        
        if (!modulePath) {
            this.outputChannel.appendLine('Current file has no module declaration.');
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('All modules in workspace:');
            for (const mod of Array.from(graph.keys()).sort()) {
                const info = graph.get(mod)!;
                this.outputChannel.appendLine(`  ${mod} (↓${info.imports.length} ↑${info.importedBy.length})`);
            }
            return;
        }
        
        const info = graph.get(modulePath);
        if (!info) {
            this.outputChannel.appendLine(`Module ${modulePath} not found in index.`);
            return;
        }
        
        this.outputChannel.appendLine(`Module: ${modulePath}`);
        this.outputChannel.appendLine('═'.repeat(60));
        this.outputChannel.appendLine('');
        
        // Show imports (what this module depends on)
        this.outputChannel.appendLine(`Imports (${info.imports.length}):`);
        if (info.imports.length === 0) {
            this.outputChannel.appendLine('  (none)');
        } else {
            for (const imp of info.imports.sort()) {
                const impInfo = graph.get(imp);
                const status = impInfo?.uri ? '✓' : '?';
                this.outputChannel.appendLine(`  ${status} ${imp}`);
            }
        }
        
        this.outputChannel.appendLine('');
        
        // Show importedBy (what depends on this module)
        this.outputChannel.appendLine(`Imported by (${info.importedBy.length}):`);
        if (info.importedBy.length === 0) {
            this.outputChannel.appendLine('  (none)');
        } else {
            for (const by of info.importedBy.sort()) {
                this.outputChannel.appendLine(`  ← ${by}`);
            }
        }
        
        this.outputChannel.appendLine('');
        
        // Show transitive dependencies (2 levels)
        this.outputChannel.appendLine('Transitive dependencies:');
        const visited = new Set<string>([modulePath]);
        const printDeps = (mod: string, depth: number, prefix: string) => {
            if (depth > 2) { return; }
            const modInfo = graph.get(mod);
            if (!modInfo) { return; }
            
            for (const dep of modInfo.imports) {
                if (visited.has(dep)) {
                    this.outputChannel.appendLine(`${prefix}├─ ${dep} (circular)`);
                } else {
                    visited.add(dep);
                    this.outputChannel.appendLine(`${prefix}├─ ${dep}`);
                    printDeps(dep, depth + 1, prefix + '│  ');
                }
            }
        };
        
        if (info.imports.length === 0) {
            this.outputChannel.appendLine('  (none)');
        } else {
            printDeps(modulePath, 0, '  ');
        }
    }

    /**
     * Shows the full dependency graph as a Mermaid diagram in a Markdown preview.
     */
    private async showMermaidGraph(graph: Map<string, DependencyInfo>): Promise<void> {
        const modules = Array.from(graph.keys()).sort();
        
        if (modules.length === 0) {
            vscode.window.showInformationMessage('No modules found in workspace.');
            return;
        }
        
        // Build Mermaid diagram
        const lines: string[] = [
            '# Kanagawa Module Dependencies',
            '',
            '```mermaid',
            'graph TD'
        ];
        
        // Create safe node IDs (replace dots with underscores)
        const nodeId = (mod: string) => mod.replace(/\./g, '_');
        
        // Add nodes
        for (const mod of modules) {
            const id = nodeId(mod);
            lines.push(`    ${id}["${mod}"]`);
        }
        
        lines.push('');
        
        // Add edges
        for (const mod of modules) {
            const info = graph.get(mod)!;
            const fromId = nodeId(mod);
            
            for (const imp of info.imports) {
                const toId = nodeId(imp);
                lines.push(`    ${fromId} --> ${toId}`);
            }
        }
        
        lines.push('```');
        lines.push('');
        lines.push('## Statistics');
        lines.push('');
        lines.push(`- Total modules: ${modules.length}`);
        
        // Count edges
        let edgeCount = 0;
        for (const info of graph.values()) {
            edgeCount += info.imports.length;
        }
        lines.push(`- Total imports: ${edgeCount}`);
        
        // Find modules with most dependencies
        const byImports = modules
            .map(m => ({ mod: m, count: graph.get(m)!.imports.length }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);
        
        if (byImports.length > 0 && byImports[0].count > 0) {
            lines.push('');
            lines.push('### Most dependencies:');
            for (const { mod, count } of byImports) {
                if (count > 0) {
                    lines.push(`- ${mod}: ${count} imports`);
                }
            }
        }
        
        // Find most depended-upon modules
        const byDependents = modules
            .map(m => ({ mod: m, count: graph.get(m)!.importedBy.length }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);
        
        if (byDependents.length > 0 && byDependents[0].count > 0) {
            lines.push('');
            lines.push('### Most depended upon:');
            for (const { mod, count } of byDependents) {
                if (count > 0) {
                    lines.push(`- ${mod}: ${count} dependents`);
                }
            }
        }
        
        // Create a virtual document and show it
        const content = lines.join('\n');
        const doc = await vscode.workspace.openTextDocument({
            content,
            language: 'markdown'
        });
        
        await vscode.window.showTextDocument(doc, { preview: true });
        
        // Try to open markdown preview
        await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}

interface DependencyInfo {
    imports: string[];
    importedBy: string[];
    uri?: vscode.Uri;
    symbolCount: number;
}

/**
 * Registers dependency graph commands.
 */
export function registerDependencyGraphCommands(
    context: vscode.ExtensionContext,
    indexer: WorkspaceIndexer
): void {
    const provider = new DependencyGraphProvider(indexer);
    
    context.subscriptions.push(
        vscode.commands.registerCommand('kanagawa.deps.showCurrent', () => {
            provider.showForCurrentFile().catch(console.error);
        }),
        vscode.commands.registerCommand('kanagawa.deps.showFull', () => {
            provider.showFullGraph().catch(console.error);
        }),
        vscode.commands.registerCommand('kanagawa.deps.showInteractive', () => {
            provider.showInteractive().catch(console.error);
        }),
        provider
    );
}
