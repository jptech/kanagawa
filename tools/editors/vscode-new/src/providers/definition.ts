import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolContextHint } from '../service/indexer';

export class KanagawaDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const tree = this.service.getTree(document);
        if (!tree) { return undefined; }

        const node = tree.rootNode.descendantForPosition({
            row: position.line,
            column: position.character
        });

        if (!node || (node.type !== 'identifier' && node.type !== 'type_identifier')) {
            return undefined;
        }

        const name = node.text;
        const results: vscode.Location[] = [];
        const seen = new Set<string>();

        const scopePath = this.indexer.getScopePathForNode(node);
        const contextHint = await this.buildContextHint(document, node);
        const matches = this.indexer.resolveSymbols(name, scopePath, {
            uri: document.uri,
            context: contextHint,
            limit: 5
        });
        for (const sym of matches) {
            const key = `${sym.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            results.push(new vscode.Location(sym.uri, sym.range));
        }

        if (results.length === 0) {
            const locals = await this.indexer.findSymbolsInDocument(document, name);
            for (const sym of locals) {
                const key = `${sym.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}`;
                if (seen.has(key)) { continue; }
                seen.add(key);
                results.push(new vscode.Location(sym.uri, sym.range));
            }
        }

        return results.length > 0 ? results : undefined;
    }

    private async buildContextHint(document: vscode.TextDocument, identifier: Parser.SyntaxNode): Promise<SymbolContextHint> {
        let current = identifier.parent;
        while (current) {
            if (current.type === 'member_expression' && current.namedChildCount >= 2) {
                const propertyNode = current.namedChild(current.namedChildCount - 1);
                if (propertyNode === identifier) {
                    const receiverNode = current.namedChild(0);
                    const receiverType = await this.indexer.inferTypeFromExpression(document, receiverNode ?? undefined);
                    return { kind: 'method', receiverType };
                }
            }
            current = current.parent;
        }
        return { kind: 'free' };
    }
}
