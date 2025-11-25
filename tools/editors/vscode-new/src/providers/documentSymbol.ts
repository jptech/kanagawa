import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { QueryManager } from '../service/query';
import { OutlineFilterManager, snapshotContainsCategory, snapshotMatchesPrefix } from '../service/outlineFilters';
import { SymbolCategory } from '../service/indexer';

export class KanagawaDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager,
        private filters: OutlineFilterManager
    ) {}

    async provideDocumentSymbols(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentSymbol[] | undefined> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return undefined; }

        let queryString = this.queryManager.getQuery('outline');
        if (!queryString) {
            queryString = await this.queryManager.loadQuery('outline');
        }

        const captures = this.service.query(tree.rootNode, queryString);
        const symbols: vscode.DocumentSymbol[] = [];

        // This is a flat list. For a tree structure, we need to handle nesting.
        // Tree-sitter captures are flat.
        // A simple approach is to create symbols and then treeify them based on ranges,
        // or just return a flat list if the UI handles it (VS Code prefers tree).
        
        // For simplicity in this version, we return a flat list (VS Code will show them, but not nested).
        // To do nesting, we would need to check parent-child relationships.

        // Group captures by definition node
        const definitionMap = new Map<Parser.SyntaxNode, { kind: vscode.SymbolKind; detail: string; category: SymbolCategory; nameNode?: Parser.SyntaxNode }>();
        
        for (const capture of captures) {
            const node = capture.node;
            
            switch (capture.name) {
                case 'module':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Module, detail: 'module', category: 'module' });
                    break;
                case 'class':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Class, detail: 'class', category: 'class' });
                    break;
                case 'struct':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Struct, detail: 'struct', category: 'struct' });
                    break;
                case 'union':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Struct, detail: 'union', category: 'union' });
                    break;
                case 'enum':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Enum, detail: 'enum', category: 'enum' });
                    break;
                case 'function':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Function, detail: 'function', category: 'function' });
                    break;
                case 'alias':
                    definitionMap.set(node, { kind: vscode.SymbolKind.TypeParameter, detail: 'type', category: 'alias' });
                    break;
                case 'variable':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Variable, detail: 'variable', category: 'variable' });
                    break;
                case 'member':
                    definitionMap.set(node, { kind: vscode.SymbolKind.Field, detail: 'field', category: 'member' });
                    break;
                case 'constant':
                    definitionMap.set(node, { kind: vscode.SymbolKind.EnumMember, detail: 'constant', category: 'constant' });
                    break;
                    
                // Name captures
                case 'name': {
                    // Find the parent definition
                    let parent = node.parent;
                    while (parent) {
                        if (definitionMap.has(parent)) {
                            definitionMap.get(parent)!.nameNode = node;
                            break;
                        }
                        parent = parent.parent;
                    }
                    break;
                }
            }
        }
        
        // Create symbols from the definition map
        const snapshot = this.filters.getFilters();

        for (const [defNode, info] of definitionMap.entries()) {
            if (!info.nameNode) { continue; }

            if (!snapshotContainsCategory(snapshot, info.category)) {
                continue;
            }

            const modulePath = this.computeModulePath(defNode);
            if (!snapshotMatchesPrefix(snapshot, modulePath)) {
                continue;
            }
            
            const name = info.nameNode.text;
            const range = new vscode.Range(
                new vscode.Position(defNode.startPosition.row, defNode.startPosition.column),
                new vscode.Position(defNode.endPosition.row, defNode.endPosition.column)
            );
            const selectionRange = new vscode.Range(
                new vscode.Position(info.nameNode.startPosition.row, info.nameNode.startPosition.column),
                new vscode.Position(info.nameNode.endPosition.row, info.nameNode.endPosition.column)
            );

            symbols.push(new vscode.DocumentSymbol(
                name,
                info.detail,
                info.kind,
                range,
                selectionRange
            ));
        }

        return symbols;
    }

    private computeModulePath(node: Parser.SyntaxNode): string | undefined {
        const segments: string[] = [];
        let current: Parser.SyntaxNode | null = node.parent;
        while (current) {
            if (current.type === 'module_decl') {
                const nameNode = current.childForFieldName('name');
                if (nameNode) {
                    segments.unshift(nameNode.text);
                }
            }
            current = current.parent;
        }
        return segments.length > 0 ? segments.join('.') : undefined;
    }
}
