/**
 * Tree-sitter node utilities for common operations across providers.
 * These functions help locate and extract information from syntax tree nodes.
 */

import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

/**
 * Finds the identifier node at the given position in a parse tree.
 * Handles qualified identifiers and template instantiations by navigating
 * to the appropriate segment.
 * 
 * @param tree The parsed syntax tree
 * @param position The cursor position
 * @returns The identifier node at the position, or undefined if not found
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

    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'identifier' || current.type === 'type_identifier') {
            return current;
        }
        // For qualified_identifier (e.g., Foo::Bar), get the specific segment
        if ((current.type === 'qualified_identifier' || current.type === 'template_instantiation')
            && current.namedChildCount > 0) {
            // Navigate to the last identifier in the chain
            current = current.namedChild(current.namedChildCount - 1);
            continue;
        }
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
