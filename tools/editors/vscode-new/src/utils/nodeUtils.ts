/**
 * Tree-sitter node utilities for common operations across providers.
 * These functions help locate and extract information from syntax tree nodes.
 */

import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

/**
 * Checks if a syntax node is part of a module or import declaration.
 * These are module path components, not resolvable symbols.
 * 
 * CRITICAL: This function is used to prevent expensive symbol resolution
 * on module/import statements which can cause extension hangs.
 * 
 * @param node The syntax node to check
 * @returns True if the node is in a module/import context
 */
export function isModuleOrImportNode(node: Parser.SyntaxNode | null): boolean {
    if (!node) return false;
    
    const MAX_DEPTH = 15;
    let current: Parser.SyntaxNode | null = node;
    let depth = 0;
    
    while (current && depth < MAX_DEPTH) {
        const nodeType = current.type;
        
        // Check for import or module declaration nodes AND their components
        if (nodeType === 'import_decl' || 
            nodeType === 'module_decl' ||
            nodeType === 'module_name' ||
            nodeType === 'module_identifier_part' ||  // Individual parts like 'shuffle' in 'shuffle.send_scheduler'
            nodeType === 'module_exports' ||
            nodeType === 'module_reference' ||
            nodeType === 'module_diff') {
            return true;
        }
        
        // Early exit if we've hit a code boundary (definitely not in module/import)
        if (nodeType === 'source_file' || 
            nodeType === 'function_definition' ||
            nodeType === 'function_template' ||
            nodeType === 'class_body' ||
            nodeType === 'struct_body' ||
            nodeType === 'expression_statement' ||
            nodeType === 'variable_decl' ||
            nodeType === 'block' ||
            nodeType === 'compound_statement') {
            break;
        }
        
        current = current.parent;
        depth++;
    }
    
    return false;
}

/**
 * Finds the identifier node at the given position in a parse tree.
 * Handles qualified identifiers and template instantiations by navigating
 * to the appropriate segment.
 * 
 * Returns undefined for module/import paths to prevent expensive resolution.
 * 
 * @param tree The parsed syntax tree
 * @param position The cursor position
 * @returns The identifier node at the position, or undefined if not found or in module/import context
 * 
 * @example
 * // For "Foo::Bar" at the cursor on "Bar", returns the "Bar" identifier node
 * findIdentifierNode(tree, position)
 */
export function findIdentifierNode(
    tree: Parser.Tree,
    position: vscode.Position
): Parser.SyntaxNode | undefined {
    const node = tree.rootNode.descendantForPosition({
        row: position.line,
        column: position.character
    });
    
    // CRITICAL: Check for module/import nodes FIRST before any resolution.
    // This prevents expensive operations when hovering on module declarations or imports.
    if (isModuleOrImportNode(node)) {
        return undefined;
    }

    return resolveToIdentifier(node);
}

/**
 * Resolves a syntax node to its identifier, handling various node types.
 * This is the core logic shared across providers for finding the actual
 * identifier from any node in the AST.
 * 
 * Handles:
 * - Direct identifier/type_identifier nodes
 * - Member expressions (obj.member) → returns the member identifier
 * - Qualified identifiers (Foo::Bar) → returns the rightmost identifier
 * - Template instantiations (Foo<T>) → returns the base type identifier
 * - Module names with nested components
 * - Field expressions
 * 
 * @param node The starting node (often from descendantForPosition)
 * @returns The identifier node, or undefined if not on an identifier
 * 
 * @example
 * // For node at "obj.method()", returns the "method" identifier
 * resolveToIdentifier(node)
 */
export function resolveToIdentifier(
    node: Parser.SyntaxNode | null
): Parser.SyntaxNode | undefined {
    let current = node;
    while (current) {
        // Direct identifier match
        if (current.type === 'identifier' || current.type === 'type_identifier') {
            return current;
        }
        
        // For qualified identifiers (e.g., Foo::Bar), get the specific segment
        if (current.type === 'qualified_identifier' || current.type === 'scoped_identifier') {
            const nameField = current.childForFieldName('name');
            if (nameField && (nameField.type === 'identifier' || nameField.type === 'type_identifier')) {
                return nameField;
            }
            // Fall back to last named child
            if (current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
        }
        
        // For template instantiation (e.g., Foo<T>), get the base type
        if (current.type === 'template_instantiation') {
            const baseType = current.childForFieldName('type') ?? current.namedChild(0);
            if (baseType) {
                if (baseType.type === 'identifier' || baseType.type === 'type_identifier') {
                    return baseType;
                }
                current = baseType;
                continue;
            }
        }
        
        // For member expression (e.g., obj.member), get the member
        if (current.type === 'member_expression' || current.type === 'field_expression') {
            const memberField = current.childForFieldName('member') ?? 
                               current.childForFieldName('field') ??
                               current.namedChild(current.namedChildCount - 1);
            if (memberField && (memberField.type === 'identifier' || memberField.type === 'type_identifier')) {
                return memberField;
            }
        }
        
        // For module_name with nested components
        if (current.type === 'module_name' && current.namedChildCount > 0) {
            current = current.namedChild(current.namedChildCount - 1);
            continue;
        }
        
        // Move up to parent
        current = current.parent;
    }
    return undefined;
}

/**
 * Extracts text from a syntax node using the document.
 * Returns undefined if the node is null or invalid.
 * 
 * @param document The VS Code text document
 * @param node The syntax node to get text from
 * @returns The node's text content, or undefined
 */
export function getNodeText(
    document: vscode.TextDocument,
    node: Parser.SyntaxNode | null | undefined
): string | undefined {
    if (!node) { return undefined; }
    try {
        const range = new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column)
        );
        return document.getText(range);
    } catch {
        return undefined;
    }
}

/**
 * Converts a syntax node's position to a VS Code Range.
 * 
 * @param node The syntax node
 * @returns A VS Code Range covering the node
 */
export function nodeToRange(node: Parser.SyntaxNode): vscode.Range {
    return new vscode.Range(
        new vscode.Position(node.startPosition.row, node.startPosition.column),
        new vscode.Position(node.endPosition.row, node.endPosition.column)
    );
}

/**
 * Converts a syntax node's position to a VS Code Location.
 * 
 * @param uri The document URI
 * @param node The syntax node
 * @returns A VS Code Location for the node
 */
export function nodeToLocation(uri: vscode.Uri, node: Parser.SyntaxNode): vscode.Location {
    return new vscode.Location(uri, nodeToRange(node));
}

/**
 * Finds the nearest ancestor node of a specific type.
 * 
 * @param node The starting node
 * @param type The type name to search for
 * @returns The ancestor node with the matching type, or undefined
 */
export function findAncestorOfType(
    node: Parser.SyntaxNode | null,
    type: string
): Parser.SyntaxNode | undefined {
    let current = node;
    while (current) {
        if (current.type === type) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

/**
 * Finds the nearest ancestor node matching any of the specified types.
 * 
 * @param node The starting node
 * @param types Array of type names to search for
 * @returns The first ancestor node matching any type, or undefined
 */
export function findAncestorOfTypes(
    node: Parser.SyntaxNode | null,
    types: string[]
): Parser.SyntaxNode | undefined {
    const typeSet = new Set(types);
    let current = node;
    while (current) {
        if (typeSet.has(current.type)) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

/**
 * Collects all descendant nodes of a specific type.
 * 
 * @param node The root node to search from
 * @param type The type name to collect
 * @returns Array of matching descendant nodes
 */
export function collectDescendantsOfType(
    node: Parser.SyntaxNode,
    type: string
): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    
    const visit = (n: Parser.SyntaxNode) => {
        if (n.type === type) {
            results.push(n);
        }
        for (const child of n.namedChildren) {
            visit(child);
        }
    };
    
    visit(node);
    return results;
}

/**
 * Checks if a position is within a node's range.
 * 
 * @param node The syntax node
 * @param position The position to check
 * @returns True if the position is within the node's range
 */
export function isPositionInNode(node: Parser.SyntaxNode, position: vscode.Position): boolean {
    const start = node.startPosition;
    const end = node.endPosition;
    
    if (position.line < start.row || position.line > end.row) {
        return false;
    }
    
    if (position.line === start.row && position.character < start.column) {
        return false;
    }
    
    if (position.line === end.row && position.character > end.column) {
        return false;
    }
    
    return true;
}

/**
 * Gets the name of a function, struct, or other named definition.
 * Looks for a 'name' field child in the node.
 * 
 * @param node The definition node
 * @returns The name text, or undefined if not found
 */
export function getDefinitionName(node: Parser.SyntaxNode): string | undefined {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text;
}

/**
 * Gets the type annotation from a declaration or parameter.
 * Looks for a 'type' field child in the node.
 * 
 * @param node The declaration node
 * @returns The type node, or undefined if not found
 */
export function getTypeNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
    return node.childForFieldName('type') ?? undefined;
}

/**
 * Creates a unique string key for a location (URI + position).
 * Useful for deduplication in Sets and Maps.
 * 
 * @param uri The document URI
 * @param range The range (uses start position)
 * @returns A string key in the format "uri#line:character"
 */
export function makeLocationKey(uri: vscode.Uri, range: vscode.Range): string {
    return `${uri.toString()}#${range.start.line}:${range.start.character}`;
}

/**
 * Creates a unique string key for a symbol location.
 * Useful for deduplication in Sets and Maps.
 * 
 * @param uri The document URI
 * @param line The line number
 * @param character The character position
 * @returns A string key in the format "uri#line:character"
 */
export function makePositionKey(uri: vscode.Uri, line: number, character: number): string {
    return `${uri.toString()}#${line}:${character}`;
}
