import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';

export class KanagawaFoldingRangeProvider implements vscode.FoldingRangeProvider {
    constructor(private service: TreeSitterService) {}

    async provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.FoldingRange[]> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return []; }

        const ranges: vscode.FoldingRange[] = [];
        
        // Query for foldable constructs
        const queryString = `
            ; Blocks and braced constructs
            (block) @fold.region
            (initializer_list) @fold.region
            
            ; Declarations with bodies
            (class_decl) @fold.region
            (struct_decl) @fold.region
            (union_decl) @fold.region
            (enum_decl) @fold.region
            (module_decl) @fold.region
            (function_definition) @fold.region
            
            ; Template wrappers
            (function_template) @fold.region
            (class_template) @fold.region
            (struct_template) @fold.region
            
            ; Attributes
            (attributes) @fold.region
            
            ; Comments
            (comment) @fold.comment
        `;
        
        const captures = this.service.query(tree.rootNode, queryString);
        const addedRanges = new Set<string>(); // Track unique ranges to avoid duplicates
        
        for (const capture of captures) {
            const node = capture.node;
            
            // Only fold if it spans multiple lines
            if (node.startPosition.row >= node.endPosition.row) {
                continue;
            }
            
            // Create a unique key for this range to avoid duplicates
            const rangeKey = `${node.startPosition.row}:${node.endPosition.row}`;
            if (addedRanges.has(rangeKey)) {
                continue;
            }
            addedRanges.add(rangeKey);
            
            // Determine fold kind based on capture name
            let kind: vscode.FoldingRangeKind | undefined;
            if (capture.name === 'fold.comment') {
                kind = vscode.FoldingRangeKind.Comment;
            } else if (capture.name === 'fold.imports') {
                kind = vscode.FoldingRangeKind.Imports;
            } else {
                kind = vscode.FoldingRangeKind.Region;
            }
            
            ranges.push(new vscode.FoldingRange(
                node.startPosition.row,
                node.endPosition.row,
                kind
            ));
        }
        
        // Also fold consecutive import statements as a group
        this.addImportFolding(tree.rootNode, ranges, addedRanges);
        
        return ranges;
    }
    
    /**
     * Groups consecutive import statements into a single foldable region.
     */
    private addImportFolding(
        root: Parser.SyntaxNode,
        ranges: vscode.FoldingRange[],
        addedRanges: Set<string>
    ): void {
        let importStart: number | undefined;
        let importEnd: number | undefined;
        
        for (const child of root.children) {
            if (child.type === 'import_decl' || child.type === 'import_statement') {
                if (importStart === undefined) {
                    importStart = child.startPosition.row;
                }
                importEnd = child.endPosition.row;
            } else if (importStart !== undefined && importEnd !== undefined) {
                // Non-import node encountered, finalize the import group
                if (importEnd > importStart) {
                    const rangeKey = `${importStart}:${importEnd}`;
                    if (!addedRanges.has(rangeKey)) {
                        addedRanges.add(rangeKey);
                        ranges.push(new vscode.FoldingRange(
                            importStart,
                            importEnd,
                            vscode.FoldingRangeKind.Imports
                        ));
                    }
                }
                importStart = undefined;
                importEnd = undefined;
            }
        }
        
        // Handle trailing import group
        if (importStart !== undefined && importEnd !== undefined && importEnd > importStart) {
            const rangeKey = `${importStart}:${importEnd}`;
            if (!addedRanges.has(rangeKey)) {
                addedRanges.add(rangeKey);
                ranges.push(new vscode.FoldingRange(
                    importStart,
                    importEnd,
                    vscode.FoldingRangeKind.Imports
                ));
            }
        }
    }
}

// Type import for Parser.SyntaxNode
import * as Parser from 'web-tree-sitter';
