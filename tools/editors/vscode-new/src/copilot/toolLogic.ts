/**
 * Pure business logic for Copilot tools.
 * 
 * These functions contain the actual tool logic without any vscode dependencies,
 * making them directly testable. The tool classes in tools.ts are thin wrappers
 * that handle vscode integration (LanguageModelTool interface, result formatting).
 */

import { IWorkspaceIndexer, SymbolInfo } from '../service/IWorkspaceIndexer';
import {
    LookupSymbolInput,
    LookupSymbolOutput,
    GetTypeMembersInput,
    GetTypeMembersOutput,
    InferTypeInput,
    InferTypeOutput,
    GetModuleExportsInput,
    GetModuleExportsOutput,
    GetImportsInput,
    GetImportsOutput,
    ToolSymbolInfo,
    ToolErrorResponse,
    createErrorResponse
} from './types';

/**
 * Creates a unique key for a symbol based on its location and identity.
 * Used to deduplicate symbols that may appear multiple times due to
 * query patterns matching both template wrappers and inner declarations.
 */
function symbolLocationKey(symbol: SymbolInfo): string {
    const uri = symbol.uri;
    const uriString = (uri as any).fsPath ?? uri.toString();
    const line = (symbol.range as any).start?.line ?? 0;
    const col = (symbol.range as any).start?.character ?? 0;
    // Include qualifiedName to distinguish symbols at the same position
    // (this can happen in mocks, but in real code the position identifies the symbol)
    return `${uriString}:${line}:${col}:${symbol.qualifiedName}`;
}

/**
 * Deduplicates symbols by their location.
 * Keeps the first occurrence of each unique location.
 */
function deduplicateSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
    const seen = new Set<string>();
    return symbols.filter(sym => {
        const key = symbolLocationKey(sym);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/**
 * Converts a SymbolInfo to the AI-friendly ToolSymbolInfo format.
 */
export function symbolToToolInfo(symbol: SymbolInfo): ToolSymbolInfo {
    const uri = symbol.uri;
    const uriString = (uri as any).fsPath ?? uri.toString();
    const line = (symbol.range as any).start?.line ?? 0;
    
    return {
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.detail ?? 'unknown',
        category: symbol.category,
        signature: symbol.signature,
        documentation: symbol.docMarkdown,
        typeHint: symbol.typeHint,
        location: `${uriString}:${line + 1}`,
        scopePath: symbol.scopePath
    };
}

/**
 * Core logic for LookupSymbol tool.
 */
export function lookupSymbolLogic(
    indexer: IWorkspaceIndexer,
    input: LookupSymbolInput
): LookupSymbolOutput {
    const { symbolName, scopePath } = input;
    
    if (!symbolName || typeof symbolName !== 'string') {
        return createErrorResponse('symbolName is required and must be a string', 'INVALID_INPUT');
    }

    const resolution = indexer.resolveWithContext(symbolName, scopePath ?? [], {});
    let candidates: SymbolInfo[] = [];
    
    if (resolution.primary) {
        candidates.push(resolution.primary);
    }
    candidates.push(...resolution.alternatives);

    if (candidates.length === 0) {
        // Fall back to direct lookup without scope context
        const directMatches = indexer.getSymbols(symbolName);
        if (directMatches && directMatches.length > 0) {
            // Deduplicate in case indexer has duplicates
            const dedupedMatches = deduplicateSymbols(directMatches);
            const results = dedupedMatches.slice(0, 50).map(symbolToToolInfo);
            return { results, totalCount: dedupedMatches.length };
        }
        return createErrorResponse(`No symbols found matching "${symbolName}"`, 'SYMBOL_NOT_FOUND');
    }

    // Deduplicate candidates
    candidates = deduplicateSymbols(candidates);
    const results = candidates.slice(0, 50).map(symbolToToolInfo);
    return { results, totalCount: candidates.length };
}

/**
 * Core logic for GetTypeMembers tool.
 */
export async function getTypeMembersLogic(
    indexer: IWorkspaceIndexer,
    input: GetTypeMembersInput
): Promise<GetTypeMembersOutput> {
    const { typeName, includeMethods = true, includeFields = true, limit = 50 } = input;
    
    if (!typeName || typeof typeName !== 'string') {
        return createErrorResponse('typeName is required and must be a string', 'INVALID_INPUT');
    }

    const resolution = await indexer.resolveInstantiatedMembers(typeName, {
        includeMethods,
        includeFields,
        includeConstants: includeMethods && includeFields // only include if not filtering
    });

    if (resolution.members.length === 0) {
        return createErrorResponse(`No members found for type "${typeName}"`, 'SYMBOL_NOT_FOUND');
    }

    // Deduplicate members
    const dedupedMembers = deduplicateSymbols(resolution.members);
    const truncated = dedupedMembers.length > limit;
    const results = dedupedMembers.slice(0, limit).map(symbolToToolInfo);

    return {
        results,
        containerType: resolution.containerType,
        truncated
    };
}

/**
 * Core logic for InferType tool.
 */
export async function inferTypeLogic(
    indexer: IWorkspaceIndexer,
    input: InferTypeInput,
    getDocument: (filePath: string) => any | undefined
): Promise<InferTypeOutput> {
    const { filePath, line, character } = input;
    
    if (!filePath || typeof filePath !== 'string') {
        return createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT');
    }
    if (typeof line !== 'number' || typeof character !== 'number') {
        return createErrorResponse('line and character must be numbers', 'INVALID_INPUT');
    }

    const document = getDocument(filePath);
    if (!document) {
        return createErrorResponse(`File not found: ${filePath}`, 'FILE_NOT_FOUND');
    }

    const type = await indexer.inferTypeFromExpression(document, undefined, 0);
    
    if (!type) {
        return createErrorResponse(
            `Could not infer type at ${filePath}:${line}:${character}`,
            'SYMBOL_NOT_FOUND'
        );
    }

    return {
        type,
        location: `${filePath}:${line}:${character}`
    };
}

/**
 * Core logic for GetModuleExports tool.
 */
export function getModuleExportsLogic(
    indexer: IWorkspaceIndexer,
    input: GetModuleExportsInput,
    getUri: (filePath: string) => any
): GetModuleExportsOutput {
    const { filePath, limit = 50 } = input;
    
    if (!filePath || typeof filePath !== 'string') {
        return createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT');
    }

    const uri = getUri(filePath);
    const context = indexer.getDocumentContext(uri);
    
    if (!context) {
        return createErrorResponse(`File not indexed: ${filePath}`, 'FILE_NOT_FOUND');
    }

    const uriString = uri.toString();
    const allSymbols = indexer.getAllSymbols();
    const fileSymbols = allSymbols.filter(s => s.uri.toString() === uriString);

    // Export = top-level symbols or direct children of the module
    let exports = fileSymbols.filter(s => {
        if (s.scopePath.length === 0) return true;
        if (s.scopePath.length === 1 && s.scopePath[0] === context.modulePath) return true;
        return false;
    });

    // Deduplicate exports
    exports = deduplicateSymbols(exports);
    const truncated = exports.length > limit;
    const results = exports.slice(0, limit).map(symbolToToolInfo);

    return {
        results,
        modulePath: context.modulePath,
        truncated
    };
}

/**
 * Core logic for GetImports tool.
 */
export function getImportsLogic(
    indexer: IWorkspaceIndexer,
    input: GetImportsInput,
    getUri: (filePath: string) => any
): GetImportsOutput {
    const { filePath } = input;
    
    if (!filePath || typeof filePath !== 'string') {
        return createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT');
    }

    const uri = getUri(filePath);
    const context = indexer.getDocumentContext(uri);
    
    if (!context) {
        return createErrorResponse(`File not indexed: ${filePath}`, 'FILE_NOT_FOUND');
    }

    const resolved = indexer.getResolvedImports(uri);

    const imports = context.imports.map(imp => ({
        path: imp.path,
        alias: imp.alias,
        resolved: resolved.importedModules.has(imp.path)
    }));

    return {
        currentModule: resolved.currentModule,
        imports,
        importedModules: Array.from(resolved.importedModules)
    };
}

// ============================================================================
// Search Tools
// ============================================================================

/**
 * Input for symbol search.
 */
export interface SearchSymbolsInput {
    /** Search query (prefix match on symbol names) */
    query: string;
    /** Optional: filter by category ('class', 'function', 'struct', etc.) */
    category?: string;
    /** Optional: filter to symbols in a specific file */
    filePath?: string;
    /** Maximum results to return (default 50) */
    limit?: number;
}

/**
 * Output for symbol search.
 */
export interface SearchSymbolsOutput {
    results?: ToolSymbolInfo[];
    totalCount?: number;
    truncated?: boolean;
    error?: string;
    code?: string;
}

/**
 * Core logic for SearchSymbols tool.
 * Performs prefix-based fuzzy search across all indexed symbols.
 */
export function searchSymbolsLogic(
    indexer: IWorkspaceIndexer,
    input: SearchSymbolsInput,
    getUri?: (filePath: string) => any
): SearchSymbolsOutput {
    const { query, category, filePath, limit = 50 } = input;
    
    if (!query || typeof query !== 'string') {
        return createErrorResponse('query is required and must be a string', 'INVALID_INPUT');
    }
    
    if (query.length < 2) {
        return createErrorResponse('query must be at least 2 characters', 'INVALID_INPUT');
    }

    const queryLower = query.toLowerCase();
    let allSymbols = indexer.getAllSymbols();
    
    // Deduplicate symbols (safety net for any duplicates from indexing)
    allSymbols = deduplicateSymbols(allSymbols);
    
    // Filter by file if specified
    if (filePath && getUri) {
        const uri = getUri(filePath);
        const uriString = uri.toString();
        allSymbols = allSymbols.filter(s => s.uri.toString() === uriString);
    }
    
    // Filter by category if specified
    if (category) {
        allSymbols = allSymbols.filter(s => s.category === category);
    }
    
    // Prefix match on name (case-insensitive)
    const matches = allSymbols.filter(s => 
        s.name.toLowerCase().startsWith(queryLower) ||
        s.name.toLowerCase().includes(queryLower)
    );
    
    // Sort: exact prefix matches first, then contains matches
    matches.sort((a, b) => {
        const aStartsWith = a.name.toLowerCase().startsWith(queryLower);
        const bStartsWith = b.name.toLowerCase().startsWith(queryLower);
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;
        return a.name.localeCompare(b.name);
    });

    if (matches.length === 0) {
        return createErrorResponse(`No symbols found matching "${query}"`, 'SYMBOL_NOT_FOUND');
    }

    const truncated = matches.length > limit;
    const results = matches.slice(0, limit).map(symbolToToolInfo);

    return {
        results,
        totalCount: matches.length,
        truncated
    };
}

/**
 * Input for finding references/usages.
 */
export interface FindReferencesInput {
    /** The symbol name to find references to */
    symbolName: string;
    /** Optional: the qualified name for more precise matching */
    qualifiedName?: string;
    /** Maximum results to return (default 50) */
    limit?: number;
}

/**
 * Output for finding references.
 */
export interface FindReferencesOutput {
    /** The symbol being referenced */
    symbol?: ToolSymbolInfo;
    /** Locations where this symbol is referenced */
    references?: Array<{
        filePath: string;
        line: number;
        context?: string;
    }>;
    referenceCount?: number;
    error?: string;
    code?: string;
}

/**
 * Core logic for FindReferences tool.
 * Note: This is a simplified version - full reference tracking would require
 * more sophisticated analysis. This returns the symbol definition info.
 */
export function findReferencesLogic(
    indexer: IWorkspaceIndexer,
    input: FindReferencesInput
): FindReferencesOutput {
    const { symbolName, qualifiedName, limit = 50 } = input;
    
    if (!symbolName || typeof symbolName !== 'string') {
        return createErrorResponse('symbolName is required and must be a string', 'INVALID_INPUT');
    }

    // Try qualified lookup first
    let symbol: SymbolInfo | undefined;
    if (qualifiedName) {
        symbol = indexer.resolveQualified(qualifiedName);
    }
    
    if (!symbol) {
        const symbols = indexer.getSymbols(symbolName);
        symbol = symbols?.[0];
    }

    if (!symbol) {
        return createErrorResponse(`Symbol not found: ${symbolName}`, 'SYMBOL_NOT_FOUND');
    }

    // For now, return the symbol definition
    // Full reference tracking would require scanning all files for usages
    return {
        symbol: symbolToToolInfo(symbol),
        references: [],
        referenceCount: 0
    };
}
