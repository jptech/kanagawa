import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolContextHint, SymbolInfo } from '../service/indexer';
import { extractModuleFromQualified } from '../utils/importUtils';
import { perfLogger, PerfOps } from '../utils/perfLogger';

/**
 * Result of definition resolution with confidence scoring.
 */
interface DefinitionResolution {
    /** Primary definition location */
    primary: SymbolInfo | undefined;
    /** Resolution confidence level */
    confidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
    /** All matching definition locations */
    all: SymbolInfo[];
}

export class KanagawaDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}

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

            if (!node || (node.type !== 'identifier' && node.type !== 'type_identifier')) {
                return undefined;
            }

            const resolution = await this.resolveDefinition(document, node);

            if (resolution.confidence === 'none' || !resolution.primary) {
                return undefined;
            }

            // For exact or high confidence, always jump directly to the primary (most likely) definition.
            // This matches the behavior of hover, which shows the primary definition.
            // Only show a picker when confidence is medium/low and there are multiple candidates.
            if (resolution.confidence === 'exact' || resolution.confidence === 'high') {
                return new vscode.Location(resolution.primary.uri, resolution.primary.range);
            }

            // Medium/low confidence with multiple matches → return all, VS Code will show picker
            if (resolution.all.length > 1) {
                return this.buildLocationArray(resolution.all);
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
     * Resolves definition with confidence scoring.
     * Prioritizes same-module definitions over imports.
     */
    private async resolveDefinition(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
    ): Promise<DefinitionResolution> {
        const name = node.text;
        const scopePath = this.indexer.getScopePathForNode(node);
        const contextHint = await this.buildContextHint(document, node);
        const resolvedImports = this.indexer.getResolvedImports(document.uri);

        const matches: SymbolInfo[] = [];
        const seen = new Set<string>();

        const addMatch = (sym: SymbolInfo): boolean => {
            const key = `${sym.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}`;
            if (seen.has(key)) return false;
            seen.add(key);
            matches.push(sym);
            return true;
        };

        // Priority 1: Local symbol (variable/parameter in scope)
        const localSymbol = this.indexer.findNearestLocalSymbol(document, node);
        if (localSymbol) {
            addMatch(localSymbol);
            // Local is definitive - return immediately
            return {
                primary: localSymbol,
                confidence: 'exact',
                all: [localSymbol]
            };
        }

        // Priority 2: Member resolution (for obj.method patterns)
        const memberMatches = await this.indexer.resolveMemberSymbol(document, node);
        if (memberMatches && memberMatches.length > 0) {
            for (const sym of memberMatches) {
                addMatch(sym);
            }
            // Member resolution is typically precise
            if (matches.length === 1) {
                return {
                    primary: matches[0],
                    confidence: 'exact',
                    all: matches
                };
            }
        }

        // Priority 3: Context-aware resolution
        if (matches.length === 0) {
            const resolution = this.indexer.resolveWithContext(name, scopePath, {
                uri: document.uri,
                context: contextHint
            });

            if (resolution.primary) {
                addMatch(resolution.primary);
            }
            for (const alt of resolution.alternatives) {
                addMatch(alt);
            }
        }

        // Priority 4: Document-local symbols
        if (matches.length === 0) {
            const locals = await this.indexer.findSymbolsInDocument(document, name);
            for (const sym of locals) {
                addMatch(sym);
            }
        }

        // Sort: same module first, then imported modules, then others
        const sorted = this.sortByRelevance(matches, resolvedImports);

        return this.computeConfidence(sorted);
    }

    /**
     * Sorts symbols by relevance: same module > imported > other.
     */
    private sortByRelevance(
        symbols: SymbolInfo[],
        resolvedImports: ReturnType<typeof this.indexer.getResolvedImports> | undefined
    ): SymbolInfo[] {
        if (!resolvedImports || symbols.length <= 1) {
            return symbols;
        }

        const getScore = (sym: SymbolInfo): number => {
            const modulePath = extractModuleFromQualified(sym.qualifiedName);

            // Same module = highest
            if (modulePath && modulePath === resolvedImports.currentModule) {
                return 100;
            }

            // Imported module
            if (modulePath && resolvedImports.importedModules.has(modulePath)) {
                return 50;
            }

            // Global (no module)
            if (!modulePath) {
                return 20;
            }

            // Not imported
            return 0;
        };

        return [...symbols].sort((a, b) => getScore(b) - getScore(a));
    }

    /**
     * Computes confidence from sorted matches.
     */
    private computeConfidence(sorted: SymbolInfo[]): DefinitionResolution {
        if (sorted.length === 0) {
            return {
                primary: undefined,
                confidence: 'none',
                all: []
            };
        }

        if (sorted.length === 1) {
            return {
                primary: sorted[0],
                confidence: 'exact',
                all: sorted
            };
        }

        // Check if first match is significantly better than second
        // (This is a simple heuristic - if both are from same module/accessibility level, it's ambiguous)
        return {
            primary: sorted[0],
            confidence: sorted.length <= 2 ? 'high' : 'medium',
            all: sorted
        };
    }

    /**
     * Builds location array with qualified name labels for picker.
     */
    private buildLocationArray(symbols: SymbolInfo[]): vscode.Location[] {
        return symbols.map(sym => {
            const location = new vscode.Location(sym.uri, sym.range);
            // VS Code uses the origin selection range for picker display
            // The qualified name helps distinguish between matches
            return location;
        });
    }

    /**
     * Builds context hint based on identifier usage.
     */
    private async buildContextHint(document: vscode.TextDocument, identifier: Parser.SyntaxNode): Promise<SymbolContextHint> {
        let current = identifier.parent;
        while (current) {
            if (current.type === 'member_expression' && current.namedChildCount >= 2) {
                const propertyNode = current.namedChild(current.namedChildCount - 1);
                if (propertyNode === identifier) {
                    const receiverNode = current.namedChild(0);
                    const receiverType = await this.indexer.inferTypeFromExpression(document, receiverNode ?? undefined);
                    return { kind: 'method', receiverType };
                }
            }
            current = current.parent;
        }
        return { kind: 'free' };
    }
}
