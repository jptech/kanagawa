import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { findIdentifierNode, nodeToRange } from '../utils/nodeUtils';
import { OPERATION_TIMEOUTS, withTimeout } from '../utils/timeout';

/**
 * Represents a scope in the scope tree for tracking variable declarations.
 * Used to correctly handle shadowing during rename operations.
 */
interface ScopeNode {
    /** The AST node that defines this scope (block, function, etc.) */
    node: Parser.SyntaxNode;
    /** Declarations in this scope: name → declaration node */
    declarations: Map<string, Parser.SyntaxNode>;
    /** Parent scope (undefined for root) */
    parent?: ScopeNode;
    /** Child scopes */
    children: ScopeNode[];
}

/**
 * Provides rename functionality for Kanagawa symbols.
 * 
 * Supports renaming:
 * - Local variables and parameters
 * - Functions and methods  
 * - Types, structs, and modules
 * - Member fields
 * 
 * Uses the indexer's symbol resolution to find all references
 * and creates workspace edits for consistent renaming.
 */
export class KanagawaRenameProvider implements vscode.RenameProvider {
    constructor(
        private readonly service: TreeSitterService,
        private readonly indexer: WorkspaceIndexer
    ) {}

    /**
     * Prepares for rename operation by validating the symbol at position
     * and returning the current symbol name with its range.
     * 
     * This is called when user triggers rename (F2) to show the rename input box.
     */
    async prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return undefined; }

        const identifier = findIdentifierNode(tree, position);
        if (!identifier) { return undefined; }

        // Check if this symbol can be renamed (has a definition we can find)
        const definition = await this.findDefinition(document, identifier);
        if (!definition) {
            // Symbol not found in index - may be a built-in or external
            throw new Error('Cannot rename: symbol definition not found');
        }

        // Return the range and current name for the rename input box
        return {
            range: nodeToRange(identifier),
            placeholder: identifier.text
        };
    }

    /**
     * Performs the actual rename operation, returning workspace edits
     * for all occurrences of the symbol.
     */
    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        token: vscode.CancellationToken
    ): Promise<vscode.WorkspaceEdit | undefined> {
        // Validate the new name
        if (!this.isValidIdentifier(newName)) {
            throw new Error(`Invalid identifier: "${newName}". Use only letters, numbers, and underscores.`);
        }

        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return undefined; }

        const identifier = findIdentifierNode(tree, position);
        if (!identifier) { return undefined; }

        const oldName = identifier.text;
        if (oldName === newName) {
            // No change needed
            return undefined;
        }

        // Find the definition to use as the canonical symbol
        const definition = await this.findDefinition(document, identifier);
        if (!definition) {
            throw new Error('Cannot rename: symbol definition not found');
        }

        // Collect all locations where this symbol appears
        const locations = await this.collectAllOccurrences(document, identifier, definition, token);
        if (token.isCancellationRequested) { return undefined; }

        if (locations.length === 0) {
            throw new Error('Cannot rename: no occurrences found');
        }

        // Build the workspace edit
        const edit = new vscode.WorkspaceEdit();
        for (const location of locations) {
            edit.replace(location.uri, location.range, newName);
        }

        return edit;
    }

    /**
     * Finds the definition of the symbol represented by the identifier node.
     */
    private async findDefinition(
        document: vscode.TextDocument,
        identifier: Parser.SyntaxNode
    ): Promise<SymbolInfo | undefined> {
        const name = identifier.text;
        const scopePath = this.indexer.getScopePathForNode(identifier);

        // Priority 1: Check for local variable/parameter
        const localSymbol = this.indexer.findNearestLocalSymbol(document, identifier);
        if (localSymbol) {
            return localSymbol;
        }

        // Priority 2: Try member resolution (obj.member patterns)
        const memberMatches = await withTimeout(
            'rename member resolution',
            this.indexer.resolveMemberSymbol(document, identifier),
            OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
        );
        if (memberMatches && memberMatches.length > 0) {
            // Return the best match (first one from sorted results)
            return memberMatches[0];
        }

        // Priority 3: Context-aware resolution
        const resolution = this.indexer.resolveWithContext(name, scopePath, {
            uri: document.uri,
            context: { kind: 'free' }
        });

        if (resolution.primary) {
            return resolution.primary;
        }

        // Priority 4: Search document-local symbols
        const locals = await this.indexer.findSymbolsInDocument(document, name);
        if (locals.length > 0) {
            return locals[0];
        }

        return undefined;
    }

    /**
     * Collects all occurrences of the symbol that should be renamed.
     * Includes the definition and all references across the workspace.
     */
    private async collectAllOccurrences(
        document: vscode.TextDocument,
        identifier: Parser.SyntaxNode,
        definition: SymbolInfo,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const locations: vscode.Location[] = [];
        const seen = new Set<string>();

        const addLocation = (uri: vscode.Uri, range: vscode.Range): void => {
            const key = `${uri.toString()}#${range.start.line}:${range.start.character}`;
            if (seen.has(key)) { return; }
            seen.add(key);
            locations.push(new vscode.Location(uri, range));
        };

        // Add the definition itself
        addLocation(definition.uri, definition.range);

        // Determine if this is a local symbol (only search current document)
        // or a broader symbol (search workspace)
        // Local variables (including parameters) have category 'variable'
        const isLocal = definition.category === 'variable';

        if (isLocal) {
            // For local symbols, only search within the containing scope
            await this.collectLocalOccurrences(document, identifier.text, definition, addLocation, token);
        } else {
            // For broader symbols, search all workspace files
            await this.collectWorkspaceOccurrences(identifier.text, definition, addLocation, token);
        }

        return locations;
    }

    /**
     * Collects occurrences of a local symbol within its containing scope.
     * Uses scope-aware collection to avoid renaming shadowed variables.
     */
    private async collectLocalOccurrences(
        document: vscode.TextDocument,
        name: string,
        definition: SymbolInfo,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return; }

        // Find the containing scope (function body, block, etc.)
        const scopeNode = this.findContainingScope(tree, definition.range.start);
        if (!scopeNode) { return; }

        // Build scope tree to track declarations and shadowing
        const scopeTree = this.buildScopeTree(scopeNode);
        
        // Find which scope contains our target declaration
        const targetDeclarationScope = this.findDeclarationScope(scopeTree, definition.range.start, name);
        if (!targetDeclarationScope) {
            // Fallback to simple collection if we can't find the declaration scope
            this.collectIdentifiersInNode(scopeNode, name, document.uri, addLocation);
            return;
        }

        // Collect identifiers that resolve to the same declaration (respecting shadowing)
        this.collectScopeAwareIdentifiers(scopeTree, name, targetDeclarationScope, document.uri, addLocation);
    }

    /**
     * Collects occurrences of a symbol across all workspace files.
     * Verifies each identifier resolves to the same definition for accuracy.
     */
    private async collectWorkspaceOccurrences(
        name: string,
        definition: SymbolInfo,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Get all Kanagawa files in the workspace
        const files = await vscode.workspace.findFiles('**/*.k', '**/node_modules/**');

        for (const fileUri of files) {
            if (token.isCancellationRequested) { break; }

            try {
                const document = await vscode.workspace.openTextDocument(fileUri);
                const tree = this.service.getTree(document) ?? await this.service.parse(document);
                if (!tree) { continue; }

                // Find all identifiers with this name and verify they resolve to the same definition
                await this.collectMatchingIdentifiers(tree.rootNode, name, definition, document, addLocation, token);
            } catch (e) {
                // Skip files that can't be opened
                console.warn(`Rename: Could not process ${fileUri.toString()}:`, e);
            }
        }
    }

    /**
     * Finds the containing scope node for a given position.
     */
    private findContainingScope(tree: Parser.Tree, position: vscode.Position): Parser.SyntaxNode | undefined {
        const node = tree.rootNode.descendantForPosition({
            row: position.line,
            column: position.character
        });

        let current: Parser.SyntaxNode | null = node;
        while (current) {
            // Common scope boundaries
            if (current.type === 'function_definition' ||
                current.type === 'block' ||
                current.type === 'module_definition' ||
                current.type === 'struct_definition') {
                return current;
            }
            current = current.parent;
        }

        // Fall back to root
        return tree.rootNode;
    }

    /**
     * Collects all identifiers with the given name within a node.
     */
    private collectIdentifiersInNode(
        node: Parser.SyntaxNode,
        name: string,
        uri: vscode.Uri,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void
    ): void {
        if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text === name) {
            addLocation(uri, nodeToRange(node));
        }

        for (const child of node.namedChildren) {
            this.collectIdentifiersInNode(child, name, uri, addLocation);
        }
    }

    /**
     * Collects identifiers that resolve to the given definition.
     * Uses the indexer for precise matching to avoid renaming unrelated symbols with the same name.
     */
    private async collectMatchingIdentifiers(
        node: Parser.SyntaxNode,
        name: string,
        definition: SymbolInfo,
        document: vscode.TextDocument,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void,
        token: vscode.CancellationToken
    ): Promise<void> {
        if (token.isCancellationRequested) { return; }

        if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text === name) {
            // Verify this identifier resolves to the same definition
            if (await this.resolvesToSameDefinition(node, definition, document)) {
                addLocation(document.uri, nodeToRange(node));
            }
        }

        for (const child of node.namedChildren) {
            await this.collectMatchingIdentifiers(child, name, definition, document, addLocation, token);
        }
    }

    /**
     * Checks if an identifier node resolves to the same definition.
     * This prevents renaming unrelated symbols with the same name.
     */
    private async resolvesToSameDefinition(
        node: Parser.SyntaxNode,
        definition: SymbolInfo,
        document: vscode.TextDocument
    ): Promise<boolean> {
        // For local variables, check if we're in the same scope
        if (definition.category === 'variable') {
            // Local variables are handled by collectLocalOccurrences, which is scope-bounded
            // If we're here, it's a workspace search for a non-local, so match by name is ok
            return true;
        }

        // Try member resolution first (for obj.member patterns)
        if (node.parent?.type === 'member_expression') {
            const memberMatches = await withTimeout(
                'rename resolve-to-same member resolution',
                this.indexer.resolveMemberSymbol(document, node),
                OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
            );
            if (memberMatches && memberMatches.length > 0) {
                return memberMatches.some(match => this.isSameSymbol(match, definition));
            }
        }

        // Use context-aware resolution for consistency with hover/definition
        const scopePath = this.indexer.getScopePathForNode(node);
        const resolution = this.indexer.resolveWithContext(node.text, scopePath, {
            uri: document.uri,
            context: { kind: 'free' }
        });

        // Check if the resolution matches our target definition
        if (resolution.primary && this.isSameSymbol(resolution.primary, definition)) {
            return true;
        }
        
        // Also check alternatives
        return resolution.alternatives.some(alt => this.isSameSymbol(alt, definition));
    }

    /**
     * Checks if two symbols refer to the same definition.
     */
    private isSameSymbol(a: SymbolInfo, b: SymbolInfo): boolean {
        return a.uri.toString() === b.uri.toString() &&
            a.range.start.line === b.range.start.line &&
            a.range.start.character === b.range.start.character;
    }

    /**
     * Validates that a string is a valid Kanagawa identifier.
     * Identifiers must start with a letter or underscore,
     * followed by letters, numbers, or underscores.
     */
    private isValidIdentifier(name: string): boolean {
        if (!name || name.length === 0) { return false; }
        // Basic identifier validation: [a-zA-Z_][a-zA-Z0-9_]*
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
    }

    // =========================================================================
    // Scope Tree Building and Traversal (for shadowing-aware rename)
    // =========================================================================

    /** Node types that create new scopes */
    private static readonly SCOPE_TYPES = new Set([
        'function_definition',
        'block',
        'compound_statement',
        'for_statement',
        'while_statement',
        'do_while_statement',
        'if_statement',
        'switch_statement',
        'lambda_expression'
    ]);

    /** Node types that declare variables */
    private static readonly DECLARATION_TYPES = new Set([
        'variable_decl',
        'parameter',
        'for_range_declaration'
    ]);

    /**
     * Builds a scope tree from an AST node, tracking all variable declarations.
     * This enables proper handling of variable shadowing during rename.
     */
    private buildScopeTree(root: Parser.SyntaxNode): ScopeNode {
        const rootScope: ScopeNode = {
            node: root,
            declarations: new Map(),
            children: []
        };

        this.populateScopeTree(root, rootScope);
        return rootScope;
    }

    /**
     * Recursively populates the scope tree by walking the AST.
     */
    private populateScopeTree(node: Parser.SyntaxNode, currentScope: ScopeNode): void {
        // Check if this node creates a new scope
        if (KanagawaRenameProvider.SCOPE_TYPES.has(node.type) && node !== currentScope.node) {
            const childScope: ScopeNode = {
                node,
                declarations: new Map(),
                parent: currentScope,
                children: []
            };
            currentScope.children.push(childScope);
            
            // For function definitions, add parameters to the function's scope
            if (node.type === 'function_definition') {
                const params = node.childForFieldName('parameters');
                if (params) {
                    for (const param of params.namedChildren) {
                        if (param.type === 'parameter') {
                            const nameNode = param.childForFieldName('name');
                            if (nameNode) {
                                childScope.declarations.set(nameNode.text, param);
                            }
                        }
                    }
                }
            }
            
            // Continue with the child scope
            for (const child of node.namedChildren) {
                this.populateScopeTree(child, childScope);
            }
            return;
        }

        // Check if this node is a declaration
        if (KanagawaRenameProvider.DECLARATION_TYPES.has(node.type)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                currentScope.declarations.set(nameNode.text, node);
            }
        }

        // Recurse into children
        for (const child of node.namedChildren) {
            this.populateScopeTree(child, currentScope);
        }
    }

    /**
     * Finds the scope that contains the declaration at the given position.
     */
    private findDeclarationScope(
        scopeTree: ScopeNode,
        position: vscode.Position,
        name: string
    ): ScopeNode | undefined {
        // Check if this scope has the declaration at this position
        const decl = scopeTree.declarations.get(name);
        if (decl) {
            const declStart = decl.startPosition;
            const declEnd = decl.endPosition;
            if (position.line >= declStart.row && position.line <= declEnd.row) {
                // Position is within this declaration
                return scopeTree;
            }
        }

        // Check children
        for (const child of scopeTree.children) {
            const found = this.findDeclarationScope(child, position, name);
            if (found) { return found; }
        }

        // If we have the declaration and the position is after it, this is the scope
        if (decl) {
            const declLine = decl.startPosition.row;
            if (position.line >= declLine) {
                return scopeTree;
            }
        }

        return undefined;
    }

    /**
     * Collects identifiers that resolve to a declaration in the target scope,
     * respecting shadowing in nested scopes.
     */
    private collectScopeAwareIdentifiers(
        scopeTree: ScopeNode,
        name: string,
        targetScope: ScopeNode,
        uri: vscode.Uri,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void
    ): void {
        // Check if this scope shadows the variable
        const shadowsVariable = scopeTree !== targetScope && 
                               scopeTree.declarations.has(name) &&
                               !this.isAncestorScope(scopeTree, targetScope);

        if (shadowsVariable) {
            // This scope has its own declaration of this name, don't collect here
            return;
        }

        // Check if this scope is where the target declaration lives, or is a child of it
        const isInTargetScopeOrChild = scopeTree === targetScope || 
                                       this.isAncestorScope(targetScope, scopeTree);

        if (!isInTargetScopeOrChild) {
            // This scope is not accessible from target scope
            return;
        }

        // Collect identifiers in this scope's node (but not in child scopes - they're handled recursively)
        this.collectIdentifiersInNodeExcludingChildScopes(
            scopeTree.node,
            name,
            uri,
            addLocation,
            new Set(scopeTree.children.map(c => c.node.id))
        );

        // Recurse into child scopes
        for (const child of scopeTree.children) {
            this.collectScopeAwareIdentifiers(child, name, targetScope, uri, addLocation);
        }
    }

    /**
     * Checks if `ancestor` is an ancestor scope of `descendant`.
     */
    private isAncestorScope(ancestor: ScopeNode, descendant: ScopeNode): boolean {
        let current: ScopeNode | undefined = descendant.parent;
        while (current) {
            if (current === ancestor) { return true; }
            current = current.parent;
        }
        return false;
    }

    /**
     * Collects identifiers with the given name, excluding nodes that are child scopes.
     */
    private collectIdentifiersInNodeExcludingChildScopes(
        node: Parser.SyntaxNode,
        name: string,
        uri: vscode.Uri,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void,
        excludedNodeIds: Set<number>
    ): void {
        // Skip excluded nodes (child scopes)
        if (excludedNodeIds.has(node.id)) {
            return;
        }

        if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text === name) {
            addLocation(uri, nodeToRange(node));
        }

        for (const child of node.namedChildren) {
            this.collectIdentifiersInNodeExcludingChildScopes(child, name, uri, addLocation, excludedNodeIds);
        }
    }
}
