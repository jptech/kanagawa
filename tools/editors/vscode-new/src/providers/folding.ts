import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';

export class KanagawaFoldingRangeProvider implements vscode.FoldingRangeProvider {
    constructor(private service: TreeSitterService) {}

    async provideFoldingRanges(
        document: vscode.TextDocument,
        context: vscode.FoldingContext,
        token: vscode.CancellationToken
    ): Promise<vscode.FoldingRange[]> {
        const tree = this.service.getTree(document);
        if (!tree) { return []; }

        const ranges: vscode.FoldingRange[] = [];
        
        // We can traverse the tree or use a query.
        // A query is simpler for specific node types.
        // We want to fold: blocks, comments, class bodies, etc.
        
        const queryString = `
            (block) @fold
            (comment) @fold
            (class_decl) @fold
            (module_decl) @fold
            (attributes) @fold
        `;
        
        const captures = this.service.query(tree.rootNode, queryString);
        
        for (const capture of captures) {
            const node = capture.node;
            
            // Only fold if it spans multiple lines
            if (node.startPosition.row < node.endPosition.row) {
                // For blocks { }, we usually want to fold from the line of the opening brace
                // to the line of the closing brace.
                // Tree-sitter range includes the braces.
                
                // VS Code folding range is 0-indexed line numbers.
                // If we return startLine, endLine, it folds everything in between.
                
                // Adjustments for specific types if needed:
                // e.g. for 'block', we might want to leave the closing brace visible?
                // VS Code handles this mostly automatically if we give the full range.
                
                ranges.push(new vscode.FoldingRange(
                    node.startPosition.row,
                    node.endPosition.row,
                    capture.name === 'comment' ? vscode.FoldingRangeKind.Comment : vscode.FoldingRangeKind.Region
                ));
            }
        }
        
        return ranges;
    }
}
