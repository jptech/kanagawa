/**
 * Copilot Tool Types
 *
 * Shared types, interfaces, and utilities for the Language Model Tools.
 *
 * Note: This module is intentionally runtime-agnostic (no `vscode` import) so
 * it can be used by unit tests that run under Node.
 */

// ============================================================================
// Tool Result Types
// ============================================================================

/**
 * Standard success response wrapper.
 */
export interface ToolSuccessResponse<T> {
    results: T[];
    truncated?: boolean;
    totalCount?: number;
}

/**
 * Standard error response wrapper.
 */
export interface ToolErrorResponse {
    error: string;
    code: ToolErrorCode;
}

/**
 * Error codes for tool responses.
 */
export type ToolErrorCode =
    | 'SYMBOL_NOT_FOUND'
    | 'FILE_NOT_FOUND'
    | 'INDEX_NOT_READY'
    | 'PARSE_ERROR'
    | 'INVALID_POSITION'
    | 'INVALID_INPUT'
    | 'CANCELLED'
    | 'INTERNAL_ERROR';

/**
 * Union type for tool responses.
 */
export type ToolResponse<T> = ToolSuccessResponse<T> | ToolErrorResponse;

// ============================================================================
// Tool Input Types
// ============================================================================

/**
 * Input for kanagawa_lookup_symbol tool.
 */
export interface LookupSymbolInput {
    /** Symbol name to look up (e.g., "FIFO", "push") */
    symbolName: string;
    /** Optional scope path for disambiguation */
    scopePath?: string[];
}

/**
 * Input for kanagawa_get_type_members tool.
 */
export interface GetTypeMembersInput {
    /** Type name, may include template arguments (e.g., "FIFO<uint32, 16>") */
    typeName: string;
    /** Include methods in results (default: true) */
    includeMethods?: boolean;
    /** Include fields in results (default: true) */
    includeFields?: boolean;
    /** Maximum number of results (default: 50) */
    limit?: number;
}

/**
 * Input for kanagawa_infer_type tool.
 */
export interface InferTypeInput {
    /** Absolute file path */
    filePath: string;
    /** Line number (1-indexed for user convenience) */
    line: number;
    /** Character position (1-indexed for user convenience) */
    character: number;
}

/**
 * Input for kanagawa_get_module_exports tool.
 */
export interface GetModuleExportsInput {
    /** Absolute file path */
    filePath: string;
    /** Maximum number of results (default: 50) */
    limit?: number;
}

/**
 * Input for kanagawa_get_imports tool.
 */
export interface GetImportsInput {
    /** Absolute file path */
    filePath: string;
}

// ============================================================================
// Tool Output Types
// ============================================================================

/**
 * 1-indexed position for tool outputs (more ergonomic for humans + models).
 */
export interface ToolPosition {
    line: number;
    character: number;
}

export interface ToolRange {
    start: ToolPosition;
    end: ToolPosition;
}

/**
 * Token-efficient range encoding for high-volume list outputs.
 * Format: [startLine, startCharacter, endLine, endCharacter] (all 1-indexed).
 */
export type ToolRangeTuple = [number, number, number, number];

/**
 * File location for tool outputs.
 *
 * `path` should prefer workspace-relative paths when possible. For external
 * sources (stdlib outside workspace, vendor dirs not in workspace, etc.),
 * fall back to an absolute path.
 */
export interface ToolLocation {
    /** Stable URI string (e.g., file:///..., untitled:..., etc.) */
    uri: string;
    /** Human-friendly path (workspace-relative if possible; absolute fallback) */
    path: string;
    /** Optional range of the symbol/selection */
    range?: ToolRange;
}

/**
 * Serialized symbol for tool output.
 */
export interface ToolSymbolInfo {
    name: string;
    qualifiedName: string;
    kind: string;
    category: string;
    signature?: string;
    documentation?: string;
    typeHint?: string;
    location: ToolLocation;
    scopePath: string[];
}

/**
 * Output for kanagawa_lookup_symbol tool.
 */
export type LookupSymbolOutput = {
    results: ToolSymbolInfo[];
    totalCount?: number;
} | ToolErrorResponse;

/**
 * Output for kanagawa_get_type_members tool.
 */
export type GetTypeMembersOutput = {
    results: ToolSymbolInfo[];
    containerType: string;
    containerQualified?: string;
    truncated: boolean;
} | ToolErrorResponse;

/**
 * Output for kanagawa_infer_type tool.
 */
export type InferTypeOutput = {
    type: string;
    location: {
        file: ToolLocation;
        position: ToolPosition;
    };
} | ToolErrorResponse;

/**
 * Output for kanagawa_get_module_exports tool.
 */
export type GetModuleExportsOutput = {
    results: ToolSymbolInfo[];
    modulePath?: string;
    truncated: boolean;
} | ToolErrorResponse;

/**
 * Import info for tool output.
 */
export interface ToolImportInfo {
    path: string;
    alias?: string;
    resolved: boolean;
}

/**
 * Output for kanagawa_get_imports tool.
 */
export type GetImportsOutput = {
    currentModule?: string;
    imports: ToolImportInfo[];
    importedModules: string[];
} | ToolErrorResponse;

// ============================================================================
// Search / Discovery Tools
// ============================================================================

/** Input for kanagawa_search_symbols tool. */
export interface SearchSymbolsInput {
    query: string;
    category?: string;
    filePath?: string;
    maxFiles?: number;
    maxMatchesPerFile?: number;
    limit?: number;
}

export interface ToolSymbolMatch {
    name: string;
    qualifiedName: string;
    category: string;
    range?: ToolRangeTuple;
}

export interface ToolSearchFileMatches {
    file: ToolLocation;
    matches: ToolSymbolMatch[];
}

/** Output for kanagawa_search_symbols tool (token-efficient, grouped by file). */
export type SearchSymbolsOutput = {
    query: string;
    totalCount: number;
    truncated: boolean;
    files: ToolSearchFileMatches[];
} | ToolErrorResponse;

export interface ListModulesInput {
    prefix?: string;
    limit?: number;
}

export interface ToolModuleInfo {
    modulePath: string;
    declaringFile?: ToolLocation;
    exportCount?: number;
}

export type ListModulesOutput = {
    results: ToolModuleInfo[];
    totalCount: number;
    truncated: boolean;
} | ToolErrorResponse;

export interface GetModuleApiInput {
    modulePath: string;
    includeTransitive?: boolean;
    limit?: number;
}

export type GetModuleApiOutput = {
    modulePath: string;
    exports: ToolSymbolInfo[];
    totalCount: number;
    truncated: boolean;
} | ToolErrorResponse;

// ============================================================================
// Symbol details and document symbol listing (token-efficient)
// ============================================================================

export interface GetSymbolDetailsInput {
    qualifiedName: string;
}

export type GetSymbolDetailsOutput = {
    symbol: ToolSymbolInfo;
} | ToolErrorResponse;

export interface GetDocumentSymbolsInput {
    filePath: string;
    scope?: 'topLevel' | 'all';
    includeScopePath?: boolean;
    limit?: number;
}

export interface ToolDocumentSymbol {
    name: string;
    qualifiedName: string;
    category: string;
    range?: ToolRangeTuple;
    scopePath?: string[];
}

// NOTE: A hierarchical outline tool was intentionally removed because it tended
// to be higher-token than simply opening the file.
export type GetDocumentSymbolsOutput = {
    file: ToolLocation;
    modulePath?: string;
    symbols: ToolDocumentSymbol[];
    truncated: boolean;
} | ToolErrorResponse;

// ============================================================================
// Navigation Tools (position-based)
// ============================================================================

export interface ResolveSymbolAtPositionInput {
    filePath: string;
    line: number;
    character: number;
    includeInaccessible?: boolean;
    maxAlternatives?: number;
}

export type ResolveSymbolAtPositionOutput = {
    primary?: ToolSymbolInfo;
    confidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
    alternatives: ToolSymbolInfo[];
    inaccessible: ToolSymbolInfo[];
} | ToolErrorResponse;

export interface GetDefinitionLocationsInput {
    filePath: string;
    line: number;
    character: number;
    maxLocations?: number;
}

export type GetDefinitionLocationsOutput = {
    definitions: ToolLocation[];
    truncated: boolean;
} | ToolErrorResponse;

export interface FindReferencesAtPositionInput {
    filePath: string;
    line: number;
    character: number;
    includeDeclaration?: boolean;
    limit?: number;
}

export type FindReferencesAtPositionOutput = {
    references: ToolLocation[];
    totalCount: number;
    truncated: boolean;
} | ToolErrorResponse;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Type guard for error responses.
 */
export function isErrorResponse<T>(response: ToolResponse<T>): response is ToolErrorResponse {
    return 'error' in response;
}

/**
 * Creates a success response.
 */
export function createSuccessResponse<T>(
    results: T[],
    options?: { truncated?: boolean; totalCount?: number }
): ToolSuccessResponse<T> {
    return {
        results,
        truncated: options?.truncated,
        totalCount: options?.totalCount
    };
}

/**
 * Creates an error response.
 */
export function createErrorResponse(
    message: string,
    code: ToolErrorCode
): ToolErrorResponse {
    return {
        error: message,
        code
    };
}
