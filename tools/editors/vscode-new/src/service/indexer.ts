import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from './treeSitter';
import { QueryManager } from './query';

export type SymbolCategory =
    | 'module'
    | 'class'
    | 'struct'
    | 'union'
    | 'enum'
    | 'function'
    | 'method'
    | 'variable'
    | 'member'
    | 'constant'
    | 'alias'
    | 'other';

export interface DocumentImport {
    path: string;
    alias?: string;
}

export interface DocumentContext {
    modulePath?: string;
    imports: DocumentImport[];
}

export type SymbolContextHint =
    | { kind: 'method'; receiverType?: string }
    | { kind: 'free' }
    | { kind: 'unknown' };

export interface ResolveOptions {
    uri?: vscode.Uri;
    context?: SymbolContextHint;
    limit?: number;
}

export interface SymbolInfo {
    name: string;
    uri: vscode.Uri;
    range: vscode.Range;
    kind: vscode.SymbolKind;
    detail?: string;
    docMarkdown?: string;
    signature?: string;
    scopePath: string[];
    category: SymbolCategory;
    typeHint?: string;
}

export class WorkspaceIndexer {
    private symbolIndex: Map<string, SymbolInfo[]> = new Map();
    private isIndexing = false;
    private documentContexts: Map<string, DocumentContext> = new Map();
    private readonly templateWrappers = new Set<string>([
        'function_template',
        'class_template',
        'struct_template',
        'union_template',
        'alias_template',
        'enum_template'
    ]);

    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager
    ) {}

    async scanWorkspace() {
        if (this.isIndexing) { return; }
        this.isIndexing = true;
        this.symbolIndex.clear();
        this.documentContexts.clear();

        // Ensure query is loaded and cached inside the query manager
        const queryString = await this.queryManager.loadQuery('definitions');
        if (!queryString) {
            console.error('Kanagawa: Unable to load definitions query.');
            this.isIndexing = false;
            return;
        }

        const files = await vscode.workspace.findFiles('**/*.k', '**/node_modules/**');
        
        // Process in chunks to avoid blocking UI
        const chunkSize = 10;
        for (let i = 0; i < files.length; i += chunkSize) {
            const chunk = files.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async uri => {
                await this.indexFile(uri, queryString);
            }));
            // Yield to event loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        this.isIndexing = false;
        console.log(`Kanagawa: Indexed ${this.symbolIndex.size} symbols from ${files.length} files.`);
    }

    async indexFile(uri: vscode.Uri, queryString?: string) {
        try {
            // console.log('Kanagawa: Indexing file:', uri.toString());
            const document = await vscode.workspace.openTextDocument(uri);
            const tree = this.service.parse(document);
            if (!tree) { 
                console.warn('Kanagawa: No tree for file:', uri.toString());
                return; 
            }

            if (!queryString) {
                const loaded = await this.queryManager.loadQuery('definitions');
                if (!loaded) {
                    console.error('Kanagawa: Definitions query not loaded.');
                    return;
                }
                queryString = loaded;
            }

            const symbols = this.extractSymbols(document, tree, queryString, uri);
            const context = this.collectDocumentContext(tree.rootNode);
            this.documentContexts.set(uri.toString(), context);
            this.addSymbols(symbols);
        } catch (e) {
            console.error(`Failed to index ${uri.toString()}:`, e);
        }
    }
    
    private findCaptureByName(
        captures: Parser.QueryCapture[],
        name: string,
        parentNode: Parser.SyntaxNode
    ): Parser.SyntaxNode | null {
        for (const capture of captures) {
            if (capture.name !== name) { continue; }

            // Fast path: check by range containment first. This avoids relying on
            // object identity for SyntaxNode wrappers, which are not stable across
            // repeated lookups when using the WASM bindings.
            if (capture.node.startIndex >= parentNode.startIndex && capture.node.endIndex <= parentNode.endIndex) {
                return capture.node;
            }

            // Fallback to ancestor walk for completeness (handles overlapping
            // captures such as templates where the identifier is nested under a
            // function definition which itself sits beneath the template node).
            let node: Parser.SyntaxNode | null = capture.node;
            while (node) {
                if (node.id === parentNode.id) { // Compare by node id to avoid wrapper inequality
                    return capture.node;
                }
                node = node.parent;
            }
        }
        return null;
    }

    private extractSymbols(
        document: vscode.TextDocument,
        tree: Parser.Tree,
        queryString: string,
        uri: vscode.Uri
    ): SymbolInfo[] {
        const captures = this.service.query(tree.rootNode, queryString);
        if (!captures.length) { return []; }

        const { preDocs, postDocs } = this.prepareDocCommentMaps(captures);
        const processedNodes = new Set<number>();
        const symbols: SymbolInfo[] = [];

        for (const capture of captures) {
            if (capture.name === 'doc.comment') { continue; }
            const nodeId = capture.node.id;
            if (processedNodes.has(nodeId)) { continue; }

            let kind = vscode.SymbolKind.Variable;
            let label = '';
            let nameCapture = '';
            let category: SymbolCategory = 'other';
            let typeHint: string | undefined;

            switch (capture.name) {
                case 'module':
                    kind = vscode.SymbolKind.Module;
                    label = 'module';
                    nameCapture = 'module.name';
                    category = 'module';
                    break;
                case 'class':
                    kind = vscode.SymbolKind.Class;
                    label = 'class';
                    nameCapture = 'class.name';
                    category = 'class';
                    break;
                case 'struct':
                    kind = vscode.SymbolKind.Struct;
                    label = 'struct';
                    nameCapture = 'struct.name';
                    category = 'struct';
                    break;
                case 'union':
                    kind = vscode.SymbolKind.Struct;
                    label = 'union';
                    nameCapture = 'union.name';
                    category = 'union';
                    break;
                case 'enum':
                    kind = vscode.SymbolKind.Enum;
                    label = 'enum';
                    nameCapture = 'enum.name';
                    category = 'enum';
                    break;
                case 'function':
                    kind = vscode.SymbolKind.Function;
                    label = 'function';
                    nameCapture = 'function.name';
                    category = this.isMethod(capture.node) ? 'method' : 'function';
                    break;
                case 'alias':
                    kind = vscode.SymbolKind.TypeParameter;
                    label = 'type alias';
                    nameCapture = 'alias.name';
                    category = 'alias';
                    break;
                case 'variable':
                    kind = vscode.SymbolKind.Variable;
                    label = 'variable';
                    nameCapture = 'variable.name';
                    category = 'variable';
                    typeHint = this.extractTypeHint(capture.node);
                    break;
                case 'member':
                    kind = vscode.SymbolKind.Field;
                    label = 'member';
                    nameCapture = 'member.name';
                    category = 'member';
                    typeHint = this.extractTypeHint(capture.node);
                    break;
                case 'constant':
                    kind = vscode.SymbolKind.EnumMember;
                    label = 'constant';
                    nameCapture = 'constant.name';
                    category = 'constant';
                    break;
                default:
                    continue;
            }

            const nameNode = this.findCaptureByName(captures, nameCapture, capture.node);
            if (!nameNode) { continue; }

            const range = new vscode.Range(
                new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
            );

            const docMarkdown = this.collectDocBlock(capture.node, preDocs, postDocs);
            let signature = this.buildSignature(document, capture.name, capture.node, nameNode);
            if (signature && signature.length > 180) {
                signature = signature.slice(0, 177) + '…';
            }

            const scopePath = this.buildScopePath(capture.node);

            symbols.push({
                name: nameNode.text,
                uri,
                range,
                kind,
                detail: label,
                docMarkdown,
                signature,
                scopePath,
                category,
                typeHint
            });

            processedNodes.add(nodeId);
        }

        return symbols;
    }

    private addSymbols(symbols: SymbolInfo[]) {
        for (const info of symbols) {
            const list = this.symbolIndex.get(info.name) ?? [];
            list.push(info);
            this.symbolIndex.set(info.name, list);
        }
    }

    private collectDocumentContext(root: Parser.SyntaxNode): DocumentContext {
        const context: DocumentContext = { imports: [] };

        for (const child of root.namedChildren) {
            if (!context.modulePath && child.type === 'module_decl') {
                const nameNode = child.childForFieldName('name');
                if (nameNode) {
                    context.modulePath = nameNode.text;
                }
            }

            if (child.type === 'import_decl') {
                const pathNode = child.childForFieldName('path');
                if (!pathNode) { continue; }
                const aliasNode = child.childForFieldName('alias');
                context.imports.push({
                    path: pathNode.text,
                    alias: aliasNode ? aliasNode.text : undefined
                });
            }
        }

        return context;
    }

    private removeSymbolsForUri(uri: vscode.Uri) {
        const target = uri.toString();
        for (const [key, list] of this.symbolIndex.entries()) {
            const filtered = list.filter(entry => entry.uri.toString() !== target);
            if (filtered.length === 0) {
                this.symbolIndex.delete(key);
            } else if (filtered.length !== list.length) {
                this.symbolIndex.set(key, filtered);
            }
        }
        this.documentContexts.delete(target);
    }

    private isMethod(node: Parser.SyntaxNode): boolean {
        let current: Parser.SyntaxNode | null = node.parent;
        while (current) {
            if (current.type === 'member_decl') {
                return true;
            }
            if (current.type === 'class_decl' || current.type === 'struct_decl' || current.type === 'union_decl') {
                return true;
            }
            if (current.type === 'module_decl' || current.type === 'source_file') {
                return false;
            }
            current = current.parent;
        }
        return false;
    }

    private extractTypeHint(node: Parser.SyntaxNode): string | undefined {
        const typeNode = this.findTypeNode(node);
        return typeNode ? typeNode.text.trim() : undefined;
    }

    private findTypeNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
        const typeField = node.childForFieldName('type');
        if (typeField) { return typeField; }

        for (const child of node.namedChildren) {
            const nested = this.findTypeNode(child);
            if (nested) { return nested; }
        }

        return null;
    }

    private prepareDocCommentMaps(captures: Parser.QueryCapture[]) {
        const preDocs = new Map<number, string>();
        const postDocs = new Map<number, string>();

        for (const capture of captures) {
            if (capture.name !== 'doc.comment') { continue; }
            const text = capture.node.text;
            if (text.startsWith('//|')) {
                preDocs.set(capture.node.startPosition.row, this.cleanDocComment(text));
            } else if (text.startsWith('//<')) {
                postDocs.set(capture.node.startPosition.row, this.cleanDocComment(text));
            }
        }

        return { preDocs, postDocs };
    }

    private collectDocBlock(
        node: Parser.SyntaxNode,
        preDocs: Map<number, string>,
        postDocs: Map<number, string>
    ): string | undefined {
        const lines: string[] = [];
        const anchor = this.getDocAnchorNode(node);

        let line = anchor.startPosition.row - 1;
        while (preDocs.has(line)) {
            lines.unshift(preDocs.get(line)!);
            line--;
        }

        line = node.endPosition.row;
        while (postDocs.has(line)) {
            lines.push(postDocs.get(line)!);
            line++;
        }

        if (!lines.length) { return undefined; }
        return lines.join('\n');
    }

    private cleanDocComment(raw: string): string {
        return raw.slice(3).trim();
    }

    private buildSignature(
        document: vscode.TextDocument,
        captureName: string,
        defNode: Parser.SyntaxNode,
        nameNode: Parser.SyntaxNode
    ): string | undefined {
        const anchor = this.getDocAnchorNode(defNode);
        const start = new vscode.Position(anchor.startPosition.row, anchor.startPosition.column);
        let end = new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column);

        if (captureName === 'function') {
            const params = defNode.childForFieldName('parameters');
            if (params) {
                end = new vscode.Position(params.endPosition.row, params.endPosition.column);
            }
        } else if (captureName === 'variable' || captureName === 'member') {
            const initializer = defNode.childForFieldName('initializer');
            if (initializer) {
                end = new vscode.Position(initializer.endPosition.row, initializer.endPosition.column);
            }
        }

        const text = document.getText(new vscode.Range(start, end)).trim();
        if (!text) { return undefined; }
        return text.replace(/\s+/g, ' ');
    }

    private getDocAnchorNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
        let anchor: Parser.SyntaxNode = node;
        while (anchor.parent && this.templateWrappers.has(anchor.parent.type)) {
            anchor = anchor.parent;
        }
        return anchor;
    }

    private buildScopePath(node: Parser.SyntaxNode): string[] {
        const anchor = this.getDocAnchorNode(node);
        return this.collectScopePath(anchor.parent);
    }

    private collectScopePath(start: Parser.SyntaxNode | null): string[] {
        const segments: string[] = [];
        let current = start;

        while (current) {
            const container = this.resolveContainerName(current);
            if (container) {
                segments.unshift(container);
            }
            current = current.parent;
        }

        return segments;
    }

    private resolveContainerName(node: Parser.SyntaxNode): string | undefined {
        switch (node.type) {
            case 'module_decl':
            case 'class_decl':
            case 'struct_decl':
            case 'union_decl':
            case 'enum_decl':
                return this.extractNodeName(node);
            case 'class_template':
            case 'struct_template':
            case 'union_template':
            case 'function_template':
            case 'alias_template':
            case 'enum_template':
                // Skip template wrapper; actual declarations handled by children.
                return undefined;
            default:
                return undefined;
        }
    }

    private extractNodeName(node: Parser.SyntaxNode): string | undefined {
        const field = node.childForFieldName('name');
        if (field) {
            return field.text;
        }

        for (const child of node.namedChildren) {
            if (child.type === 'identifier' || child.type === 'module_name') {
                return child.text;
            }
        }

        return undefined;
    }

    public getScopePathForNode(node: Parser.SyntaxNode): string[] {
        return this.collectScopePath(node.parent);
    }

    public resolveSymbols(name: string, scopePath: string[], options?: ResolveOptions): SymbolInfo[] {
        const candidates = this.symbolIndex.get(name) ?? [];
        if (candidates.length === 0) { return []; }

        const limit = options?.limit ?? 5;
        const uriString = options?.uri?.toString();

        const exactScope = candidates.filter(info => this.pathsEqual(info.scopePath, scopePath));
        if (exactScope.length > 0) {
            return this.sortCandidatesWithScore(exactScope, scopePath, options).slice(0, limit);
        }

        const sameFile = uriString ? candidates.filter(info => info.uri.toString() === uriString) : [];
        if (sameFile.length > 0) {
            return this.sortCandidatesWithScore(sameFile, scopePath, options).slice(0, limit);
        }

        const scoredAll = this.scoreCandidates(candidates, scopePath, options).sort((a, b) => b.score - a.score);
        if (scoredAll.length === 0) { return []; }

        const bestScore = scoredAll[0].score;
        const filtered = scoredAll.filter(entry => entry.score > 0 && entry.score >= bestScore - 10);
        const preferred = (filtered.length > 0 ? filtered : scoredAll).map(entry => entry.info);
        return preferred.slice(0, limit);
    }

    private computeScopeSimilarity(target: string[], candidate: string[]): number {
        if (target.length === 0 && candidate.length === 0) {
            return 10;
        }

        let reverseScore = 0;
        const minTail = Math.min(target.length, candidate.length);
        for (let i = 1; i <= minTail; i++) {
            if (target[target.length - i] === candidate[candidate.length - i]) {
                reverseScore += i * 20;
            } else {
                break;
            }
        }

        let prefixScore = 0;
        const minPrefix = Math.min(target.length, candidate.length);
        for (let i = 0; i < minPrefix; i++) {
            if (target[i] === candidate[i]) {
                prefixScore += 5;
            } else {
                break;
            }
        }

        return reverseScore + prefixScore;
    }

    private pathsEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) { return false; }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) { return false; }
        }
        return true;
    }

    async findSymbolsInDocument(document: vscode.TextDocument, name: string): Promise<SymbolInfo[]> {
        const tree = this.service.getTree(document) ?? this.service.parse(document);
        if (!tree) { return []; }

        const queryString = await this.queryManager.loadQuery('definitions');
        if (!queryString) { return []; }

        const symbols = this.extractSymbols(document, tree, queryString, document.uri);
        return symbols.filter(sym => sym.name === name);
    }

    getSymbols(name: string): SymbolInfo[] | undefined {
        return this.symbolIndex.get(name);
    }

    getAllSymbols(): SymbolInfo[] {
        const all: SymbolInfo[] = [];
        for (const list of this.symbolIndex.values()) {
            all.push(...list);
        }
        return all;
    }
    
    async updateFile(uri: vscode.Uri) {
        this.removeSymbolsForUri(uri);
        await this.indexFile(uri);
    }

    public async inferTypeFromExpression(document: vscode.TextDocument, expression?: Parser.SyntaxNode): Promise<string | undefined> {
        if (!expression) { return undefined; }

        if (expression.type === 'identifier') {
            const symbols = await this.findSymbolsInDocument(document, expression.text);
            const variable = symbols.find(sym => sym.category === 'variable' || sym.category === 'member');
            if (variable?.typeHint) {
                return variable.typeHint;
            }
        }

        return undefined;
    }

    private scoreCandidates(list: SymbolInfo[], scopePath: string[], options?: ResolveOptions) {
        return list.map(info => ({ info, score: this.scoreCandidate(info, scopePath, options) }));
    }

    private sortCandidatesWithScore(list: SymbolInfo[], scopePath: string[], options?: ResolveOptions): SymbolInfo[] {
        return this.scoreCandidates(list, scopePath, options)
            .sort((a, b) => b.score - a.score)
            .map(entry => entry.info);
    }

    private scoreCandidate(info: SymbolInfo, scopePath: string[], options?: ResolveOptions): number {
        let score = this.computeScopeSimilarity(scopePath, info.scopePath);

        if (options?.uri && info.uri.toString() === options.uri.toString()) {
            score += 15;
        }

        const docContext = options?.uri ? this.documentContexts.get(options.uri.toString()) : undefined;
        if (docContext) {
            if (docContext.modulePath && info.scopePath[0] === docContext.modulePath) {
                score += 25;
            }

            if (info.scopePath.length > 0) {
                const moduleName = info.scopePath[0];
                const moduleTail = this.lastSegment(moduleName);
                for (const entry of docContext.imports) {
                    if (
                        entry.path === moduleName ||
                        moduleName.endsWith(entry.path) ||
                        entry.path.endsWith(moduleName) ||
                        (entry.alias && entry.alias === moduleName) ||
                        (entry.alias && entry.alias === moduleTail)
                    ) {
                        score += 15;
                        break;
                    }
                }
            }
        }

        const hint = options?.context ?? { kind: 'unknown' } as SymbolContextHint;
        if (hint.kind === 'method') {
            if (info.category === 'method') {
                score += 20;
            } else if (info.category === 'function') {
                score -= 10;
            }

            if (hint.receiverType) {
                const normalizedReceiver = this.normalizeTypeName(hint.receiverType);
                const containerName = info.scopePath[info.scopePath.length - 1];
                if (containerName && this.normalizeTypeName(containerName) === normalizedReceiver) {
                    score += 35;
                } else if (info.typeHint && this.normalizeTypeName(info.typeHint) === normalizedReceiver) {
                    score += 20;
                }
            }
        } else if (hint.kind === 'free') {
            if (info.category === 'method') {
                score -= 10;
            }
        }

        return score;
    }

    private lastSegment(value: string): string {
        const parts = value.split('.');
        return parts[parts.length - 1] ?? value;
    }

    private normalizeTypeName(raw: string): string {
        if (!raw) { return ''; }
        let text = raw.trim();
        text = text.replace(/^const\s+/, '');
        const angleIndex = text.indexOf('<');
        if (angleIndex !== -1) {
            text = text.slice(0, angleIndex);
        }
        const doubleSep = text.lastIndexOf('::');
        if (doubleSep !== -1) {
            text = text.slice(doubleSep + 2);
        }
        const dotSep = text.lastIndexOf('.');
        if (dotSep !== -1) {
            text = text.slice(dotSep + 1);
        }
        return text.replace(/\s+/g, '');
    }
}
