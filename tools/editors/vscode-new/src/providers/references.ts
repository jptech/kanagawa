import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from '../service/indexer';
import { findIdentifierNode, nodeToRange, resolveToIdentifier } from '../utils/nodeUtils';
import { OPERATION_TIMEOUTS, withTimeout, withProviderGuard } from '../utils/timeout';
import { healthMonitor } from '../service/healthMonitor';

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
        // Wrap entire references operation with provider guard for timeout + cancellation protection
        return withProviderGuard(
            {
                operation: 'references',
                timeoutMs: OPERATION_TIMEOUTS.REFERENCES,
                token,
                onSuccess: () => healthMonitor.recordSuccess('references'),
                onFailure: (error) => healthMonitor.recordFailure('references', error)
            },
            async () => {
                const tree = this.service.getTree(document) ?? await this.service.parse(document);
                if (!tree) { return undefined; }

                const identifier = findIdentifierNode(tree, position);
                if (!identifier) { return undefined; }

                const targets = await this.resolveTargets(document, identifier);
                if (!targets.length) { 
                    // Fall back to simple text search for non-indexed symbols
                    return await this.findReferencesWorkspaceWide(identifier.text, context.includeDeclaration, token);
                }

                const includeDeclaration = context.includeDeclaration ?? false;
                const results: vscode.Location[] = [];
                
                // Include declarations
                if (includeDeclaration) {
                    for (const target of targets) {
                        results.push(new vscode.Location(target.symbol.uri, target.symbol.range));
                    }
                }

                // Use reverse index to find only files containing this symbol name
                // This is O(relevant_files) instead of O(all_files)
                const symbolName = identifier.text;
                const candidateUriStrings = this.indexer.getUrisContainingSymbol(symbolName);
                
                // Also check all indexed URIs if the symbol wasn't in the reverse index
                // (covers cases where the identifier appears but isn't a definition)
                const allIndexedUris = this.indexer.getIndexedUris();
                
                // Start with files known to have this symbol, then check others
                const priorityUris: vscode.Uri[] = [];
                const otherUris: vscode.Uri[] = [];
                
                for (const uri of allIndexedUris) {
                    if (candidateUriStrings.has(uri.toString())) {
                        priorityUris.push(uri);
                    } else {
                        otherUris.push(uri);
                    }
                }
                
                // Search priority URIs first (likely to have references)
                for (const uri of priorityUris) {
                    if (token.isCancellationRequested) { break; }
                    
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const treeForDoc = this.service.getTree(doc) ?? await this.service.parse(doc);
                        if (!treeForDoc) { continue; }
                        
                        const references = await this.collectReferencesInDocument(doc, treeForDoc, targets, token);
                        results.push(...references);
                    } catch (e) {
                        // Ignore files that can't be opened
                    }
                }
                
                // Search other URIs (may have usages even if not in reverse index)
                for (const uri of otherUris) {
                    if (token.isCancellationRequested) { break; }
                    
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const treeForDoc = this.service.getTree(doc) ?? await this.service.parse(doc);
                        if (!treeForDoc) { continue; }
                        
                        const references = await this.collectReferencesInDocument(doc, treeForDoc, targets, token);
                        results.push(...references);
                    } catch (e) {
                        // Ignore files that can't be opened
                    }
                }

                // Deduplicate results
                return this.deduplicateLocations(results);
            }
        );
    }

    /**
     * Simple workspace-wide text search for symbols that couldn't be resolved.
     */
    private async findReferencesWorkspaceWide(
        name: string,
        includeDeclaration: boolean,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const results: vscode.Location[] = [];
        const indexedUris = this.indexer.getIndexedUris();
        
        // Also search for declarations if requested
        if (includeDeclaration) {
            const symbols = this.indexer.getSymbols(name);
            if (symbols) {
                for (const sym of symbols) {
                    results.push(new vscode.Location(sym.uri, sym.range));
                }
            }
        }
        
        // Search all files for identifier usages
        for (const uri of indexedUris) {
            if (token.isCancellationRequested) { break; }
            
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const tree = this.service.getTree(doc) ?? await this.service.parse(doc);
                if (!tree) { continue; }
                
                // Find all identifier nodes matching the name
                const matches = this.findIdentifierMatches(tree.rootNode, name);
                for (const node of matches) {
                    results.push(new vscode.Location(uri, nodeToRange(node)));
                }
            } catch (e) {
                // Ignore files that can't be opened
            }
        }
        
        return this.deduplicateLocations(results);
    }

    /**
     * Finds all identifier nodes in the AST that match the given name.
     */
    private findIdentifierMatches(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode[] {
        const matches: Parser.SyntaxNode[] = [];
        
        const visit = (node: Parser.SyntaxNode) => {
            if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text === name) {
                matches.push(node);
            }
            for (const child of node.children) {
                visit(child);
            }
        };
        
        visit(root);
        return matches;
    }

    /**
     * Removes duplicate locations from the results.
     */
    private deduplicateLocations(locations: vscode.Location[]): vscode.Location[] {
        const seen = new Set<string>();
        const unique: vscode.Location[] = [];
        
        for (const loc of locations) {
            const key = `${loc.uri.toString()}:${loc.range.start.line}:${loc.range.start.character}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(loc);
            }
        }
        
        return unique;
    }

    private async resolveTargets(document: vscode.TextDocument, identifier: Parser.SyntaxNode): Promise<ReferenceTarget[]> {
        const targets: ReferenceTarget[] = [];

        const memberMatches = await withTimeout(
            'references member resolution',
            this.indexer.resolveMemberSymbol(document, identifier),
            OPERATION_TIMEOUTS.REFERENCES
        );
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
            // Use resolveWithContext for consistency with hover/definition
            const resolution = this.indexer.resolveWithContext(identifier.text, scopePath, {
                uri: document.uri,
                context
            });
            
            // Collect primary and alternatives
            const allCandidates: SymbolInfo[] = [];
            if (resolution.primary) {
                allCandidates.push(resolution.primary);
            }
            allCandidates.push(...resolution.alternatives);
            
            for (const symbol of allCandidates) {
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
                const definitions = await withTimeout(
                    'references collect member resolution',
                    this.indexer.resolveMemberSymbol(document, candidate.identifier),
                    OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                );
                if (!definitions?.length) { continue; }
                for (const target of targets) {
                    if (definitions.some(def => isSameLocation(def, target.symbol))) {
                        locations.push(this.locationFromNode(document, candidate.callExpression));
                        break;
                    }
                }
            } else {
                const scopePath = this.indexer.getScopePathForNode(candidate.identifier);
                // Use resolveWithContext for consistency with hover/definition
                const resolution = this.indexer.resolveWithContext(candidate.identifier.text, scopePath, {
                    uri: document.uri,
                    context: { kind: 'free' }
                });
                
                // Collect all resolved symbols
                const resolved: SymbolInfo[] = [];
                if (resolution.primary) {
                    resolved.push(resolution.primary);
                }
                resolved.push(...resolution.alternatives);
                
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
                    const identifier = resolveToIdentifier(callee);
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

    private locationFromNode(document: vscode.TextDocument, node: Parser.SyntaxNode): vscode.Location {
        return new vscode.Location(document.uri, nodeToRange(node));
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
        _token: vscode.CancellationToken
    ): Promise<vscode.CallHierarchyItem[] | undefined> {
        try {
            const referencesProvider = new KanagawaReferencesProvider(this.service, this.indexer);
            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) { return undefined; }
            const identifier = findIdentifierNode(tree, position);
            if (!identifier) { return undefined; }
            const targets = await referencesProvider['resolveTargets'](document, identifier);
            if (!targets.length) { return undefined; }
            healthMonitor.recordSuccess('callHierarchy');
            return targets.map(target => this.toCallHierarchyItem(target.item));
        } catch (error) {
            healthMonitor.recordFailure('callHierarchy', error);
            console.error('[CallHierarchyProvider] prepareCallHierarchy error:', error);
            return undefined;
        }
    }

    async provideCallHierarchyIncomingCalls(
        item: vscode.CallHierarchyItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CallHierarchyIncomingCall[]> {
        try {
            const symbol = await this.lookupSymbolInfo(item);
            if (!symbol) { return []; }
        const referenceProvider = new KanagawaReferencesProvider(this.service, this.indexer);
        const dummyDocument = await vscode.workspace.openTextDocument(symbol.uri);
        const tree = this.service.getTree(dummyDocument) ?? await this.service.parse(dummyDocument);
        if (!tree) { return []; }
        const identifier = findIdentifierNode(tree, new vscode.Position(symbol.range.start.line, symbol.range.start.character + 1));
        const targets = identifier ? await referenceProvider['resolveTargets'](dummyDocument, identifier) : [{ symbol, item: createCallHierarchyItemFromSymbol(symbol) }];
        const locations = await referenceProvider['collectReferencesInDocument'](dummyDocument, tree, targets, token);
        const grouped = new Map<string, { item: CallHierarchyItemData; ranges: vscode.Range[] }>();

        const allLocations: vscode.Location[] = locations.slice();

        for (const location of allLocations) {
            if (token.isCancellationRequested) { break; }
            try {
                const doc = await vscode.workspace.openTextDocument(location.uri);
                const treeForDoc = this.service.getTree(doc) ?? await this.service.parse(doc);
                if (!treeForDoc) { continue; }
                const node = treeForDoc.rootNode.descendantForPosition({ row: location.range.start.line, column: location.range.start.character });
                const container = createCallHierarchyItemFromNode(doc, node);
                const key = `${container.uri.toString()}#${container.selectionRange.start.line}:${container.selectionRange.start.character}`;
                if (!grouped.has(key)) {
                    grouped.set(key, { item: container, ranges: [] });
                }
                grouped.get(key)!.ranges.push(location.range);
            } catch (e) {
                // File may have been deleted or moved - skip it
            }
        }

        const result: vscode.CallHierarchyIncomingCall[] = [];
        for (const entry of grouped.values()) {
            result.push({
                from: this.toCallHierarchyItem(entry.item),
                fromRanges: entry.ranges
            });
        }
            return result;
        } catch (error) {
            healthMonitor.recordFailure('callHierarchy', error);
            console.error('[CallHierarchyProvider] provideCallHierarchyIncomingCalls error:', error);
            return [];
        }
    }

    async provideCallHierarchyOutgoingCalls(
        item: vscode.CallHierarchyItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CallHierarchyOutgoingCall[]> {
        try {
            const symbol = await this.lookupSymbolInfo(item);
            if (!symbol) { return []; }

        const doc = await vscode.workspace.openTextDocument(symbol.uri);
        const tree = this.service.getTree(doc) ?? await this.service.parse(doc);
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
                const defs = await withTimeout(
                    'call hierarchy member resolution',
                    this.indexer.resolveMemberSymbol(doc, candidate.identifier),
                    OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                );
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
                // Use resolveWithContext for consistency with hover/definition
                const resolution = this.indexer.resolveWithContext(candidate.identifier.text, scopePath, {
                    uri: doc.uri,
                    context: { kind: 'free' }
                });
                
                // Collect all resolved symbols
                const defs: SymbolInfo[] = [];
                if (resolution.primary) {
                    defs.push(resolution.primary);
                }
                defs.push(...resolution.alternatives);
                
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
        } catch (error) {
            healthMonitor.recordFailure('callHierarchy', error);
            console.error('[CallHierarchyProvider] provideCallHierarchyOutgoingCalls error:', error);
            return [];
        }
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
