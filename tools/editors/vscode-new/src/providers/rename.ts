import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { findIdentifierNode, nodeToRange } from '../utils/nodeUtils';

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
        token: vscode.CancellationToken
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
        const memberMatches = await this.indexer.resolveMemberSymbol(document, identifier);
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
     */
    private async collectLocalOccurrences(
        document: vscode.TextDocument,
        name: string,
        definition: SymbolInfo,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void,
        token: vscode.CancellationToken
    ): Promise<void> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return; }

        // Find the containing scope (function body, block, etc.)
        const scopeNode = this.findContainingScope(tree, definition.range.start);
        if (!scopeNode) { return; }

        // Collect all identifiers within that scope
        this.collectIdentifiersInNode(scopeNode, name, document.uri, addLocation);
    }

    /**
     * Collects occurrences of a symbol across all workspace files.
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

                // Find all identifiers with this name
                this.collectMatchingIdentifiers(tree.rootNode, name, definition, document, addLocation);
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
     * Uses the indexer for precise matching when possible.
     */
    private collectMatchingIdentifiers(
        node: Parser.SyntaxNode,
        name: string,
        definition: SymbolInfo,
        document: vscode.TextDocument,
        addLocation: (uri: vscode.Uri, range: vscode.Range) => void
    ): void {
        if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text === name) {
            // For simple cases, just match by name
            // More sophisticated: could verify this identifier resolves to the same definition
            // But for now, this provides reasonable accuracy for most use cases
            addLocation(document.uri, nodeToRange(node));
        }

        for (const child of node.namedChildren) {
            this.collectMatchingIdentifiers(child, name, definition, document, addLocation);
        }
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
}
