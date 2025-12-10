/**
 * Copilot Tool Types
 * 
 * Shared types, interfaces, and utilities for the Language Model Tools.
 * This file is kept vscode-free to allow pure logic testing.
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
 * Standard error response.
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
    | 'PARSE_ERROR'
    | 'INVALID_POSITION'
    | 'INVALID_INPUT'
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
    location: string;
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
    location: string;
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
