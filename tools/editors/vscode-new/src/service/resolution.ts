/**
 * SymbolResolutionService - Centralized symbol resolution with context awareness.
 * 
 * This service provides a single point of entry for all symbol resolution needs,
 * reducing code duplication across providers (hover, definition, references, rename).
 * 
 * Key features:
 * - Context-aware resolution (method vs free function, type vs value)
 * - Confidence scoring for ambiguous matches
 * - Import/accessibility checking
 * - Member resolution for receiver.method patterns
 * - Local variable priority over global symbols
 */

import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from './indexer';
import { extractModuleFromQualified } from '../utils/importUtils';
import { isModuleOrImportNode } from '../utils/nodeUtils';

/**
 * Resolution confidence levels, from most to least certain.
 */
export type ResolutionConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

/**
 * Result of symbol resolution with confidence scoring.
 */
export interface ResolutionResult {
    /** The most likely symbol match */
    primary: SymbolInfo | undefined;
    /** How confident we are in the primary match */
    confidence: ResolutionConfidence;
    /** Additional possible matches beyond primary */
    alternatives: SymbolInfo[];
    /** Symbols that would require an import to access */
    inaccessible: SymbolInfo[];
}

/**
 * Options for controlling resolution behavior.
 */
export interface ResolutionOptions {
    /** Include inaccessible symbols in results (for "did you mean to import" hints) */
    includeInaccessible?: boolean;
    /** Maximum number of alternatives to return */
    maxAlternatives?: number;
    /** Skip local variable resolution (for type-only lookups) */
    skipLocals?: boolean;
    /** Context hint for prioritizing method vs function matches */
    contextHint?: SymbolContextHint;
}

/**
 * Position-based resolution request.
 */
export interface PositionResolutionRequest {
    document: vscode.TextDocument;
    position: vscode.Position;
    tree: Parser.Tree;
    identifier: Parser.SyntaxNode;
}

/**
 * Centralized symbol resolution service.
 * Replaces duplicated resolution logic in hover, definition, references, and rename providers.
 */
export class SymbolResolutionService {
    constructor(private readonly indexer: WorkspaceIndexer) {}

    /**
     * Main entry point for resolving a symbol at a position.
     * Handles all resolution scenarios: local variables, members, qualified names, etc.
     * 
     * @param request The resolution request with document, position, and identifier
     * @param options Optional resolution options
     * @returns Resolution result with primary match, confidence, and alternatives
     */
    async resolveAtPosition(
        request: PositionResolutionRequest,
        options: ResolutionOptions = {}
    ): Promise<ResolutionResult> {
        const { document, identifier } = request;
        const name = identifier.text;
        
        // OPTIMIZATION: Skip expensive resolution for identifiers inside import/module statements.
        // Import paths are module references, not symbol lookups. Trying to resolve them
        // as symbols wastes time and can cause hangs on malformed import expressions.
        // Return early with a 'none' result to signal "no symbol to resolve here".
        if (isModuleOrImportNode(identifier)) {
            return {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
        }
        
        const scopePath = this.indexer.getScopePathForNode(identifier);

        const accessible: SymbolInfo[] = [];
        const inaccessible: SymbolInfo[] = [];
        const seen = new Set<string>();

        const addSymbol = (sym: SymbolInfo, isAccessible: boolean) => {
            const key = this.symbolKey(sym);
            if (seen.has(key)) return;
            seen.add(key);
            if (isAccessible) {
                accessible.push(sym);
            } else if (options.includeInaccessible) {
                inaccessible.push(sym);
            }
        };

        // Priority 1: Local symbol (variable/parameter in scope)
        if (!options.skipLocals) {
            const localSymbol = this.indexer.findNearestLocalSymbol(document, identifier);
            if (localSymbol) {
                // Local is definitive - return immediately with exact confidence
                return {
                    primary: localSymbol,
                    confidence: 'exact',
                    alternatives: [],
                    inaccessible: []
                };
            }
        }

        // Priority 2: Member resolution (for receiver.member patterns)
        const contextHint = options.contextHint ?? await this.buildContextHint(document, identifier);
        
        if (contextHint.kind === 'method') {
            const memberMatches = await this.indexer.resolveMemberSymbol(document, identifier);
            if (memberMatches && memberMatches.length > 0) {
                for (const sym of memberMatches) {
                    addSymbol(sym, true);
                }
                // Member resolution is typically precise
                if (accessible.length > 0) {
                    return this.computeResult(accessible, inaccessible, options);
                }
            }
            // CRITICAL FIX: For member expressions, do NOT fall through to scope-based resolution.
            // If member resolution failed (receiver type couldn't be inferred, or member not found),
            // returning 'none' confidence is correct - we should NOT resolve to a symbol in the
            // enclosing scope that happens to have the same name (e.g., UnsafeSemaphore::count()
            // when we wanted counter::count() on `_counter.count()`).
            // 
            // This prevents the bug where hovering on `_counter.count()` shows UnsafeSemaphore::count()
            // instead of correctly showing "could not resolve" or counter::count().
            return this.computeResult(accessible, inaccessible, options);
        }

        // Priority 3: Context-aware resolution (only for non-member expressions)
        const resolvedImports = this.indexer.getResolvedImports(document.uri);
        const resolution = this.indexer.resolveWithContext(name, scopePath, {
            uri: document.uri,
            context: contextHint
        });

        if (resolution.primary) {
            const isAccessible = this.isSymbolAccessible(resolution.primary, resolvedImports);
            addSymbol(resolution.primary, isAccessible);
        }

        for (const alt of resolution.alternatives) {
            const isAccessible = this.isSymbolAccessible(alt, resolvedImports);
            addSymbol(alt, isAccessible);
        }

        // Priority 4: Document-local symbols (fallback)
        if (accessible.length === 0 && inaccessible.length === 0) {
            const locals = await this.indexer.findSymbolsInDocument(document, name);
            for (const sym of locals) {
                addSymbol(sym, true);
            }
        }

        return this.computeResult(accessible, inaccessible, options);
    }

    /**
     * Resolves a symbol by name without position context.
     * Useful for programmatic lookups where you have the symbol name.
     * 
     * @param name The symbol name to resolve
     * @param documentUri The document URI for import context
     * @param scopePath Optional scope path for qualified lookup
     * @param options Resolution options
     */
    async resolveByName(
        name: string,
        documentUri: vscode.Uri,
        scopePath: string[] = [],
        options: ResolutionOptions = {}
    ): Promise<ResolutionResult> {
        const accessible: SymbolInfo[] = [];
        const inaccessible: SymbolInfo[] = [];
        const seen = new Set<string>();

        const addSymbol = (sym: SymbolInfo, isAccessible: boolean) => {
            const key = this.symbolKey(sym);
            if (seen.has(key)) return;
            seen.add(key);
            if (isAccessible) {
                accessible.push(sym);
            } else if (options.includeInaccessible) {
                inaccessible.push(sym);
            }
        };

        const resolvedImports = this.indexer.getResolvedImports(documentUri);
        const resolution = this.indexer.resolveWithContext(name, scopePath, {
            uri: documentUri,
            context: options.contextHint ?? { kind: 'free' }
        });

        if (resolution.primary) {
            const isAccessible = this.isSymbolAccessible(resolution.primary, resolvedImports);
            addSymbol(resolution.primary, isAccessible);
        }

        for (const alt of resolution.alternatives) {
            const isAccessible = this.isSymbolAccessible(alt, resolvedImports);
            addSymbol(alt, isAccessible);
        }

        return this.computeResult(accessible, inaccessible, options);
    }

    /**
     * Resolves member symbols for a receiver type (e.g., receiver.method).
     * 
     * @param document The document context
     * @param memberNode The member identifier node
     * @param receiverType Optional explicit receiver type (inferred if not provided)
     */
    async resolveMember(
        document: vscode.TextDocument,
        memberNode: Parser.SyntaxNode,
        receiverType?: string
    ): Promise<ResolutionResult> {
        const memberMatches = await this.indexer.resolveMemberSymbol(document, memberNode);
        
        if (!memberMatches || memberMatches.length === 0) {
            return {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
        }

        // Filter by receiver type if provided
        const filtered = receiverType
            ? memberMatches.filter(sym => {
                const container = extractModuleFromQualified(sym.qualifiedName);
                return container === receiverType || 
                       sym.qualifiedName.includes(receiverType);
            })
            : memberMatches;

        const toUse = filtered.length > 0 ? filtered : memberMatches;
        return this.computeResult(toUse, [], {});
    }

    /**
     * Builds a context hint based on identifier usage pattern.
     * Determines if the identifier is used as a method call, type, or free identifier.
     * 
     * Optimized to limit parent traversal depth and avoid expensive type inference
     * when not strictly necessary.
     */
    async buildContextHint(
        document: vscode.TextDocument,
        identifier: Parser.SyntaxNode
    ): Promise<SymbolContextHint> {
        // Limit traversal depth to avoid expensive walks up large trees
        const MAX_PARENT_DEPTH = 5;
        let depth = 0;
        let current: Parser.SyntaxNode | null = identifier.parent;
        
        while (current && depth < MAX_PARENT_DEPTH) {
            depth++;
            const nodeType = current.type;
            
            // Method call pattern: receiver.method()
            if (nodeType === 'member_expression' && current.namedChildCount >= 2) {
                const propertyNode = current.namedChild(current.namedChildCount - 1);
                // Compare by node id since object references may differ
                if (propertyNode && propertyNode.id === identifier.id) {
                    // Only infer receiver type if we actually found a member expression
                    // This is the expensive part, so we defer it until needed
                    const receiverNode = current.namedChild(0);
                    const receiverType = await this.indexer.inferTypeFromExpression(
                        document, 
                        receiverNode ?? undefined
                    );
                    return { kind: 'method', receiverType };
                }
            }
            
            // Field access pattern
            if (nodeType === 'field_expression' && current.namedChildCount >= 2) {
                const fieldNode = current.namedChild(current.namedChildCount - 1);
                // Compare by node id since object references may differ
                if (fieldNode && fieldNode.id === identifier.id) {
                    const receiverNode = current.namedChild(0);
                    const receiverType = await this.indexer.inferTypeFromExpression(
                        document,
                        receiverNode ?? undefined
                    );
                    return { kind: 'method', receiverType };
                }
            }
            
            // Early exit: if we hit a statement-level node, stop traversing
            // (the identifier can't be part of a member expression above this point)
            if (nodeType === 'expression_statement' || 
                nodeType === 'variable_decl' ||
                nodeType === 'return_statement' ||
                nodeType === 'if_statement' ||
                nodeType === 'while_statement' ||
                nodeType === 'for_statement') {
                break;
            }
            
            current = current.parent;
        }
        
        return { kind: 'free' };
    }

    /**
     * Infers the type of an expression for member resolution.
     * Wrapper around indexer's type inference with additional logic.
     */
    async inferType(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
    ): Promise<string | undefined> {
        return this.indexer.inferTypeFromExpression(document, node);
    }

    /**
     * Checks if a symbol is accessible from the current document.
     */
    isSymbolAccessible(
        symbol: SymbolInfo,
        resolvedImports: ReturnType<typeof this.indexer.getResolvedImports> | undefined
    ): boolean {
        if (!resolvedImports) {
            return true; // No import info, assume accessible
        }

        const modulePath = extractModuleFromQualified(symbol.qualifiedName);

        // No module = global scope, always accessible
        if (!modulePath) {
            return true;
        }

        // Same module
        if (modulePath === resolvedImports.currentModule) {
            return true;
        }

        // Imported module
        if (resolvedImports.importedModules.has(modulePath)) {
            return true;
        }

        return false;
    }

    /**
     * Creates a unique key for deduplicating symbols.
     */
    private symbolKey(sym: SymbolInfo): string {
        return `${sym.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}`;
    }

    /**
     * Computes the final resolution result with confidence scoring.
     */
    private computeResult(
        accessible: SymbolInfo[],
        inaccessible: SymbolInfo[],
        options: ResolutionOptions
    ): ResolutionResult {
        if (accessible.length === 0 && inaccessible.length === 0) {
            return {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
        }

        // If only inaccessible matches, use first as primary with low confidence
        if (accessible.length === 0) {
            const maxAlts = options.maxAlternatives ?? 10;
            return {
                primary: inaccessible[0],
                confidence: 'low',
                alternatives: inaccessible.slice(1, maxAlts + 1),
                inaccessible
            };
        }

        // Single accessible match = exact confidence
        if (accessible.length === 1) {
            return {
                primary: accessible[0],
                confidence: 'exact',
                alternatives: [],
                inaccessible
            };
        }

        // Multiple accessible matches - determine confidence based on count
        const maxAlts = options.maxAlternatives ?? 10;
        const confidence: ResolutionConfidence = 
            accessible.length === 2 ? 'high' :
            accessible.length <= 4 ? 'medium' : 'low';

        return {
            primary: accessible[0],
            confidence,
            alternatives: accessible.slice(1, maxAlts + 1),
            inaccessible
        };
    }
}
