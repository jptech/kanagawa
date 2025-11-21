import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer } from '../service/indexer';

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

        const symbols = this.indexer.getSymbols(name) ?? [];
        for (const sym of symbols) {
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
}
