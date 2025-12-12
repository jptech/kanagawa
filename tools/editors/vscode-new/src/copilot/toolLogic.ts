/**
 * Pure business logic for Copilot tools.
 * 
 * These functions contain the actual tool logic without any vscode dependencies,
 * making them directly testable. The tool classes in tools.ts are thin wrappers
 * that handle vscode integration (LanguageModelTool interface, result formatting).
 */

import { IWorkspaceIndexer, SymbolInfo } from '../service/IWorkspaceIndexer';
import { matchesImportPath } from '../utils/importUtils';
import {
    LookupSymbolInput,
    LookupSymbolOutput,
    GetTypeMembersInput,
    GetTypeMembersOutput,
    GetModuleExportsInput,
    GetModuleExportsOutput,
    GetImportsInput,
    GetImportsOutput,
    ToolSymbolInfo,
    ToolLocation,
    ToolRange,
    ToolRangeTuple,
    ToolPosition,
    ToolErrorResponse,
    createErrorResponse,
    SearchSymbolsInput,
    SearchSymbolsOutput,
    ToolSymbolMatch,
    ToolSearchFileMatches,
    ListModulesInput,
    ListModulesOutput,
    ToolModuleInfo,
    GetModuleApiInput,
    GetModuleApiOutput,
    GetSymbolDetailsInput,
    GetSymbolDetailsOutput,
    GetDocumentSymbolsInput,
    GetDocumentSymbolsOutput,
    ToolDocumentSymbol
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

function toToolPosition(pos: any): ToolPosition {
    const line = typeof pos?.line === 'number' ? pos.line : 0;
    const character = typeof pos?.character === 'number' ? pos.character : 0;
    return { line: line + 1, character: character + 1 };
}

function toToolRange(range: any): ToolRange | undefined {
    const start = range?.start;
    const end = range?.end;
    if (!start || !end) {
        return undefined;
    }
    return {
        start: toToolPosition(start),
        end: toToolPosition(end)
    };
}

function toToolRangeTuple(range: any): ToolRangeTuple | undefined {
    const start = range?.start;
    const end = range?.end;
    if (!start || !end) {
        return undefined;
    }

    const sl = typeof start?.line === 'number' ? start.line + 1 : 1;
    const sc = typeof start?.character === 'number' ? start.character + 1 : 1;
    const el = typeof end?.line === 'number' ? end.line + 1 : sl;
    const ec = typeof end?.character === 'number' ? end.character + 1 : sc;

    return [sl, sc, el, ec];
}

function toToolLocation(uriLike: any, rangeLike?: any): ToolLocation {
    const uriString = uriLike?.toString ? uriLike.toString() : String(uriLike);
    const fsPath = (uriLike as any)?.fsPath;
    return {
        uri: uriString,
        // NOTE: tools.ts will rewrite this to workspace-relative when possible.
        // For unit tests and non-workspace contexts, keeping fsPath is fine.
        path: typeof fsPath === 'string' ? fsPath : uriString,
        range: toToolRange(rangeLike)
    };
}

/**
 * Converts a SymbolInfo to the AI-friendly ToolSymbolInfo format.
 */
export function symbolToToolInfo(symbol: SymbolInfo): ToolSymbolInfo {
    return {
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.detail ?? 'unknown',
        category: symbol.category,
        signature: symbol.signature,
        documentation: symbol.docMarkdown,
        typeHint: symbol.typeHint,
        location: toToolLocation(symbol.uri, symbol.range),
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

    const imports = context.imports.map(imp => {
        const resolvedViaAnyMatch = Array.from(resolved.importedModules).some(m => matchesImportPath(m, imp.path));
        return {
            path: imp.path,
            alias: imp.alias,
            resolved: resolvedViaAnyMatch
        };
    });

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
 * Core logic for SearchSymbols tool.
 * Performs prefix-based fuzzy search across all indexed symbols.
 */
export function searchSymbolsLogic(
    indexer: IWorkspaceIndexer,
    input: SearchSymbolsInput,
    getUri?: (filePath: string) => any
): SearchSymbolsOutput {
    const {
        query,
        category,
        filePath,
        maxFiles = 20,
        maxMatchesPerFile = 10,
        limit = 200
    } = input;
    
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
    
    // Prefix/substring match on name (case-insensitive)
    const matches = allSymbols.filter(s => {
        const nameLower = s.name.toLowerCase();
        return nameLower.startsWith(queryLower) || nameLower.includes(queryLower);
    });

    // Deterministic ordering: startsWith first, then name, then qualifiedName.
    matches.sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aStartsWith = aName.startsWith(queryLower);
        const bStartsWith = bName.startsWith(queryLower);
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;
        const nameCmp = a.name.localeCompare(b.name);
        if (nameCmp !== 0) return nameCmp;
        return a.qualifiedName.localeCompare(b.qualifiedName);
    });

    if (matches.length === 0) {
        return createErrorResponse(`No symbols found matching "${query}"`, 'SYMBOL_NOT_FOUND');
    }

    const totalCount = matches.length;
    const fileGroups = new Map<string, { uri: any; matches: SymbolInfo[] }>();
    let emitted = 0;
    let truncated = false;

    for (const sym of matches) {
        if (emitted >= limit) {
            truncated = true;
            break;
        }

        const uriString = sym.uri.toString();
        let group = fileGroups.get(uriString);
        if (!group) {
            if (fileGroups.size >= maxFiles) {
                truncated = true;
                continue;
            }
            group = { uri: sym.uri, matches: [] };
            fileGroups.set(uriString, group);
        }

        if (group.matches.length >= maxMatchesPerFile) {
            truncated = true;
            continue;
        }

        group.matches.push(sym);
        emitted++;
    }

    const files: ToolSearchFileMatches[] = [];
    for (const group of fileGroups.values()) {
        const fileLoc: ToolLocation = toToolLocation(group.uri);
        const fileMatches: ToolSymbolMatch[] = group.matches.map(s => ({
            name: s.name,
            qualifiedName: s.qualifiedName,
            category: s.category,
            range: toToolRangeTuple(s.range)
        }));
        files.push({ file: fileLoc, matches: fileMatches });
    }

    if (emitted < totalCount) {
        truncated = true;
    }

    return {
        query,
        totalCount,
        truncated,
        files
    };
}

// ============================================================================
// Symbol Details
// ============================================================================

export function getSymbolDetailsLogic(
    indexer: IWorkspaceIndexer,
    input: GetSymbolDetailsInput
): GetSymbolDetailsOutput {
    const { qualifiedName } = input;
    if (!qualifiedName || typeof qualifiedName !== 'string') {
        return createErrorResponse('qualifiedName is required and must be a string', 'INVALID_INPUT');
    }

    const sym = indexer.resolveQualified(qualifiedName);
    if (!sym) {
        return createErrorResponse(`No symbol found for qualifiedName "${qualifiedName}"`, 'SYMBOL_NOT_FOUND');
    }

    return { symbol: symbolToToolInfo(sym) };
}

// ============================================================================
// Module / Outline Discovery
// ============================================================================

export function listModulesLogic(
    indexer: IWorkspaceIndexer,
    input: ListModulesInput
): ListModulesOutput {
    const { prefix, limit = 200 } = input;

    let modulePaths = new Map<string, ToolModuleInfo>();
    for (const uri of indexer.getIndexedUris()) {
        const ctx = indexer.getDocumentContext(uri);
        if (!ctx?.modulePath) continue;
        if (prefix && !ctx.modulePath.startsWith(prefix)) continue;

        if (!modulePaths.has(ctx.modulePath)) {
            modulePaths.set(ctx.modulePath, {
                modulePath: ctx.modulePath,
                declaringFile: toToolLocation(uri)
            });
        }
    }

    const all = Array.from(modulePaths.values());
    all.sort((a, b) => a.modulePath.localeCompare(b.modulePath));

    const truncated = all.length > limit;
    return {
        results: all.slice(0, limit),
        totalCount: all.length,
        truncated
    };
}

export function getModuleApiLogic(
    indexer: IWorkspaceIndexer,
    input: GetModuleApiInput,
    options?: { includeTransitiveDefault?: boolean }
): GetModuleApiOutput {
    const { modulePath, includeTransitive = options?.includeTransitiveDefault ?? true, limit = 200 } = input;

    if (!modulePath || typeof modulePath !== 'string') {
        return createErrorResponse('modulePath is required and must be a string', 'INVALID_INPUT');
    }

    const exportedQualifiedNames = indexer.getModuleExportedQualifiedNames(modulePath, { includeTransitive });
    const exportedSymbols: SymbolInfo[] = [];
    for (const qualifiedName of exportedQualifiedNames) {
        const sym = indexer.resolveQualified(qualifiedName);
        if (sym) {
            exportedSymbols.push(sym);
        }
    }

    // Deterministic ordering for tool output.
    const candidates = deduplicateSymbols(exportedSymbols);
    candidates.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

    const truncated = candidates.length > limit;
    return {
        modulePath,
        exports: candidates.slice(0, limit).map(symbolToToolInfo),
        totalCount: candidates.length,
        truncated
    };
}

export function getDocumentSymbolsLogic(
    indexer: IWorkspaceIndexer,
    input: GetDocumentSymbolsInput,
    getUri: (filePath: string) => any
): GetDocumentSymbolsOutput {
    const { filePath, scope = 'topLevel', includeScopePath = false, limit = 200 } = input;

    if (!filePath || typeof filePath !== 'string') {
        return createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT');
    }

    const uri = getUri(filePath);
    const ctx = indexer.getDocumentContext(uri);
    if (!ctx) {
        return createErrorResponse(`File not indexed: ${filePath}`, 'FILE_NOT_FOUND');
    }

    const uriString = uri.toString();
    let symbols = deduplicateSymbols(indexer.getAllSymbols()).filter(s => s.uri.toString() === uriString);

    if (scope === 'topLevel') {
        const modulePath = ctx.modulePath;
        symbols = symbols.filter(s => {
            if ((s.scopePath?.length ?? 0) === 0) return true;
            if (modulePath && s.scopePath.length === 1 && s.scopePath[0] === modulePath) return true;
            return false;
        });
    }

    symbols.sort((a, b) => {
        const al = (a.range as any)?.start?.line ?? 0;
        const bl = (b.range as any)?.start?.line ?? 0;
        if (al !== bl) return al - bl;
        const ac = (a.range as any)?.start?.character ?? 0;
        const bc = (b.range as any)?.start?.character ?? 0;
        if (ac !== bc) return ac - bc;
        return a.qualifiedName.localeCompare(b.qualifiedName);
    });

    const all: ToolDocumentSymbol[] = symbols.map(s => {
        const base: ToolDocumentSymbol = {
            name: s.name,
            qualifiedName: s.qualifiedName,
            category: s.category,
            range: toToolRangeTuple(s.range)
        };
        if (includeScopePath) {
            base.scopePath = s.scopePath;
        }
        return base;
    });

    const truncated = all.length > limit;
    return {
        file: toToolLocation(uri),
        modulePath: ctx.modulePath,
        symbols: all.slice(0, limit),
        truncated
    };
}
