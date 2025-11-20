import * as vscode from 'vscode';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';

const KEYWORDS = [
    'module', 'import', 'class', 'fn', 'let', 'var', 'if', 'else', 
    'for', 'while', 'return', 'type', 'struct', 'enum', 'interface', 
    'extends', 'implements', 'public', 'private', 'protected', 'static', 
    'const', 'true', 'false', 'null', 'this', 'super', 'match', 'case',
    'async', 'await', 'try', 'catch', 'throw', 'new'
];

export class KanagawaCompletionItemProvider implements vscode.CompletionItemProvider {
    constructor(private indexer: WorkspaceIndexer) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        
        const items: vscode.CompletionItem[] = [];

        // 1. Add Keywords
        for (const kw of KEYWORDS) {
            items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
        }

        // 2. Add Symbols from Index
        const symbols = this.indexer.getAllSymbols();
        for (const sym of symbols) {
            const item = new vscode.CompletionItem(sym.name);
            item.kind = this.mapSymbolKindToCompletionKind(sym.kind);
            item.detail = sym.detail;
            item.documentation = new vscode.MarkdownString(sym.docMarkdown);
            
            // Store URI to maybe auto-import later?
            // item.command = ...
            
            items.push(item);
        }

        return items;
    }

    private mapSymbolKindToCompletionKind(kind: vscode.SymbolKind): vscode.CompletionItemKind {
        switch (kind) {
            case vscode.SymbolKind.Class: return vscode.CompletionItemKind.Class;
            case vscode.SymbolKind.Method: return vscode.CompletionItemKind.Method;
            case vscode.SymbolKind.Function: return vscode.CompletionItemKind.Function;
            case vscode.SymbolKind.Variable: return vscode.CompletionItemKind.Variable;
            case vscode.SymbolKind.Module: return vscode.CompletionItemKind.Module;
            case vscode.SymbolKind.Interface: return vscode.CompletionItemKind.Interface;
            case vscode.SymbolKind.Struct: return vscode.CompletionItemKind.Struct;
            case vscode.SymbolKind.Enum: return vscode.CompletionItemKind.Enum;
            default: return vscode.CompletionItemKind.Text;
        }
    }
}
