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
    private localWatcher: vscode.FileSystemWatcher | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly workspaceFolder: vscode.WorkspaceFolder | undefined) {}

    async init(context: vscode.ExtensionContext): Promise<void> {
        if (this.workspaceFolder) {
            const sharedPattern = new vscode.RelativePattern(this.workspaceFolder, 'kanagawa.config.json');
            this.watcher = vscode.workspace.createFileSystemWatcher(sharedPattern);
            this.watcher.onDidCreate(() => this.invalidate());
            this.watcher.onDidChange(() => this.invalidate());
            this.watcher.onDidDelete(() => this.invalidate());
            context.subscriptions.push(this.watcher);

            const localPattern = new vscode.RelativePattern(this.workspaceFolder, 'kanagawa.config.local.json');
            this.localWatcher = vscode.workspace.createFileSystemWatcher(localPattern);
            this.localWatcher.onDidCreate(() => this.invalidate());
            this.localWatcher.onDidChange(() => this.invalidate());
            this.localWatcher.onDidDelete(() => this.invalidate());
            context.subscriptions.push(this.localWatcher);
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
        const shared = await this.readConfigFile('kanagawa.config.json');
        const local = await this.readConfigFile('kanagawa.config.local.json');

        const merged: ImportConfiguration = {
            importPaths: this.mergePaths(shared.config.importPaths, local.config.importPaths),
            stdlibPath: local.config.stdlibPath ?? shared.config.stdlibPath,
            excludePatterns: this.mergePatterns(shared.config.excludePatterns, local.config.excludePatterns)
        };

        if (shared.loaded || local.loaded) {
            const sourceLabel = local.loaded
                ? (shared.loaded ? 'kanagawa.config.json + kanagawa.config.local.json' : 'kanagawa.config.local.json')
                : 'kanagawa.config.json';
            const pathCount = merged.importPaths.length;
            const excludeCount = merged.excludePatterns.length;
            const parts = [`${pathCount} import path${pathCount !== 1 ? 's' : ''}`];
            if (merged.stdlibPath) {
                parts.push(`stdlib: ${merged.stdlibPath}`);
            }
            if (excludeCount > 0) {
                parts.push(`${excludeCount} exclude pattern${excludeCount !== 1 ? 's' : ''}`);
            }
            console.log(`Kanagawa: Loaded ${sourceLabel} from ${this.workspaceFolder.name}: ${parts.join(', ')}`);
        }

        return merged;
    }

    private async readConfigFile(fileName: 'kanagawa.config.json' | 'kanagawa.config.local.json'): Promise<{ config: ImportConfiguration; loaded: boolean }>{
        if (!this.workspaceFolder) { return { config: { importPaths: [], excludePatterns: [] }, loaded: false }; }
        const uri = vscode.Uri.joinPath(this.workspaceFolder.uri, fileName);
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
            const config: ImportConfiguration = {
                importPaths: this.normalizePaths(this.ensureStringArray((parsed as any).importPaths)),
                stdlibPath: (parsed as any).stdlibPath ? this.toAbsolute(String((parsed as any).stdlibPath)) : undefined,
                excludePatterns: this.ensureStringArray((parsed as any).exclude)
            };
            return { config, loaded: true };
        } catch {
            return { config: { importPaths: [], excludePatterns: [] }, loaded: false };
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
