import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { SymbolResolutionService } from '../service/resolution';
import { perfLogger, PerfOps } from '../utils/perfLogger';
import { resolveToIdentifier, isModuleOrImportNode } from '../utils/nodeUtils';
import { extractQualifiedStaticMemberContext } from '../utils/qualifiedIdentifierUtils';
import { OPERATION_TIMEOUTS, withTimeout, withProviderGuard } from '../utils/timeout';
import { healthMonitor } from '../service/healthMonitor';

/** Minimum time between definition lookups at the same position (ms) */
const THROTTLE_INTERVAL_MS = 100;

interface CachedResult {
    result: vscode.Definition | undefined;
    timestamp: number;
}

export class KanagawaDefinitionProvider implements vscode.DefinitionProvider {
    private readonly resolutionService: SymbolResolutionService;
    
    /**
     * Cache for recent definition lookups to avoid expensive recomputation
     * when VS Code repeatedly calls provideDefinition (e.g., during Ctrl+hover).
     * Key format: "uri#line:character"
     */
    private readonly cache = new Map<string, CachedResult>();
    private readonly maxCacheSize = 50;

    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {
        this.resolutionService = new SymbolResolutionService(indexer);
    }
    
    /**
     * Generates a cache key for a document position.
     */
    private makeCacheKey(document: vscode.TextDocument, position: vscode.Position): string {
        return `${document.uri.toString()}#${document.version}#${position.line}:${position.character}`;
    }
    
    /**
     * Gets a cached result if available and not expired.
     */
    private getCached(key: string): vscode.Definition | undefined | null {
        const entry = this.cache.get(key);
        if (!entry) { return null; } // null = not in cache
        
        const age = Date.now() - entry.timestamp;
        if (age > THROTTLE_INTERVAL_MS) {
            this.cache.delete(key);
            return null;
        }
        
        return entry.result; // undefined = cached "not found" result
    }
    
    /**
     * Stores a result in the cache.
     */
    private setCache(key: string, result: vscode.Definition | undefined): void {
        // Trim cache if too large
        if (this.cache.size >= this.maxCacheSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }
        
        this.cache.set(key, { result, timestamp: Date.now() });
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const endTiming = perfLogger.start(PerfOps.DEFINITION, document.uri.toString());
        try {
            // Wrap entire definition operation with provider guard for timeout + cancellation protection
            return await withProviderGuard(
                {
                    operation: 'definition',
                    timeoutMs: OPERATION_TIMEOUTS.DEFINITION,
                    token,
                    onSuccess: () => healthMonitor.recordSuccess('definition'),
                    onFailure: (error) => healthMonitor.recordFailure('definition',
                        error instanceof Error ? error.message : String(error))
                },
                async () => {
                    // Check cache first to avoid expensive recomputation during rapid calls
                    const cacheKey = this.makeCacheKey(document, position);
                    const cached = this.getCached(cacheKey);
                    if (cached !== null) {
                        // Cache hit (even if result is undefined)
                        return cached;
                    }
                    
                    const tree = this.service.getTree(document) ?? await this.service.parse(document);
                    if (!tree) { return undefined; }

                    if (token.isCancellationRequested) { return undefined; }

                    const node = tree.rootNode.descendantForPosition({
                        row: position.line,
                        column: position.character
                    });
                    
                    // CRITICAL: Check raw node FIRST before any processing.
                    // If on a module/import-related node, bail immediately to prevent hangs.
                    if (isModuleOrImportNode(node)) {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }

                    // Use shared utility for consistent identifier resolution
                    const identifier = resolveToIdentifier(node);
                    if (!identifier) {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }
                    
                    // Double-check the resolved identifier too (belt and suspenders)
                    if (isModuleOrImportNode(identifier)) {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }
                    
                    if (token.isCancellationRequested) { return undefined; }

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

                    // Special case: qualified static access (EnumType::Value).
                    // Even if our strict import-accessibility check thinks the symbol is
                    // inaccessible, the user is explicitly referencing it; allow jumping to
                    // the best match (or fall back to the enum/type itself).
                    if (!resolution || resolution.confidence === 'none' || !resolution.primary) {
                        const qualifiedCtx = extractQualifiedStaticMemberContext(identifier as any);
                        if (qualifiedCtx) {
                            const resolutionWithInaccessible = await withTimeout(
                                'definition qualified symbol resolution (include inaccessible)',
                                this.resolutionService.resolveAtPosition(
                                    { document, position, tree, identifier },
                                    { includeInaccessible: true }
                                ),
                                OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                            );

                            if (resolutionWithInaccessible?.primary) {
                                const primary = resolutionWithInaccessible.primary;
                                // For exact/high confidence, always jump directly.
                                if (resolutionWithInaccessible.confidence === 'exact' || resolutionWithInaccessible.confidence === 'high') {
                                    const loc = new vscode.Location(primary.uri, primary.range);
                                    this.setCache(cacheKey, loc);
                                    return loc;
                                }

                                const allMatches = [primary, ...resolutionWithInaccessible.alternatives];
                                if (allMatches.length > 1) {
                                    const locs = this.buildLocationArray(allMatches);
                                    this.setCache(cacheKey, locs);
                                    return locs;
                                }

                                const loc = new vscode.Location(primary.uri, primary.range);
                                this.setCache(cacheKey, loc);
                                return loc;
                            }

                            // Fall back to the enum/type definition if member not found.
                            const containerResolution = await withTimeout(
                                'definition qualified container resolution',
                                this.resolutionService.resolveByName(
                                    qualifiedCtx.containerName,
                                    document.uri,
                                    [],
                                    { includeInaccessible: true }
                                ),
                                OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                            );

                            if (containerResolution?.primary) {
                                const loc = new vscode.Location(containerResolution.primary.uri, containerResolution.primary.range);
                                this.setCache(cacheKey, loc);
                                return loc;
                            }
                        }

                        // Default behavior: don't jump when we can't resolve (or only have inaccessible matches).
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }

                    let result: vscode.Definition;
                    
                    // For exact or high confidence, always jump directly to the primary (most likely) definition.
                    // This matches the behavior of hover, which shows the primary definition.
                    // Only show a picker when confidence is medium/low and there are multiple candidates.
                    if (resolution.confidence === 'exact' || resolution.confidence === 'high') {
                        result = new vscode.Location(resolution.primary.uri, resolution.primary.range);
                        this.setCache(cacheKey, result);
                        return result;
                    }

                    // Medium/low confidence with multiple matches → return all, VS Code will show picker
                    const allMatches = [resolution.primary, ...resolution.alternatives];
                    if (allMatches.length > 1) {
                        result = this.buildLocationArray(allMatches);
                        this.setCache(cacheKey, result);
                        return result;
                    }

                    // Single match even at lower confidence → jump directly
                    result = new vscode.Location(resolution.primary.uri, resolution.primary.range);
                    this.setCache(cacheKey, result);
                    return result;
                }
            );
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
