import * as vscode from 'vscode';
import * as path from 'path';

export interface ImportConfiguration {
    importPaths: string[];
    stdlibPath?: string;
    excludePatterns: string[];
}

// Re-export for backwards compatibility
export { matchesGlobPattern } from '../utils/globUtils';

export class ImportConfigService {
    private cachedConfig: ImportConfiguration | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly workspaceFolder: vscode.WorkspaceFolder | undefined) {}

    async init(context: vscode.ExtensionContext): Promise<void> {
        if (this.workspaceFolder) {
            const pattern = new vscode.RelativePattern(this.workspaceFolder, 'kanagawa.config.json');
            this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.watcher.onDidCreate(() => this.invalidate());
            this.watcher.onDidChange(() => this.invalidate());
            this.watcher.onDidDelete(() => this.invalidate());
            context.subscriptions.push(this.watcher);
        }

        const configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('kanagawa.compiler.importPaths') ||
                event.affectsConfiguration('kanagawa.compiler.stdlibPath') ||
                event.affectsConfiguration('kanagawa.index.exclude')) {
                this.invalidate();
            }
        });
        context.subscriptions.push(configListener);
        context.subscriptions.push(this.changeEmitter);
    }

    invalidate(): void {
        this.cachedConfig = undefined;
        this.changeEmitter.fire();
    }

    async resolveImportConfiguration(): Promise<ImportConfiguration> {
        if (this.cachedConfig) { return this.cachedConfig; }

        const base: ImportConfiguration = { importPaths: [], excludePatterns: [] };
        const workspace = await this.readWorkspaceConfig();
        const userSettings = this.readUserSettings();

        const merged: ImportConfiguration = {
            importPaths: this.mergePaths(base.importPaths, workspace.importPaths, userSettings.importPaths),
            stdlibPath: userSettings.stdlibPath ?? workspace.stdlibPath ?? base.stdlibPath,
            excludePatterns: this.mergePatterns(workspace.excludePatterns, userSettings.excludePatterns)
        };

        this.cachedConfig = merged;
        return merged;
    }

    private async readWorkspaceConfig(): Promise<ImportConfiguration> {
        if (!this.workspaceFolder) { return { importPaths: [], excludePatterns: [] }; }
        const uri = vscode.Uri.joinPath(this.workspaceFolder.uri, 'kanagawa.config.json');
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
            return {
                importPaths: this.normalizePaths(this.ensureStringArray(parsed.importPaths)),
                stdlibPath: parsed.stdlibPath ? this.toAbsolute(parsed.stdlibPath) : undefined,
                excludePatterns: this.ensureStringArray(parsed.exclude)
            };
        } catch {
            return { importPaths: [], excludePatterns: [] };
        }
    }

    private readUserSettings(): ImportConfiguration {
        const config = vscode.workspace.getConfiguration('kanagawa.compiler');
        const indexConfig = vscode.workspace.getConfiguration('kanagawa.index');
        const importPaths = this.ensureStringArray(config.get('importPaths'));
        const stdlibPath = config.get<string>('stdlibPath', '').trim();
        const excludePatterns = this.ensureStringArray(indexConfig.get('exclude'));
        return {
            importPaths: this.normalizePaths(importPaths),
            stdlibPath: stdlibPath.length ? this.toAbsolute(stdlibPath) : undefined,
            excludePatterns
        };
    }

    private mergePatterns(...sources: (string[] | undefined)[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const source of sources) {
            if (!source) { continue; }
            for (const entry of source) {
                if (!entry.length) { continue; }
                if (seen.has(entry)) { continue; }
                seen.add(entry);
                result.push(entry);
            }
        }
        return result;
    }

    private mergePaths(...sources: (string[] | undefined)[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const source of sources) {
            if (!source) { continue; }
            for (const entry of source) {
                if (!entry.length) { continue; }
                const normalized = path.normalize(entry);
                if (seen.has(normalized)) { continue; }
                seen.add(normalized);
                result.push(normalized);
            }
        }
        return result;
    }

    private normalizePaths(paths: string[]): string[] {
        return paths.map(p => this.toAbsolute(p)).filter(Boolean) as string[];
    }

    private toAbsolute(entry: string): string {
        if (!this.workspaceFolder) { return path.normalize(path.resolve(entry)); }
        if (path.isAbsolute(entry)) { return path.normalize(entry); }
        return path.normalize(path.join(this.workspaceFolder.uri.fsPath, entry));
    }

    private ensureStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) { return []; }
        return value.filter(v => typeof v === 'string') as string[];
    }
}
