/**
 * Test helpers for Kanagawa extension unit tests
 */

import * as path from 'path';
import * as fs from 'fs';
import * as Parser from 'web-tree-sitter';

let parser: Parser | undefined;
let language: Parser.Language | undefined;

/**
 * Initialize Tree-sitter parser for testing
 * Must be called before using parseCode()
 */
export async function initParser(): Promise<void> {
    if (parser) return;

    await Parser.init();
    
    // Load the WASM from the dist folder
    const wasmPath = path.join(__dirname, '..', '..', 'dist', 'tree-sitter-kanagawa.wasm');
    
    if (!fs.existsSync(wasmPath)) {
        throw new Error(`Tree-sitter WASM not found at ${wasmPath}. Run the grammar build first.`);
    }
    
    const wasmBytes = fs.readFileSync(wasmPath);
    language = await Parser.Language.load(wasmBytes);
    
    parser = new Parser();
    parser.setLanguage(language);
}

/**
 * Parse Kanagawa source code and return the syntax tree
 */
export function parseCode(source: string): Parser.Tree {
    if (!parser) {
        throw new Error('Parser not initialized. Call initParser() first.');
    }
    return parser.parse(source);
}

/**
 * Get the parser instance (for advanced usage)
 */
export function getParser(): Parser | undefined {
    return parser;
}

/**
 * Get the language instance (for queries)
 */
export function getLanguage(): Parser.Language | undefined {
    return language;
}

/**
 * Run a tree-sitter query and return captures
 */
export function runQuery(tree: Parser.Tree, queryString: string): Parser.QueryCapture[] {
    if (!language) {
        throw new Error('Language not initialized. Call initParser() first.');
    }
    const query = language.query(queryString);
    return query.captures(tree.rootNode);
}

/**
 * Pretty-print a syntax tree node (for debugging)
 */
export function printTree(node: Parser.SyntaxNode, indent: number = 0): string {
    const prefix = '  '.repeat(indent);
    let result = `${prefix}${node.type}`;
    
    if (node.childCount === 0) {
        result += `: "${node.text.replace(/\n/g, '\\n')}"`;
    }
    
    result += '\n';
    
    for (const child of node.children) {
        result += printTree(child, indent + 1);
    }
    
    return result;
}

/**
 * Find a node by type in the tree
 */
export function findNodeByType(root: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
    if (root.type === type) return root;
    
    for (const child of root.children) {
        const found = findNodeByType(child, type);
        if (found) return found;
    }
    
    return undefined;
}

/**
 * Find all nodes of a given type
 */
export function findAllNodesByType(root: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    
    if (root.type === type) {
        results.push(root);
    }
    
    for (const child of root.children) {
        results.push(...findAllNodesByType(child, type));
    }
    
    return results;
}

/**
 * Check if a tree has any ERROR nodes
 */
export function hasParseErrors(tree: Parser.Tree): boolean {
    return tree.rootNode.hasError();
}

/**
 * Get all ERROR nodes from a tree
 */
export function getErrorNodes(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
    return findAllNodesByType(root, 'ERROR');
}

/**
 * Assert that code parses without errors
 */
export function assertParsesCleanly(source: string, message?: string): Parser.Tree {
    const tree = parseCode(source);
    if (hasParseErrors(tree)) {
        const errors = getErrorNodes(tree.rootNode);
        const errorInfo = errors.map(e => `  Line ${e.startPosition.row + 1}: "${e.text}"`).join('\n');
        throw new Error(`${message ?? 'Code has parse errors'}:\n${errorInfo}\n\nSource:\n${source}`);
    }
    return tree;
}
