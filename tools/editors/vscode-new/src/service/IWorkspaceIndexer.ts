/**
 * Interface for the WorkspaceIndexer, extracted for testability.
 * 
 * This interface defines the subset of WorkspaceIndexer methods used by
 * the Copilot tools, enabling mock implementations for unit testing.
 */

import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { ResolutionResult } from '../utils/symbolUtils';
import { ResolvedImports } from '../utils/importUtils';
import { MemberResolutionOptions, MemberResolutionResult } from '../utils/memberUtils';
import { TemplateInstantiation } from '../utils/templateUtils';

/**
 * Symbol category types supported by the indexer.
 */
export type SymbolCategory =
    | 'module'
    | 'class'
    | 'struct'
    | 'union'
    | 'enum'
    | 'function'
    | 'method'
    | 'variable'
    | 'member'
    | 'constant'
    | 'alias'
    | 'other';

/**
 * Context hint for symbol resolution, indicating whether the reference
 * is in a method call context or a free reference.
 */
export type SymbolContextHint =
    | { kind: 'method'; receiverType?: string }
    | { kind: 'free' }
    | { kind: 'unknown' };

/**
 * Options for symbol resolution.
 */
export interface ResolveOptions {
    /** URI of the document making the query (for accessibility filtering) */
    uri?: vscode.Uri;
    /** Context hint for the reference */
    context?: SymbolContextHint;
    /** Maximum number of results to return */
    limit?: number;
}

/**
 * Information about an indexed symbol.
 */
export interface SymbolInfo {
    /** Simple name (e.g., "push") */
    name: string;
    /** Fully qualified name (e.g., "data.fifo::FIFO::push") */
    qualifiedName: string;
    /** URI of the file containing this symbol */
    uri: vscode.Uri;
    /** Range of the symbol's name in the document */
    range: vscode.Range;
    /** VS Code symbol kind */
    kind: vscode.SymbolKind;
    /** Short description (e.g., "class", "function") */
    detail?: string;
    /** Documentation extracted from doc comments */
    docMarkdown?: string;
    /** Full signature (e.g., "void push(T value)") */
    signature?: string;
    /** Enclosing scope path (e.g., ["data.fifo", "FIFO"]) */
    scopePath: string[];
    /** Category for filtering */
    category: SymbolCategory;
    /** Inferred or declared type */
    typeHint?: string;
}

/**
 * Import declaration from a document.
 */
export interface DocumentImport {
    /** Import path (e.g., "data.fifo") */
    path: string;
    /** Optional alias (e.g., "fifo") */
    alias?: string;
}

/**
 * Context information for a document.
 */
export interface DocumentContext {
    /** Module path declared in this document */
    modulePath?: string;
    /** Imports declared in this document */
    imports: DocumentImport[];
}

/**
 * Interface for workspace indexing operations.
 * 
 * This interface abstracts the WorkspaceIndexer for dependency injection
 * and testing. Implementations provide symbol lookup, type inference,
 * member resolution, and import resolution capabilities.
 */
export interface IWorkspaceIndexer {
    // === Symbol Lookup ===
    
    /**
     * Gets all symbols with the given name.
     * @param name Symbol name to look up
     * @returns Array of matching symbols, or undefined if none found
     */
    getSymbols(name: string): SymbolInfo[] | undefined;
    
    /**
     * Gets all indexed symbols.
     * @returns Array of all symbols in the index
     */
    getAllSymbols(): SymbolInfo[];
    
    /**
     * Resolves a symbol by its fully qualified name.
     * @param qualifiedName Full qualified name (e.g., "data.fifo::FIFO::push")
     * @returns The symbol if found, undefined otherwise
     */
    resolveQualified(qualifiedName: string): SymbolInfo | undefined;
    
    /**
     * Resolves a symbol with full context awareness and confidence scoring.
     * @param name Symbol name to resolve
     * @param scopePath Current scope path for context
     * @param options Resolution options
     * @returns Resolution result with primary match, alternatives, and confidence
     */
    resolveWithContext(
        name: string,
        scopePath: string[],
        options?: ResolveOptions
    ): ResolutionResult<SymbolInfo>;
    
    /**
     * Gets a single symbol by name and scope path.
     * @param name Symbol name
     * @param scopePath Scope path for disambiguation
     * @param options Resolution options
     * @returns Best matching symbol or undefined
     */
    getSymbol(
        name: string,
        scopePath: string[],
        options?: ResolveOptions
    ): SymbolInfo | undefined;
    
    // === Type Inference ===
    
    /**
     * Infers the type of an expression at a given AST node.
     * @param document The document containing the expression
     * @param expression The AST node to infer type for
     * @param depth Current recursion depth (for internal use)
     * @returns Inferred type string, or undefined if inference fails
     */
    inferTypeFromExpression(
        document: vscode.TextDocument,
        expression?: Parser.SyntaxNode,
        depth?: number
    ): Promise<string | undefined>;
    
    // === Member Resolution ===
    
    /**
     * Gets all members of a type.
     * @param typeName Type name (may include template arguments)
     * @param options Filter options for methods/fields
     * @returns Array of member symbols
     */
    getMembersForType(
        typeName: string,
        options?: { includeMethods?: boolean; includeFields?: boolean }
    ): SymbolInfo[];
    
    /**
     * Resolves members with enhanced precision using qualified names.
     * @param typeName Type name to resolve members for
     * @param options Member resolution options
     * @returns Resolution result with members and container info
     */
    resolveMembersForType(
        typeName: string,
        options?: MemberResolutionOptions
    ): MemberResolutionResult;
    
    /**
     * Resolves members for a templated type with instantiated signatures.
     * @param typeName Type name (may include template arguments)
     * @param options Member resolution options
     * @returns Resolution result with instantiated signatures
     */
    resolveInstantiatedMembers(
        typeName: string,
        options?: MemberResolutionOptions
    ): Promise<MemberResolutionResult & { instantiation?: TemplateInstantiation }>;
    
    /**
     * Gets a specific member from a type by name.
     * @param typeName Type name
     * @param memberName Member name to find
     * @param options Options for disambiguation
     * @returns Best matching member or undefined
     */
    getMemberByName(
        typeName: string,
        memberName: string,
        options?: { preferMethod?: boolean }
    ): SymbolInfo | undefined;
    
    // === Document Context ===
    
    /**
     * Gets the document context (module path, imports) for a URI.
     * @param uri Document URI
     * @returns Document context or undefined if not indexed
     */
    getDocumentContext(uri: vscode.Uri): DocumentContext | undefined;
    
    /**
     * Gets resolved imports for a document.
     * @param uri Document URI
     * @returns Resolved imports with accessibility information
     */
    getResolvedImports(uri: vscode.Uri): ResolvedImports;
    
    /**
     * Gets all indexed file URIs.
     * @returns Array of URIs for all indexed files
     */
    getIndexedUris(): vscode.Uri[];
    
    // === Index Statistics ===
    
    /**
     * Gets statistics about the index.
     * @returns Object with totalSymbols, uniqueFiles, etc.
     */
    getStats(): {
        totalSymbols: number;
        uniqueFiles: number;
        recentlyIndexed: number;
        verbose: boolean;
    };
}

/**
 * Serialized symbol info for tool output.
 * This is a JSON-safe version of SymbolInfo for Copilot consumption.
 */
export interface SerializedSymbolInfo {
    name: string;
    qualifiedName: string;
    kind: string;
    category: SymbolCategory;
    signature?: string;
    documentation?: string;
    typeHint?: string;
    location: string;
    scopePath: string[];
}

/**
 * Converts a SymbolInfo to a serializable format.
 */
export function serializeSymbolInfo(symbol: SymbolInfo): SerializedSymbolInfo {
    return {
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.detail ?? vscode.SymbolKind[symbol.kind],
        category: symbol.category,
        signature: symbol.signature,
        documentation: symbol.docMarkdown,
        typeHint: symbol.typeHint,
        location: `${symbol.uri.fsPath}:${symbol.range.start.line + 1}`,
        scopePath: symbol.scopePath
    };
}
