import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { SymbolResolutionService, ResolutionResult } from '../service/resolution';
import { perfLogger, PerfOps } from '../utils/perfLogger';
import { resolveToIdentifier } from '../utils/nodeUtils';
import { OPERATION_TIMEOUTS, withTimeout } from '../utils/timeout';

export class KanagawaDefinitionProvider implements vscode.DefinitionProvider {
    private readonly resolutionService: SymbolResolutionService;

    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {
        this.resolutionService = new SymbolResolutionService(indexer);
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const endTiming = perfLogger.start(PerfOps.DEFINITION, document.uri.toString());
        try {
            if (token.isCancellationRequested) { return undefined; }
            
            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) { return undefined; }

            if (token.isCancellationRequested) { return undefined; }

            const node = tree.rootNode.descendantForPosition({
                row: position.line,
                column: position.character
            });

            // Use shared utility for consistent identifier resolution
            const identifier = resolveToIdentifier(node);
            if (!identifier) {
                return undefined;
            }

            // Use centralized resolution service with timeout
            const resolution = await withTimeout(
                'definition symbol resolution',
                this.resolutionService.resolveAtPosition({
                    document,
                    position,
                    tree,
                    identifier
                }),
                OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
            );

            if (!resolution || resolution.confidence === 'none' || !resolution.primary) {
                return undefined;
            }

            // For exact or high confidence, always jump directly to the primary (most likely) definition.
            // This matches the behavior of hover, which shows the primary definition.
            // Only show a picker when confidence is medium/low and there are multiple candidates.
            if (resolution.confidence === 'exact' || resolution.confidence === 'high') {
                return new vscode.Location(resolution.primary.uri, resolution.primary.range);
            }

            // Medium/low confidence with multiple matches → return all, VS Code will show picker
            const allMatches = [resolution.primary, ...resolution.alternatives];
            if (allMatches.length > 1) {
                return this.buildLocationArray(allMatches);
            }

            // Single match even at lower confidence → jump directly
            return new vscode.Location(resolution.primary.uri, resolution.primary.range);
        } catch (error) {
            console.error('Kanagawa: Definition provider error:', error);
            return undefined;
        } finally {
            endTiming();
        }
    }

    /**
     * Builds location array with qualified name labels for picker.
     */
    private buildLocationArray(symbols: SymbolInfo[]): vscode.Location[] {
        return symbols.map(sym => new vscode.Location(sym.uri, sym.range));
    }
}
