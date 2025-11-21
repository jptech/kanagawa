import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as path from 'path';

export class TreeSitterService {
    private parser: Parser | undefined;
    private trees: Map<string, Parser.Tree> = new Map();
    private language: Parser.Language | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    async init() {
        try {
            // Explicitly point to the runtime WASM in the dist folder
            const runtimeWasmPath = path.join(this.context.extensionPath, 'dist', 'tree-sitter.wasm');
            await Parser.init({
                locateFile: () => runtimeWasmPath
            });

            const langWasmPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'tree-sitter-kanagawa.wasm');
            
            // In a real extension, we need to handle the case where the file doesn't exist yet (during dev)
            // But assuming build process puts it there.
            // For web compatibility, we read file as bytes.
            const bits = await vscode.workspace.fs.readFile(langWasmPath);
            this.language = await Parser.Language.load(bits);
            
            this.parser = new Parser();
            this.parser.setLanguage(this.language);
            console.log('Kanagawa: Tree-sitter initialized successfully.');
        } catch (e) {
            console.error('Failed to initialize TreeSitterService:', e);
            vscode.window.showErrorMessage(`Kanagawa: Failed to load Tree-sitter parser: ${e}`);
        }
    }

    getParser(): Parser | undefined {
        return this.parser;
    }

    getLanguage(): Parser.Language | undefined {
        return this.language;
    }

    getTree(document: vscode.TextDocument): Parser.Tree | undefined {
        return this.trees.get(document.uri.toString());
    }

    parse(document: vscode.TextDocument): Parser.Tree | undefined {
        if (!this.parser) { 
            console.warn('Kanagawa: Parser not initialized.');
            return undefined; 
        }
        
        const uri = document.uri.toString();
        const oldTree = this.trees.get(uri);
        
        // In a full implementation, we would use oldTree.edit() for incremental parsing
        // based on content changes. For simplicity in this version, we re-parse.
        // To do incremental, we need to hook into onDidChangeTextDocument and map changes.
        
        try {
            const newTree = this.parser.parse(document.getText(), oldTree);
            this.trees.set(uri, newTree);
            return newTree;
        } catch (e) {
            console.error('Kanagawa: Parse failed:', e);
            return undefined;
        }
    }

    remove(document: vscode.TextDocument) {
        const uri = document.uri.toString();
        const tree = this.trees.get(uri);
        if (tree) {
            tree.delete();
            this.trees.delete(uri);
        }
    }
    
    // Helper to query the tree
    query(node: Parser.SyntaxNode, queryString: string): Parser.QueryCapture[] {
        if (!this.language) { return []; }
        try {
            const query = this.language.query(queryString);
            return query.captures(node);
        } catch (e) {
            console.error('Query failed:', e);
            return [];
        }
    }
}
