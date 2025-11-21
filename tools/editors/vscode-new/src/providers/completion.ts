import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { WorkspaceIndexer } from '../service/indexer';
import { TreeSitterService } from '../service/treeSitter';

const KEYWORDS = [
    'module', 'import', 'class', 'fn', 'let', 'var', 'if', 'else',
    'for', 'while', 'return', 'type', 'struct', 'enum', 'interface',
    'extends', 'implements', 'public', 'private', 'protected', 'static',
    'const', 'true', 'false', 'null', 'this', 'super', 'match', 'case',
    'async', 'await', 'try', 'catch', 'throw', 'new'
];

export class KanagawaCompletionItemProvider implements vscode.CompletionItemProvider {
    constructor(
        private indexer: WorkspaceIndexer,
        private treeService: TreeSitterService
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        void _context;
        const tree = this.treeService.getTree(document) ?? this.treeService.parse(document);
        if (!tree) { return undefined; }

        const lineText = document.lineAt(position.line).text;
        const prefix = lineText.slice(0, position.character);

        if (prefix.endsWith('.')) {
            const memberItems = await this.provideMemberCompletions(document, position, tree, token);
            if (memberItems.length > 0) {
                return new vscode.CompletionList(memberItems, true);
            }
        }

        if (prefix.endsWith('::')) {
            const staticItems = await this.provideStaticMemberCompletions(document, position, tree, token, prefix);
            if (staticItems.length > 0) {
                return new vscode.CompletionList(staticItems, true);
            }
        }

        const items: vscode.CompletionItem[] = [];

        const currentPrefix = this.extractWordPrefix(lineText, position.character);

        const locals = this.indexer.collectVisibleLocals(document, position, tree);
        for (const local of locals) {
            if (currentPrefix && !local.name.startsWith(currentPrefix)) { continue; }
            const item = new vscode.CompletionItem(local.name, vscode.CompletionItemKind.Variable);
            item.sortText = `0_${local.name}`;
            if (local.typeHint) {
                item.detail = local.typeHint;
            }
            items.push(item);
        }

        for (const kw of KEYWORDS) {
            if (currentPrefix && !kw.startsWith(currentPrefix)) { continue; }
            const keywordItem = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            keywordItem.sortText = `1_${kw}`;
            items.push(keywordItem);
        }

        const symbols = this.indexer.getAllSymbols();
        const seen = new Set<string>();
        for (const sym of symbols) {
            if (currentPrefix && !sym.name.startsWith(currentPrefix)) { continue; }
            if (seen.has(sym.name)) { continue; }
            seen.add(sym.name);

            const item = new vscode.CompletionItem(sym.name, this.mapSymbolKindToCompletionKind(sym.kind));
            item.detail = sym.detail;
            if (sym.docMarkdown) {
                item.documentation = new vscode.MarkdownString(sym.docMarkdown);
            }
            item.sortText = `2_${sym.name}`;
            items.push(item);
        }

        return new vscode.CompletionList(items, false);
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

    private async provideMemberCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        const targetPos = {
            row: position.line,
            column: Math.max(0, position.character - 1)
        };

        let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(targetPos);
        while (node && node.type !== 'member_expression') {
            node = node.parent;
        }

        if (!node || node.type !== 'member_expression') {
            return [];
        }

        const objectNode = node.namedChild(0);
        if (!objectNode) {
            return [];
        }

        const receiverType = await this.indexer.inferTypeFromExpression(document, objectNode);
        if (!receiverType) {
            return [];
        }

        const members = this.indexer.getMembersForType(receiverType, {
            includeMethods: true,
            includeFields: true
        });

        if (!members.length) {
            return [];
        }

        const items: vscode.CompletionItem[] = [];
        const used = new Set<string>();

        for (const sym of members) {
            if (token.isCancellationRequested) { break; }
            const key = `${sym.name}|${sym.category}|${sym.uri.toString()}|${sym.range.start.line}`;
            if (used.has(key)) { continue; }
            used.add(key);

            const kind = sym.category === 'method'
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Field;

            const item = new vscode.CompletionItem(sym.name, kind);
            if (sym.signature) {
                item.detail = sym.signature;
            } else if (sym.typeHint) {
                item.detail = sym.typeHint;
            }

            if (sym.docMarkdown) {
                item.documentation = new vscode.MarkdownString(sym.docMarkdown);
            }

            if (sym.category === 'method') {
                item.insertText = new vscode.SnippetString(`${sym.name}($0)`);
                item.commitCharacters = ['('];
            } else {
                item.commitCharacters = ['.', ';'];
            }

            // Encourage VS Code to prioritize member completions.
            item.sortText = sym.category === 'method' ? `1_${sym.name}` : `2_${sym.name}`;

            items.push(item);
        }

        return items;
    }

    private async provideStaticMemberCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree,
        token: vscode.CancellationToken,
        prefix: string
    ): Promise<vscode.CompletionItem[]> {
        const match = prefix.match(/([A-Za-z_][\w.]*)::$/);
        if (!match) { return []; }
        const typeName = match[1];
        if (!typeName) { return []; }

        const members = this.indexer.getMembersForType(typeName, {
            includeMethods: true,
            includeFields: true
        });

        if (!members.length) { return []; }

        const items: vscode.CompletionItem[] = [];
        const used = new Set<string>();

        for (const sym of members) {
            if (token.isCancellationRequested) { break; }
            const key = `${sym.name}|${sym.category}|${sym.uri.toString()}|${sym.range.start.line}`;
            if (used.has(key)) { continue; }
            used.add(key);

            const kind = sym.category === 'method'
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Field;

            const item = new vscode.CompletionItem(sym.name, kind);
            if (sym.signature) {
                item.detail = sym.signature;
            } else if (sym.typeHint) {
                item.detail = sym.typeHint;
            }

            if (sym.docMarkdown) {
                item.documentation = new vscode.MarkdownString(sym.docMarkdown);
            }

            if (sym.category === 'method') {
                item.insertText = new vscode.SnippetString(`${sym.name}($0)`);
            }

            item.sortText = sym.category === 'method' ? `1_${sym.name}` : `2_${sym.name}`;
            items.push(item);
        }

        return items;
    }

    private extractWordPrefix(line: string, column: number): string {
        let idx = column - 1;
        while (idx >= 0) {
            const ch = line[idx];
            if (!/[A-Za-z0-9_]/.test(ch)) {
                break;
            }
            idx--;
        }
        const prefix = line.slice(idx + 1, column);
        return prefix;
    }
}
