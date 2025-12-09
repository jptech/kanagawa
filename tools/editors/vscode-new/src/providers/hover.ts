import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { SymbolResolutionService, ResolutionResult } from '../service/resolution';
import { extractModuleFromQualified } from '../utils/importUtils';
import { getNodeText, resolveToIdentifier, isModuleOrImportNode } from '../utils/nodeUtils';
import { perfLogger, PerfOps } from '../utils/perfLogger';
import { OPERATION_TIMEOUTS, withTimeout, withProviderGuard } from '../utils/timeout';
import { healthMonitor } from '../service/healthMonitor';

/** Minimum time between hover lookups at the same position (ms) */
const THROTTLE_INTERVAL_MS = 100;

interface CachedHoverResult {
    result: vscode.Hover | undefined;
    timestamp: number;
}

/**
 * Result of resolving hover candidates with confidence scoring.
 * Uses ResolutionResult from the SymbolResolutionService.
 */
type HoverResolution = ResolutionResult;

/**
 * Icons for different symbol categories in hover tooltips.
 */
const CATEGORY_ICONS: Record<string, string> = {
    'module': '📦',
    'class': '🔷',
    'struct': '🔶',
    'union': '🔸',
    'enum': '📋',
    'function': '⚡',
    'method': '🔧',
    'variable': '📌',
    'member': '▪️',
    'constant': '🔒',
    'alias': '🔗',
    'other': '•'
};

export class KanagawaHoverProvider implements vscode.HoverProvider {
    private readonly resolutionService: SymbolResolutionService;
    
    /**
     * Cache for recent hover lookups to avoid expensive recomputation
     * when VS Code repeatedly calls provideHover (e.g., during mouse movement).
     */
    private readonly cache = new Map<string, CachedHoverResult>();
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
    private getCached(key: string): vscode.Hover | undefined | null {
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
    private setCache(key: string, result: vscode.Hover | undefined): void {
        // Trim cache if too large
        if (this.cache.size >= this.maxCacheSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }
        
        this.cache.set(key, { result, timestamp: Date.now() });
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        // Wrap entire hover operation with provider guard for timeout + cancellation protection
        return withProviderGuard(
            {
                operation: 'hover',
                timeoutMs: OPERATION_TIMEOUTS.HOVER,
                token,
                onSuccess: () => healthMonitor.recordSuccess('hover'),
                onFailure: (error) => healthMonitor.recordFailure('hover',
                    error instanceof Error ? error.message : String(error))
            },
            async () => {
                return await perfLogger.measure(PerfOps.HOVER, document.uri.toString(), async () => {
                    // Check for cancellation early
                    if (token.isCancellationRequested) { return undefined; }
                    
                    // Check cache first to avoid expensive recomputation during rapid calls
                    const cacheKey = this.makeCacheKey(document, position);
                    const cached = this.getCached(cacheKey);
                    if (cached !== null) {
                        // Cache hit (even if result is undefined)
                        return cached;
                    }
                    
                    const tree = this.service.getTree(document) ?? await this.service.parse(document);
                    if (!tree) {
                        return undefined;
                    }

                    if (token.isCancellationRequested) { return undefined; }

                    const node = tree.rootNode.descendantForPosition({
                        row: position.line,
                        column: position.character
                    });
                    
                    // CRITICAL: Check the raw node FIRST before any processing.
                    // If we're on a module/import-related node, bail out immediately.
                    // This prevents hangs when hovering on module declarations or import statements.
                    if (isModuleOrImportNode(node)) {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }

                    const identifier = resolveToIdentifier(node);
                    if (!identifier) {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }
                    
                    // Double-check: also verify the resolved identifier isn't in a module context
                    // (belt and suspenders - the raw node check above should catch most cases)
                    if (isModuleOrImportNode(identifier)) {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }

                    const hoverRange = new vscode.Range(
                        new vscode.Position(identifier.startPosition.row, identifier.startPosition.column),
                        new vscode.Position(identifier.endPosition.row, identifier.endPosition.column)
                    );

                    // Try local variable/parameter first
                    const typeInfo = await this.findLocalTypeInfo(document, identifier);
                    if (typeInfo) {
                        // If this is an auto variable with an inlay hint showing the type,
                        // suppress the hover to avoid redundancy
                        if (typeInfo.isAutoWithInlayHint) {
                            this.setCache(cacheKey, undefined);
                            return undefined;
                        }
                        
                        const md = new vscode.MarkdownString();
                        md.appendCodeblock(typeInfo.signature, 'kanagawa');
                        
                        if (typeInfo.initializer) {
                            md.appendMarkdown(`\n---\n`);
                            md.appendMarkdown(`**Initializer**\n\n`);
                            md.appendCodeblock(typeInfo.initializer, 'kanagawa');
                        }
                        
                        md.appendMarkdown(`\n---\n`);
                        md.appendMarkdown(`📌 \`${typeInfo.kind}\``);
                        
                        const result = new vscode.Hover(md, hoverRange);
                        this.setCache(cacheKey, result);
                        return result;
                    }

                    if (token.isCancellationRequested) { return undefined; }

                    // Resolve with confidence scoring using centralized service
                    // Wrap in timeout to prevent hanging on complex resolution
                    const resolution = await withTimeout(
                        'hover symbol resolution',
                        this.resolutionService.resolveAtPosition(
                            { document, position, tree, identifier },
                            { includeInaccessible: true }
                        ),
                        OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                    );

                    if (!resolution || resolution.confidence === 'none') {
                        this.setCache(cacheKey, undefined);
                        return undefined;
                    }

                    // Build hover content based on confidence
                    const markdowns = await this.buildHoverContent(document, resolution);

                    if (markdowns.length > 0) {
                        const result = new vscode.Hover(markdowns, hoverRange);
                        this.setCache(cacheKey, result);
                        return result;
                    }

                    this.setCache(cacheKey, undefined);
                    return undefined;
                }); // end perfLogger.measure
            }
        );
    }

    /**
     * Builds hover markdown content based on resolution result.
     */
    private async buildHoverContent(
        document: vscode.TextDocument,
        resolution: HoverResolution
    ): Promise<vscode.MarkdownString[]> {
        const markdowns: vscode.MarkdownString[] = [];

        if (!resolution.primary) {
            return markdowns;
        }

        // Build primary symbol markdown
        const primaryMd = await this.buildSymbolMarkdown(document, resolution.primary);
        
        // Add alternatives count if there are any
        if (resolution.alternatives.length > 0) {
            primaryMd.appendMarkdown(
                `\n\n*+${resolution.alternatives.length} other definition${resolution.alternatives.length === 1 ? '' : 's'}*`
            );
        }

        markdowns.push(primaryMd);

        // Add import suggestion for inaccessible symbols
        if (resolution.confidence === 'low' && resolution.inaccessible.length > 0) {
            const inaccessibleSym = resolution.inaccessible[0];
            const modulePath = extractModuleFromQualified(inaccessibleSym.qualifiedName);
            if (modulePath) {
                const suggestMd = new vscode.MarkdownString();
                suggestMd.appendMarkdown(`\n\n💡 *Did you mean to import \`${modulePath}\`?*`);
                markdowns.push(suggestMd);
            }
        }

        return markdowns;
    }

    /**
     * Builds markdown for a single symbol with enhanced visual formatting.
     */
    private async buildSymbolMarkdown(
        document: vscode.TextDocument,
        sym: SymbolInfo
    ): Promise<vscode.MarkdownString> {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        
        // Get icon for symbol category
        const icon = CATEGORY_ICONS[sym.category] ?? CATEGORY_ICONS['other'];
        
        // Build signature block
        const summary = (sym.signature ?? `${sym.detail ?? ''} ${sym.name}`.trim()).trim() || sym.name;
        md.appendCodeblock(summary, 'kanagawa');

        // Documentation section
        if (sym.docMarkdown) {
            md.appendMarkdown(`\n${sym.docMarkdown}\n`);
        }

        // Template parameters for applicable symbol types
        // Only show if the symbol actually references template parameters
        const templateCategories = ['class', 'struct', 'union', 'alias', 'function', 'method'];
        if (templateCategories.includes(sym.category)) {
            const templateParams = await this.indexer.getTemplateParametersForSymbol(sym);
            if (templateParams.length > 0) {
                // Check if any template parameters are actually referenced in this symbol
                const relevantParams = this.filterRelevantTemplateParams(sym, templateParams);
                
                if (relevantParams.length > 0) {
                    md.appendMarkdown(`\n---\n`);
                    md.appendMarkdown(`**Template Parameters**\n\n`);
                    for (const param of relevantParams) {
                        const label = param.signature ?? param.name;
                        const doc = param.docMarkdown
                            ? param.docMarkdown
                                .split(/\r?\n/)
                                .map(part => part.trim())
                                .filter(part => part.length)
                                .join(' ')
                            : undefined;
                        if (doc) {
                            md.appendMarkdown(`- \`${label}\` — ${doc}\n`);
                        } else {
                            md.appendMarkdown(`- \`${label}\`\n`);
                        }
                    }
                }
            }
        }

        // Metadata section
        md.appendMarkdown(`\n---\n`);
        
        // Category and scope info on one line
        const scopeText = sym.scopePath.length > 0 
            ? `${sym.scopePath.join('::')}` 
            : '';
        
        if (scopeText) {
            md.appendMarkdown(`${icon} \`${sym.category}\` in \`${scopeText}\`\n\n`);
        } else {
            md.appendMarkdown(`${icon} \`${sym.category}\`\n\n`);
        }
        
        // File location
        const relative = vscode.workspace.asRelativePath(sym.uri, false);
        md.appendMarkdown(`📄 *${relative}*`);

        return md;
    }

    /**
     * Finds local type information for a variable or parameter.
     * Also detects if this is an auto variable that would have an inlay type hint shown.
     * 
     * This only handles true local variables (inside functions/blocks) and parameters.
     * Module-level constants are handled by the symbol resolution path to include doc comments.
     */
    private async findLocalTypeInfo(
        document: vscode.TextDocument, 
        identifier: Parser.SyntaxNode
    ): Promise<{ signature: string; initializer?: string; isAutoWithInlayHint?: boolean; kind: string } | undefined> {
        let current: Parser.SyntaxNode | null = identifier.parent;
        while (current) {
            if (current.type === 'variable_decl') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    // Check if this is a true local variable (inside a function/block)
                    // vs a module-level constant which should be handled by symbol resolution
                    if (!this.isInsideFunction(current)) {
                        // This is a module-level variable/constant - let symbol resolution handle it
                        // so we get the doc comment and proper category
                        return undefined;
                    }
                    
                    const typeNode = current.childForFieldName('type');
                    const initializerNode = current.childForFieldName('initializer');
                    const typeText = getNodeText(document, typeNode);
                    const initializerText = getNodeText(document, initializerNode)?.trim();
                    
                    // Check if this is an auto variable
                    const isAuto = typeText?.includes('auto') ?? false;
                    let isAutoWithInlayHint = false;
                    
                    // If auto with initializer, check if we can infer the type
                    // (which means an inlay hint would be shown)
                    if (isAuto && initializerNode) {
                        const config = vscode.workspace.getConfiguration('kanagawa.inlayHints');
                        const typeHintsEnabled = config.get<boolean>('typeHints.enabled', true);
                        
                        if (typeHintsEnabled) {
                            // Check if we can infer the type - if so, inlay hint is showing
                            const initValue = this.findInitializerValue(current) ?? initializerNode;
                            const inferredType = await this.indexer.inferTypeFromExpression(document, initValue);
                            
                            if (inferredType && inferredType !== 'auto' && inferredType !== 'unknown') {
                                isAutoWithInlayHint = true;
                            }
                        }
                    }
                    
                    const signatureParts = [] as string[];
                    if (typeText) {
                        signatureParts.push(typeText.trim());
                    }
                    signatureParts.push(identifier.text);
                    return {
                        signature: signatureParts.join(' '),
                        initializer: initializerText,
                        isAutoWithInlayHint,
                        kind: 'local variable'
                    };
                }
            } else if (current.type === 'parameter') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    const typeNode = current.childForFieldName('type');
                    const typeText = getNodeText(document, typeNode)?.trim();
                    const signature = typeText ? `${typeText} ${identifier.text}` : identifier.text;
                    return { signature, kind: 'parameter' };
                }
            }
            current = current.parent;
        }
        return undefined;
    }

    /**
     * Checks if a node is inside a function definition (i.e., is a local variable).
     * Module-level variables are not inside functions.
     */
    private isInsideFunction(node: Parser.SyntaxNode): boolean {
        let current: Parser.SyntaxNode | null = node.parent;
        while (current) {
            if (current.type === 'function_definition' || current.type === 'function_template') {
                return true;
            }
            // If we hit module_decl or source_file before a function, it's module-level
            if (current.type === 'module_decl' || current.type === 'source_file') {
                return false;
            }
            current = current.parent;
        }
        return false;
    }

    /**
     * Finds the initializer value in a variable declaration.
     */
    private findInitializerValue(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        // Look for pattern: name = value or name = { ... }
        let foundEquals = false;
        for (const child of node.children) {
            if (child.type === '=' || child.text === '=') {
                foundEquals = true;
                continue;
            }
            if (foundEquals && child.type !== ';') {
                return child;
            }
        }
        return undefined;
    }

    /**
     * Filters template parameters to only include those actually referenced by the symbol.
     * This prevents showing parent class template params for nested symbols that don't use them.
     * 
     * For example, `struct buffer_entry_t` nested inside a templated class shouldn't show 
     * the parent's template parameters unless the struct actually references them.
     */
    private filterRelevantTemplateParams(sym: SymbolInfo, templateParams: SymbolInfo[]): SymbolInfo[] {
        // Check if this symbol is the actual template definition (has template<...> in signature)
        // vs a nested symbol that inherited template params from its parent
        const isOwnTemplate = sym.signature?.match(/^\s*template\s*</) !== null;
        
        if (isOwnTemplate) {
            // This is the actual template definition, show all its params
            return templateParams;
        }
        
        // For nested symbols (including nested classes/structs), only show params actually referenced
        const textToSearch = [
            sym.signature ?? '',
            sym.typeHint ?? '',
            sym.name
        ].join(' ');
        
        return templateParams.filter(param => {
            const paramName = param.name;
            // Use word boundary matching to avoid false positives
            // e.g., "T" shouldn't match in "TypeName"
            const regex = new RegExp(`\\b${this.escapeRegex(paramName)}\\b`);
            return regex.test(textToSearch);
        });
    }
    
    /**
     * Escapes special regex characters in a string.
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
