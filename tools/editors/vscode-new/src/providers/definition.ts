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
        const symbols = this.indexer.getSymbols(name);

        if (symbols && symbols.length > 0) {
            return symbols.map(s => new vscode.Location(s.uri, s.range));
        }

        return undefined;
    }
}
