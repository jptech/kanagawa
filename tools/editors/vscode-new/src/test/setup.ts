/**
 * Mocha Test Setup for Kanagawa VS Code Extension
 * 
 * This file configures the test environment and handles parser initialization.
 */

import * as path from 'path';
import * as fs from 'fs';

// Mock VS Code API for tests that don't need the full extension host
const mockVscode = {
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file' }),
        parse: (s: string) => ({ fsPath: s, scheme: 'file' })
    },
    Position: class {
        constructor(public line: number, public character: number) {}
    },
    Range: class {
        constructor(
            public start: { line: number; character: number },
            public end: { line: number; character: number }
        ) {}
    },
    SymbolKind: {
        File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4,
        Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9,
        Interface: 10, Function: 11, Variable: 12, Constant: 13,
        String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
        Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23,
        Operator: 24, TypeParameter: 25
    },
    CompletionItemKind: {
        Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4,
        Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9,
        Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14,
        Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19,
        Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24
    }
};

// Register vscode mock globally for modules that import it
(global as any).vscode = mockVscode;

// Helper to get the extension root directory
export function getExtensionRoot(): string {
    return path.resolve(__dirname, '../..');
}

// Helper to get the grammar WASM file path
export function getGrammarWasmPath(): string {
    return path.join(getExtensionRoot(), 'dist', 'tree-sitter-kanagawa.wasm');
}

// Helper to check if grammar WASM exists
export function grammarWasmExists(): boolean {
    return fs.existsSync(getGrammarWasmPath());
}

// Export helpers for tests
export { mockVscode };
