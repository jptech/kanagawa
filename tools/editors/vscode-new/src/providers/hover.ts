import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer } from '../service/indexer';

export class KanagawaHoverProvider implements vscode.HoverProvider {
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const tree = this.service.getTree(document);
        if (!tree) { return undefined; }

        const node = tree.rootNode.descendantForPosition({
            row: position.line,
            column: position.character
        });

        if (!node) { return undefined; }

        // We are interested in identifiers
        if (node.type === 'identifier' || node.type === 'type_identifier') {
            const name = node.text;
            
            // 1. Check local definitions (heuristic)
            // (Not implemented in this lite version, skipping to global)

            // 2. Check global index
            const symbols = this.indexer.getSymbols(name);
            if (symbols && symbols.length > 0) {
                const contents: vscode.MarkdownString[] = [];
                
                for (const sym of symbols) {
                    const md = new vscode.MarkdownString();
                    md.appendCodeblock(`${sym.detail} ${sym.name}`, 'kanagawa');
                    if (sym.docMarkdown) {
                        md.appendMarkdown(`\n\n${sym.docMarkdown}`);
                    }
                    md.appendMarkdown(`\n\n*Defined in ${vscode.workspace.asRelativePath(sym.uri)}*`);
                    contents.push(md);
                }
                
                return new vscode.Hover(contents, new vscode.Range(
                    position.line, node.startPosition.column,
                    position.line, node.endPosition.column
                ));
            }
            
            // 3. Heuristic Type Resolution for 'auto'
            // If we are hovering over a variable that was defined as auto
            // We can try to find its definition node in the current file
            if (node.parent?.type === 'variable_decl') {
                 // It's the definition itself
                 // Check if type is auto
                 const typeNode = node.parent.childForFieldName('type');
                 if (typeNode?.text === 'auto') {
                     // Look at initializer
                     const valueNode = node.parent.childForFieldName('value'); // Assuming grammar has value field or we find it
                     // In grammar.js: optional(seq('=', $.expression))
                     // We need to check children manually if field names aren't perfect
                     // ...
                 }
            }
        }

        return undefined;
    }
}
