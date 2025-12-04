import * as vscode from 'vscode';
import { WorkspaceIndexer, SymbolCategory } from '../service/indexer';
import { OutlineFilterManager, snapshotContainsCategory, snapshotMatchesPrefix } from '../service/outlineFilters';
import { healthMonitor } from '../service/healthMonitor';

export class KanagawaWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    constructor(
        private readonly indexer: WorkspaceIndexer,
        private readonly filters: OutlineFilterManager
    ) {}

    async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
        try {
            const normalized = query.trim().toLowerCase();
            const snapshot = this.filters.getFilters();
            const results: vscode.SymbolInformation[] = [];

            for (const info of this.indexer.getAllSymbols()) {
                if (token.isCancellationRequested) {
                    break;
                }

                if (!snapshotContainsCategory(snapshot, info.category as SymbolCategory)) {
                    continue;
                }

                const modulePath = info.scopePath.length > 0 ? info.scopePath[0] : undefined;
                if (!snapshotMatchesPrefix(snapshot, modulePath)) {
                    continue;
                }

                if (normalized.length > 0 && !info.name.toLowerCase().includes(normalized)) {
                    continue;
                }

                results.push(new vscode.SymbolInformation(
                    info.name,
                    info.kind,
                    info.scopePath.join('::'),
                    new vscode.Location(info.uri, info.range)
                ));

                if (results.length >= 200) {
                    break;
                }
            }

            healthMonitor.recordSuccess('workspaceSymbols');
            return results;
        } catch (error) {
            healthMonitor.recordFailure('workspaceSymbols', error);
            console.error('[WorkspaceSymbolProvider] Error:', error);
            return [];
        }
    }
}
