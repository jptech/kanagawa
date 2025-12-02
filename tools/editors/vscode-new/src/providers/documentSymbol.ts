import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { QueryManager } from '../service/query';
import { OutlineFilterManager, snapshotContainsCategory } from '../service/outlineFilters';
import { SymbolCategory } from '../service/indexer';

interface SymbolData {
    name: string;
    kind: vscode.SymbolKind;
    detail: string;
    category: SymbolCategory;
    range: vscode.Range;
    selectionRange: vscode.Range;
    templateParams?: string;
    children: SymbolData[];
}

export class KanagawaDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager,
        private filters: OutlineFilterManager
    ) {}

    async provideDocumentSymbols(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): Promise<vscode.DocumentSymbol[] | undefined> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return undefined; }

        let queryString = this.queryManager.getQuery('outline');
        if (!queryString) {
            queryString = await this.queryManager.loadQuery('outline');
        }

        const captures = this.service.query(tree.rootNode, queryString);
        
        // Build hierarchical symbol tree from captures
        const rootSymbols = this.buildSymbolTree(captures, tree.rootNode);
        
        // Apply filters and convert to VS Code symbols
        const snapshot = this.filters.getFilters();
        return this.filterAndConvertSymbols(rootSymbols, snapshot);
    }

    /**
     * Builds a hierarchical tree of symbols from query captures.
     * Symbols are nested based on their AST relationships.
     */
    private buildSymbolTree(captures: Parser.QueryCapture[], _rootNode: Parser.SyntaxNode): SymbolData[] {
        // First pass: identify definition nodes and their metadata
        const definitionMap = new Map<number, { 
            node: Parser.SyntaxNode;
            kind: vscode.SymbolKind; 
            detail: string; 
            category: SymbolCategory; 
            nameNode?: Parser.SyntaxNode;
        }>();
        
        for (const capture of captures) {
            const node = capture.node;
            const nodeId = node.id;
            
            switch (capture.name) {
                case 'module':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Module, detail: 'module', category: 'module' });
                    break;
                case 'class':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Class, detail: 'class', category: 'class' });
                    break;
                case 'struct':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Struct, detail: 'struct', category: 'struct' });
                    break;
                case 'union':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Struct, detail: 'union', category: 'union' });
                    break;
                case 'enum':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Enum, detail: 'enum', category: 'enum' });
                    break;
                case 'function':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Function, detail: 'function', category: 'function' });
                    break;
                case 'alias':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.TypeParameter, detail: 'type', category: 'alias' });
                    break;
                case 'variable':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Variable, detail: 'variable', category: 'variable' });
                    break;
                case 'member':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.Field, detail: 'field', category: 'member' });
                    break;
                case 'constant':
                    definitionMap.set(nodeId, { node, kind: vscode.SymbolKind.EnumMember, detail: 'constant', category: 'constant' });
                    break;
                    
                // Name captures - associate with parent definition
                case 'name': {
                    let parent = capture.node.parent;
                    while (parent) {
                        const def = definitionMap.get(parent.id);
                        if (def) {
                            def.nameNode = capture.node;
                            break;
                        }
                        parent = parent.parent;
                    }
                    break;
                }
            }
        }
        
        // Second pass: build tree structure by finding parent-child relationships
        const symbolDataMap = new Map<number, SymbolData>();
        const rootSymbols: SymbolData[] = [];
        
        for (const [nodeId, info] of definitionMap.entries()) {
            if (!info.nameNode) { continue; }
            
            const templateParams = this.extractTemplateParameters(info.node);
            const displayName = templateParams 
                ? `${info.nameNode.text}<${templateParams}>`
                : info.nameNode.text;
            
            const symbolData: SymbolData = {
                name: displayName,
                kind: info.kind,
                detail: info.detail,
                category: info.category,
                range: new vscode.Range(
                    new vscode.Position(info.node.startPosition.row, info.node.startPosition.column),
                    new vscode.Position(info.node.endPosition.row, info.node.endPosition.column)
                ),
                selectionRange: new vscode.Range(
                    new vscode.Position(info.nameNode.startPosition.row, info.nameNode.startPosition.column),
                    new vscode.Position(info.nameNode.endPosition.row, info.nameNode.endPosition.column)
                ),
                templateParams,
                children: []
            };
            
            symbolDataMap.set(nodeId, symbolData);
        }
        
        // Build parent-child relationships
        for (const [nodeId, info] of definitionMap.entries()) {
            const symbolData = symbolDataMap.get(nodeId);
            if (!symbolData) { continue; }
            
            // Find parent definition
            let parentNode = info.node.parent;
            let parentSymbol: SymbolData | undefined;
            
            while (parentNode) {
                parentSymbol = symbolDataMap.get(parentNode.id);
                if (parentSymbol) {
                    break;
                }
                parentNode = parentNode.parent;
            }
            
            if (parentSymbol) {
                parentSymbol.children.push(symbolData);
            } else {
                rootSymbols.push(symbolData);
            }
        }
        
        // Sort children by position
        const sortByPosition = (a: SymbolData, b: SymbolData) => 
            a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
        
        const sortRecursively = (symbols: SymbolData[]) => {
            symbols.sort(sortByPosition);
            for (const s of symbols) {
                sortRecursively(s.children);
            }
        };
        
        sortRecursively(rootSymbols);
        
        return rootSymbols;
    }

    /**
     * Extracts template parameters from a definition node.
     * Handles template wrappers (class_template, function_template, etc.)
     * Returns string like "T, N" or undefined if not a template.
     * 
     * IMPORTANT: Only returns template params if this node is the DIRECT
     * definition inside the template wrapper. Nested symbols (like members
     * inside a template class) should NOT get the class's template params.
     */
    private extractTemplateParameters(node: Parser.SyntaxNode): string | undefined {
        // Check if node is wrapped in a template
        const parent = node.parent;
        if (!parent) { return undefined; }
        
        const templateWrappers = [
            'class_template', 'struct_template', 'union_template',
            'function_template', 'alias_template', 'enum_template'
        ];
        
        let templateNode: Parser.SyntaxNode | undefined;
        
        // Only consider immediate parent or grandparent as template wrapper
        // The node must be the primary definition of the template, not a nested member
        if (templateWrappers.includes(parent.type)) {
            // node is direct child of template wrapper
            templateNode = parent;
        } else if (parent.parent && templateWrappers.includes(parent.parent.type)) {
            // node is grandchild (e.g., class_decl inside class_template)
            // But we need to verify this node is THE definition, not a member inside it
            // Check that there's no class/struct body between us and the template
            if (!this.isNestedInsideClassBody(node, parent.parent)) {
                templateNode = parent.parent;
            }
        }
        
        if (!templateNode) { return undefined; }
        
        // Find template_params node
        const paramsNode = templateNode.children.find(c => c.type === 'template_params');
        if (!paramsNode) { return undefined; }
        
        // Extract parameter names
        const paramNames: string[] = [];
        for (const child of paramsNode.namedChildren) {
            if (child.type === 'template_param') {
                const nameNode = child.children.find(c => c.type === 'identifier');
                if (nameNode) {
                    paramNames.push(nameNode.text);
                }
            }
        }
        
        return paramNames.length > 0 ? paramNames.join(', ') : undefined;
    }

    /**
     * Checks if a node is nested inside a class/struct body (member_decl_list).
     * Used to prevent attaching template params to nested members.
     */
    private isNestedInsideClassBody(node: Parser.SyntaxNode, templateNode: Parser.SyntaxNode): boolean {
        let current: Parser.SyntaxNode | null = node.parent;
        while (current && current !== templateNode) {
            // If we hit a member list or block before reaching the template, 
            // this node is a nested member, not the primary definition
            if (current.type === 'member_decl_list' || 
                current.type === 'class_body' || 
                current.type === 'struct_body' ||
                current.type === 'block') {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    /**
     * Filters symbols by category and module prefix, then converts to VS Code DocumentSymbol.
     */
    private filterAndConvertSymbols(
        symbols: SymbolData[],
        snapshot: ReturnType<OutlineFilterManager['getFilters']>
    ): vscode.DocumentSymbol[] {
        const result: vscode.DocumentSymbol[] = [];
        
        for (const symbol of symbols) {
            // Check category filter
            if (!snapshotContainsCategory(snapshot, symbol.category)) {
                // Even if filtered, process children in case they match
                const childSymbols = this.filterAndConvertSymbols(symbol.children, snapshot);
                result.push(...childSymbols);
                continue;
            }
            
            // Convert to VS Code DocumentSymbol
            const vsSymbol = new vscode.DocumentSymbol(
                symbol.name,
                symbol.detail,
                symbol.kind,
                symbol.range,
                symbol.selectionRange
            );
            
            // Process children recursively
            vsSymbol.children = this.filterAndConvertSymbols(symbol.children, snapshot);
            
            result.push(vsSymbol);
        }
        
        return result;
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
