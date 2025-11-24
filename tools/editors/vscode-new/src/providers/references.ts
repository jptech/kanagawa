import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from '../service/indexer';

interface ReferenceTarget {
    symbol: SymbolInfo;
    item: CallHierarchyItemData;
}

interface CallHierarchyItemData {
    name: string;
    detail?: string;
    kind: vscode.SymbolKind;
    uri: vscode.Uri;
    range: vscode.Range;
    selectionRange: vscode.Range;
}

interface CallCandidate {
    kind: 'member' | 'free';
    identifier: Parser.SyntaxNode;
    callExpression: Parser.SyntaxNode;
}

function isSameLocation(a: SymbolInfo, b: SymbolInfo): boolean {
    return a.uri.toString() === b.uri.toString() &&
        a.range.start.line === b.range.start.line &&
        a.range.start.character === b.range.start.character &&
        a.range.end.line === b.range.end.line &&
        a.range.end.character === b.range.end.character;
}

function createCallHierarchyItemFromSymbol(info: SymbolInfo): CallHierarchyItemData {
    return {
        name: info.name,
        detail: info.detail,
        kind: info.kind,
        uri: info.uri,
        range: info.range,
        selectionRange: info.range
    };
}

function createCallHierarchyItemFromNode(document: vscode.TextDocument, node: Parser.SyntaxNode): CallHierarchyItemData {
    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'function_definition') {
            const nameNode = current.childForFieldName('name');
            if (nameNode) {
                const range = new vscode.Range(
                    new vscode.Position(current.startPosition.row, current.startPosition.column),
                    new vscode.Position(current.endPosition.row, current.endPosition.column)
                );
                const selection = new vscode.Range(
                    new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                    new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
                );
                return {
                    name: nameNode.text,
                    detail: 'function',
                    kind: vscode.SymbolKind.Function,
                    uri: document.uri,
                    range,
                    selectionRange: selection
                };
            }
        }
        current = current.parent;
    }

    const defaultRange = new vscode.Range(
        new vscode.Position(node.startPosition.row, node.startPosition.column),
        new vscode.Position(node.endPosition.row, node.endPosition.column)
    );
    return {
        name: document.uri.toString(true),
        detail: 'file',
        kind: vscode.SymbolKind.File,
        uri: document.uri,
        range: defaultRange,
        selectionRange: defaultRange
    };
}

export class KanagawaReferencesProvider implements vscode.ReferenceProvider {
    constructor(
        private readonly service: TreeSitterService,
        private readonly indexer: WorkspaceIndexer
    ) {}

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        const tree = this.service.getTree(document);
        if (!tree) { return undefined; }

        const identifier = this.findIdentifierNode(tree, position);
        if (!identifier) { return undefined; }

        const targets = await this.resolveTargets(document, identifier);
        if (!targets.length) { return undefined; }

        const includeDeclaration = context.includeDeclaration ?? false;
        const results: vscode.Location[] = [];
        if (includeDeclaration) {
            for (const target of targets) {
                results.push(new vscode.Location(target.symbol.uri, target.symbol.range));
            }
        }

        const treeForDoc = this.service.getTree(document) ?? this.service.parse(document);
        if (!treeForDoc) { return includeDeclaration ? results : undefined; }
        const references = await this.collectReferencesInDocument(document, treeForDoc, targets, token);
        results.push(...references);

        return results;
    }

    private findIdentifierNode(tree: Parser.Tree, position: vscode.Position): Parser.SyntaxNode | undefined {
        const node = tree.rootNode.descendantForPosition({ row: position.line, column: position.character });
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (current.type === 'identifier' || current.type === 'type_identifier') {
                return current;
            }
            if ((current.type === 'qualified_identifier' || current.type === 'template_instantiation') && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            current = current.parent;
        }
        return undefined;
    }

    private async resolveTargets(document: vscode.TextDocument, identifier: Parser.SyntaxNode): Promise<ReferenceTarget[]> {
        const targets: ReferenceTarget[] = [];

        const memberMatches = await this.indexer.resolveMemberSymbol(document, identifier);
        if (memberMatches && memberMatches.length > 0) {
            for (const symbol of memberMatches) {
                if (symbol.category === 'method' || symbol.category === 'function') {
                    targets.push({ symbol, item: createCallHierarchyItemFromSymbol(symbol) });
                }
            }
        }

        if (!targets.length) {
            const scopePath = this.indexer.getScopePathForNode(identifier);
            const context: SymbolContextHint = { kind: 'free' };
            const resolved = this.indexer.resolveSymbols(identifier.text, scopePath, {
                uri: document.uri,
                context,
                limit: 10
            });
            for (const symbol of resolved) {
                if (symbol.category === 'function' || symbol.category === 'method') {
                    targets.push({ symbol, item: createCallHierarchyItemFromSymbol(symbol) });
                }
            }
        }

        return targets;
    }

    private async collectReferencesInDocument(
        document: vscode.TextDocument,
        tree: Parser.Tree,
        targets: ReferenceTarget[],
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const candidates: CallCandidate[] = [];
        this.collectCallCandidates(tree.rootNode, candidates);
        const locations: vscode.Location[] = [];

        for (const candidate of candidates) {
            if (token.isCancellationRequested) { break; }
            if (candidate.kind === 'member') {
                const definitions = await this.indexer.resolveMemberSymbol(document, candidate.identifier);
                if (!definitions?.length) { continue; }
                for (const target of targets) {
                    if (definitions.some(def => isSameLocation(def, target.symbol))) {
                        locations.push(this.locationFromNode(document, candidate.callExpression));
                        break;
                    }
                }
            } else {
                const scopePath = this.indexer.getScopePathForNode(candidate.identifier);
                const resolved = this.indexer.resolveSymbols(candidate.identifier.text, scopePath, {
                    uri: document.uri,
                    context: { kind: 'free' },
                    limit: 10
                });
                for (const target of targets) {
                    if (resolved.some(def => isSameLocation(def, target.symbol))) {
                        locations.push(this.locationFromNode(document, candidate.callExpression));
                        break;
                    }
                }
            }
        }

        return locations;
    }

    private collectCallCandidates(node: Parser.SyntaxNode, out: CallCandidate[]) {
        if (node.type === 'call_expression') {
            const callee = this.getCalleeNode(node);
            if (callee) {
                if (callee.type === 'member_expression') {
                    const property = callee.namedChild(callee.namedChildCount - 1);
                    if (property && property.type === 'identifier') {
                        out.push({ kind: 'member', identifier: property, callExpression: node });
                    }
                } else {
                    const identifier = this.extractIdentifierNode(callee);
                    if (identifier) {
                        out.push({ kind: 'free', identifier, callExpression: node });
                    }
                }
            }
        }

        for (const child of node.namedChildren) {
            this.collectCallCandidates(child, out);
        }
    }

    private getCalleeNode(callExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        for (const child of callExpression.namedChildren) {
            if (child.type === 'argument_list') { continue; }
            if (child.type === 'call_attributes') { continue; }
            return child;
        }
        return undefined;
    }

    private extractIdentifierNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (current.type === 'identifier' || current.type === 'type_identifier') {
                return current;
            }
            if ((current.type === 'qualified_identifier' || current.type === 'template_instantiation') && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            current = current.parent;
        }
        return undefined;
    }

    private locationFromNode(document: vscode.TextDocument, node: Parser.SyntaxNode): vscode.Location {
        const range = new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column)
        );
        return new vscode.Location(document.uri, range);
    }
}

export class KanagawaCallHierarchyProvider implements vscode.CallHierarchyProvider {
    constructor(
        private readonly service: TreeSitterService,
        private readonly indexer: WorkspaceIndexer
    ) {}

    async prepareCallHierarchy(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.CallHierarchyItem[] | undefined> {
        const referencesProvider = new KanagawaReferencesProvider(this.service, this.indexer);
        const tree = this.service.getTree(document);
        if (!tree) { return undefined; }
        const identifier = referencesProvider['findIdentifierNode'](tree, position);
        if (!identifier) { return undefined; }
        const targets = await referencesProvider['resolveTargets'](document, identifier);
        if (!targets.length) { return undefined; }
        return targets.map(target => this.toCallHierarchyItem(target.item));
    }

    async provideCallHierarchyIncomingCalls(
        item: vscode.CallHierarchyItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CallHierarchyIncomingCall[]> {
        const symbol = await this.lookupSymbolInfo(item);
        if (!symbol) { return []; }
        const referenceProvider = new KanagawaReferencesProvider(this.service, this.indexer);
        const dummyDocument = await vscode.workspace.openTextDocument(symbol.uri);
        const tree = this.service.getTree(dummyDocument) ?? this.service.parse(dummyDocument);
        if (!tree) { return []; }
        const identifier = referenceProvider['findIdentifierNode'](tree, new vscode.Position(symbol.range.start.line, symbol.range.start.character + 1));
        const targets = identifier ? await referenceProvider['resolveTargets'](dummyDocument, identifier) : [{ symbol, item: createCallHierarchyItemFromSymbol(symbol) }];
        const locations = await referenceProvider['collectReferencesInDocument'](dummyDocument, tree, targets, token);
        const grouped = new Map<string, { item: CallHierarchyItemData; ranges: vscode.Range[] }>();

        const allLocations: vscode.Location[] = locations.slice();

        for (const location of allLocations) {
            if (token.isCancellationRequested) { break; }
            const doc = await vscode.workspace.openTextDocument(location.uri);
            const treeForDoc = this.service.getTree(doc) ?? this.service.parse(doc);
            if (!treeForDoc) { continue; }
            const node = treeForDoc.rootNode.descendantForPosition({ row: location.range.start.line, column: location.range.start.character });
            const container = createCallHierarchyItemFromNode(doc, node);
            const key = `${container.uri.toString()}#${container.selectionRange.start.line}:${container.selectionRange.start.character}`;
            if (!grouped.has(key)) {
                grouped.set(key, { item: container, ranges: [] });
            }
            grouped.get(key)!.ranges.push(location.range);
        }

        const result: vscode.CallHierarchyIncomingCall[] = [];
        for (const entry of grouped.values()) {
            result.push({
                from: this.toCallHierarchyItem(entry.item),
                fromRanges: entry.ranges
            });
        }
        return result;
    }

    async provideCallHierarchyOutgoingCalls(
        item: vscode.CallHierarchyItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CallHierarchyOutgoingCall[]> {
        const symbol = await this.lookupSymbolInfo(item);
        if (!symbol) { return []; }

        const doc = await vscode.workspace.openTextDocument(symbol.uri);
        const tree = this.service.getTree(doc) ?? this.service.parse(doc);
        if (!tree) { return []; }

        const bodyNode = this.findBodyNode(tree, symbol.range);
        if (!bodyNode) { return []; }

        const referenceProvider = new KanagawaReferencesProvider(this.service, this.indexer);
        const candidates: CallCandidate[] = [];
        referenceProvider['collectCallCandidates'](bodyNode, candidates);

        const outgoing = new Map<string, { item: vscode.CallHierarchyItem; ranges: vscode.Range[] }>();
        for (const candidate of candidates) {
            if (token.isCancellationRequested) { break; }
            if (candidate.kind === 'member') {
                const defs = await this.indexer.resolveMemberSymbol(doc, candidate.identifier);
                if (defs?.length) {
                    for (const def of defs) {
                        const chi = this.toCallHierarchyItem(createCallHierarchyItemFromSymbol(def));
                        const key = `${chi.uri.toString()}#${chi.selectionRange.start.line}:${chi.selectionRange.start.character}`;
                        if (!outgoing.has(key)) { outgoing.set(key, { item: chi, ranges: [] }); }
                        outgoing.get(key)!.ranges.push(referenceProvider['locationFromNode'](doc, candidate.callExpression).range);
                    }
                }
            } else {
                const scopePath = this.indexer.getScopePathForNode(candidate.identifier);
                const defs = this.indexer.resolveSymbols(candidate.identifier.text, scopePath, {
                    uri: doc.uri,
                    context: { kind: 'free' },
                    limit: 10
                });
                for (const def of defs) {
                    if (def.category !== 'function' && def.category !== 'method') { continue; }
                    const chi = this.toCallHierarchyItem(createCallHierarchyItemFromSymbol(def));
                    const key = `${chi.uri.toString()}#${chi.selectionRange.start.line}:${chi.selectionRange.start.character}`;
                    if (!outgoing.has(key)) { outgoing.set(key, { item: chi, ranges: [] }); }
                    outgoing.get(key)!.ranges.push(referenceProvider['locationFromNode'](doc, candidate.callExpression).range);
                }
            }
        }

        return Array.from(outgoing.values()).map(entry => ({
            to: entry.item,
            fromRanges: entry.ranges
        }));
    }

    private async lookupSymbolInfo(item: vscode.CallHierarchyItem): Promise<SymbolInfo | undefined> {
        const symbols = this.indexer.getAllSymbols();
        return symbols.find(sym =>
            sym.uri.toString() === item.uri.toString() &&
            sym.range.start.line === item.selectionRange.start.line &&
            sym.range.start.character === item.selectionRange.start.character
        );
    }

    private findBodyNode(tree: Parser.Tree, selection: vscode.Range): Parser.SyntaxNode | undefined {
        const node = tree.rootNode.descendantForPosition({ row: selection.start.line, column: selection.start.character });
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (current.type === 'function_definition') {
                const body = current.namedChildren.find(child => child.type === 'block');
                return body ?? current;
            }
            current = current.parent;
        }
        return undefined;
    }

    private toCallHierarchyItem(data: CallHierarchyItemData): vscode.CallHierarchyItem {
        return new vscode.CallHierarchyItem(
            data.kind,
            data.name,
            data.detail ?? '',
            data.uri,
            data.range,
            data.selectionRange
        );
    }
}
