import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer } from '../service/indexer';

interface TypePeekResult {
    range: vscode.Range;
    label: string;
    tooltip?: string;
    /** Command arguments - VS Code's command API accepts arbitrary argument types */
    commandArgs: unknown[];
}

export class KanagawaTypePeekCodeLensProvider implements vscode.CodeLensProvider {
    constructor(
        private readonly treeService: TreeSitterService,
        private readonly indexer: WorkspaceIndexer
    ) {}

    async provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        // Check if typePeek is enabled (disabled by default since inlay hints show same info)
        const config = vscode.workspace.getConfiguration('kanagawa.typePeek');
        if (!config.get<boolean>('enabled', false)) {
            return [];
        }

        const tree = this.treeService.getTree(document) ?? await this.treeService.parse(document);
        if (!tree) { return []; }

        const results: TypePeekResult[] = [];
        const stack: Parser.SyntaxNode[] = [tree.rootNode];

        while (stack.length > 0) {
            if (token.isCancellationRequested) { return []; }
            const node = stack.pop()!;

            if (node.type === 'variable_decl') {
                const typeNode = node.childForFieldName('type');
                const initializer = node.childForFieldName('initializer');
                const nameNode = node.childForFieldName('name');

                if (!nameNode || !initializer) {
                    // nothing to infer
                } else {
                    const requiresInference = !typeNode || typeNode.text === 'auto';
                    if (requiresInference) {
                        const inferred = await this.indexer.inferTypeFromExpression(document, initializer);
                        if (inferred && inferred.length > 0) {
                            const lensRange = new vscode.Range(
                                new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                                new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column)
                            );
                            results.push({
                                range: lensRange,
                                label: `type: ${inferred}`,
                                tooltip: `Inferred type for ${nameNode.text}`,
                                commandArgs: [
                                    {
                                        name: nameNode.text,
                                        type: inferred,
                                        document: document.uri.toString(),
                                        line: nameNode.startPosition.row + 1
                                    }
                                ]
                            });
                        }
                    }
                }
            }

            for (let i = 0; i < node.namedChildCount; i++) {
                stack.push(node.namedChild(i)!);
            }
        }

        return results.map(result => new vscode.CodeLens(result.range, {
            title: result.label,
            tooltip: result.tooltip,
            command: 'kanagawa.typePeek.show',
            arguments: result.commandArgs
        }));
    }
}
