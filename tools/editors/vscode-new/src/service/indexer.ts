import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as path from 'path';
import { TreeSitterService } from './treeSitter';
import { QueryManager } from './query';
import { ImportConfigService, ImportConfiguration } from './importConfig';

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
    private verbose = false;
    private recentlyIndexed = 0;
    private readonly templateWrappers = new Set<string>([
        'function_template',
        'class_template',
        'struct_template',
        'union_template',
        'alias_template',
        'enum_template'
    ]);
    private readonly typeInferenceCache: Map<string, Map<number, string>> = new Map();
    private readonly memberCache: Map<string, SymbolInfo[]> = new Map();
    private readonly aliasMap: Map<string, { target: string; uri: string }> = new Map();
    private readonly importConfig: ImportConfigService;
    private pendingRescan = false;

    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager,
        workspaceFolder?: vscode.WorkspaceFolder
    ) {
        this.importConfig = new ImportConfigService(workspaceFolder);
    }

    async init(context: vscode.ExtensionContext): Promise<void> {
        await this.importConfig.init(context);
        context.subscriptions.push(this.importConfig.onDidChange(() => {
            this.memberCache.clear();
            this.typeInferenceCache.clear();
            this.handleImportConfigurationChanged();
        }));
    }

    async getImportConfiguration(): Promise<ImportConfiguration> {
        return this.importConfig.resolveImportConfiguration();
    }

    async scanWorkspace() {
        if (this.isIndexing) {
            this.pendingRescan = true;
            return;
        }
        this.isIndexing = true;
        this.symbolIndex.clear();
        this.documentContexts.clear();
        this.memberCache.clear();
        this.typeInferenceCache.clear();
        this.aliasMap.clear();

        const importConfiguration = await this.importConfig.resolveImportConfiguration();

        // Ensure query is loaded and cached inside the query manager
        const queryString = await this.queryManager.loadQuery('definitions');
        if (!queryString) {
            console.error('Kanagawa: Unable to load definitions query.');
            this.isIndexing = false;
            return;
        }

        const files = await this.collectSourceFiles(importConfiguration.importPaths);
        
        // Process in chunks to avoid blocking UI
        const chunkSize = 10;
        for (let i = 0; i < files.length; i += chunkSize) {
            const chunk = files.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (uri: vscode.Uri) => {
                await this.indexFile(uri, queryString);
            }));
            // Yield to event loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        this.isIndexing = false;
        console.log(`Kanagawa: Indexed ${this.symbolIndex.size} symbols from ${files.length} files.`);
            this.recentlyIndexed = 0;
            if (this.verbose) {
                console.log(`Kanagawa: Indexed ${this.symbolIndex.size} symbols from ${files.length} files.`);
            }

        if (this.pendingRescan) {
            this.pendingRescan = false;
            void this.scanWorkspace();
        }
    }

    async indexFile(uri: vscode.Uri, queryString?: string) {
        try {
            if (this.verbose) {
                console.log('Kanagawa: Indexing file:', uri.toString());
            }
            this.clearDocumentCaches(uri);
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
            this.memberCache.clear();
                    this.recentlyIndexed += symbols.length;
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
                    {
                        const returnNode = capture.node.childForFieldName('return_type');
                        if (returnNode) {
                            typeHint = this.sanitizeTypeText(returnNode.text);
                        }
                    }
                    break;
                case 'alias':
                    kind = vscode.SymbolKind.TypeParameter;
                    label = 'type alias';
                    nameCapture = 'alias.name';
                    category = 'alias';
                    {
                        const aliasTarget = this.extractAliasTarget(capture.node);
                        if (aliasTarget) {
                            typeHint = this.sanitizeTypeText(aliasTarget);
                        }
                    }
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

            const docMarkdown = this.collectDocBlock(document, capture.node, preDocs, postDocs);
            let signature = this.buildSignature(document, capture.name, capture.node, nameNode);
            if (signature && signature.length > 180) {
                signature = signature.slice(0, 177) + '…';
            }

            if (category === 'alias' && typeHint) {
                const aliasKey = this.normalizeTypeName(nameNode.text);
                const targetNormalized = this.normalizeTypeName(typeHint);
                if (aliasKey && targetNormalized) {
                    const canonicalTarget = this.resolveAliasChain(targetNormalized);
                    this.aliasMap.set(aliasKey, { target: canonicalTarget, uri: uri.toString() });
                }
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

    public clearIndex() {
        this.symbolIndex.clear();
        this.documentContexts.clear();
        this.memberCache.clear();
        this.typeInferenceCache.clear();
        this.recentlyIndexed = 0;
        this.aliasMap.clear();
    }

    public toggleVerbose() {
        this.verbose = !this.verbose;
        return this.verbose;
    }

    public getStats() {
        const files = new Set<string>();
        for (const list of this.symbolIndex.values()) {
            for (const sym of list) {
                files.add(sym.uri.toString());
            }
        }
        return {
            totalSymbols: this.symbolIndex.size,
            uniqueFiles: files.size,
            recentlyIndexed: this.recentlyIndexed,
            verbose: this.verbose
        };
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
        this.typeInferenceCache.delete(target);
        this.memberCache.clear();
        for (const [alias, record] of this.aliasMap.entries()) {
            if (record.uri === target) {
                this.aliasMap.delete(alias);
            }
        }
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
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        preDocs: Map<number, string>,
        postDocs: Map<number, string>
    ): string | undefined {
        const anchor = this.getDocAnchorNode(node);

        const lines = this.collectLeadingDocLines(document, anchor, preDocs);

        let line = node.endPosition.row;
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

        const rawText = document.getText(new vscode.Range(start, end));
        const stripped = this.stripInlineDocComments(rawText).trim();
        if (!stripped) { return undefined; }
        return stripped.replace(/\s+/g, ' ');
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
            case 'function_definition':
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

    public findNearestLocalSymbol(document: vscode.TextDocument, identifier: Parser.SyntaxNode): SymbolInfo | undefined {
        const targetName = identifier.text;
        const limit = identifier.startIndex;

        let current: Parser.SyntaxNode | null = identifier.parent;
        while (current) {
            const templateSymbol = this.findTemplateParameterSymbol(document, current, targetName);
            if (templateSymbol) {
                return templateSymbol;
            }

            if (current.type === 'block' || current.type === 'compound_statement') {
                const decl = this.findDeclarationInScope(current, targetName, limit);
                if (decl) {
                    return this.buildLocalSymbolInfo(document, decl, targetName);
                }
            }

            if (current.type === 'function_definition') {
                const templateMatch = this.findTemplateParameterSymbol(document, current.parent, targetName);
                if (templateMatch) {
                    return templateMatch;
                }
                const param = this.findParameterDeclaration(current, targetName);
                if (param) {
                    return this.buildLocalSymbolInfo(document, param, targetName);
                }
            }

            current = current.parent;
        }

        return undefined;
    }

    public resolveSymbols(name: string, scopePath: string[], options?: ResolveOptions): SymbolInfo[] {
        let candidates = this.symbolIndex.get(name) ?? [];
        if (candidates.length === 0) {
            const normalized = this.normalizeTypeName(name);
            if (normalized && normalized !== name) {
                candidates = this.symbolIndex.get(normalized) ?? [];
            }
            if (candidates.length === 0 && normalized) {
                const canonical = this.resolveAliasChain(normalized);
                if (canonical && canonical !== normalized) {
                    candidates = this.symbolIndex.get(canonical) ?? [];
                }
            }
        }
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

    private handleImportConfigurationChanged(): void {
        if (this.isIndexing) {
            this.pendingRescan = true;
            return;
        }
        void this.scanWorkspace();
    }

    private async collectSourceFiles(extraPaths: string[]): Promise<vscode.Uri[]> {
        const workspaceFiles = await vscode.workspace.findFiles('**/*.k', '**/node_modules/**');
        const externalFiles = await this.collectExternalSourceFiles(extraPaths);
        const uriMap = new Map<string, vscode.Uri>();
        for (const uri of [...workspaceFiles, ...externalFiles]) {
            const key = uri.toString();
            if (!uriMap.has(key)) {
                uriMap.set(key, uri);
            }
        }
        return Array.from(uriMap.values());
    }

    private async collectExternalSourceFiles(paths: string[]): Promise<vscode.Uri[]> {
        const results: vscode.Uri[] = [];
        const visitedRoots = new Set<string>();
        const visitedDirs = new Set<string>();

        for (const raw of paths) {
            if (!raw || !raw.trim()) { continue; }
            const normalized = path.normalize(path.resolve(raw));
            if (visitedRoots.has(normalized)) { continue; }
            visitedRoots.add(normalized);

            const rootUri = vscode.Uri.file(normalized);
            await this.walkKanagawaDirectory(rootUri, results, visitedDirs);
        }

        return results;
    }

    private async walkKanagawaDirectory(
        rootUri: vscode.Uri,
        results: vscode.Uri[],
        visitedDirs: Set<string>
    ): Promise<void> {
        const dirKey = rootUri.fsPath;
        if (visitedDirs.has(dirKey)) { return; }
        visitedDirs.add(dirKey);

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(rootUri);
        } catch {
            return;
        }

        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(rootUri, name);

            if ((type & vscode.FileType.SymbolicLink) !== 0) { continue; }

            if ((type & vscode.FileType.File) !== 0) {
                if (name.endsWith('.k')) {
                    results.push(entryUri);
                }
                continue;
            }

            if ((type & vscode.FileType.Directory) === 0) { continue; }

            if (this.shouldSkipDirectory(name)) { continue; }
            await this.walkKanagawaDirectory(entryUri, results, visitedDirs);
        }
    }

    private shouldSkipDirectory(name: string): boolean {
        const lower = name.toLowerCase();
        if (lower === '.git' || lower === '.hg' || lower === '.svn' || lower === 'node_modules') { return true; }
        if (lower === 'build' || lower === 'dist' || lower === 'out') { return true; }
        if (name.startsWith('.') && name !== '.kanagawa') { return true; }
        return false;
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

    getIndexedUris(): vscode.Uri[] {
        const uris: vscode.Uri[] = [];
        for (const key of this.documentContexts.keys()) {
            try {
                uris.push(vscode.Uri.parse(key));
            } catch (e) {
                // ignore malformed entries
            }
        }
        return uris;
    }
    
    async updateFile(uri: vscode.Uri) {
        this.removeSymbolsForUri(uri);
        await this.indexFile(uri);
    }

    public async inferTypeFromExpression(document: vscode.TextDocument, expression?: Parser.SyntaxNode): Promise<string | undefined> {
        if (!expression) { return undefined; }

        const docKey = document.uri.toString();
        const cache = this.typeInferenceCache.get(docKey) ?? new Map<number, string>();
        if (cache.has(expression.id)) {
            const cached = cache.get(expression.id);
            return cached && cached.length ? cached : undefined;
        }

        let inferred: string | undefined;

        if (expression.type === 'identifier') {
            const local = this.findNearestLocalSymbol(document, expression);
            if (local?.typeHint) {
                inferred = local.typeHint;
            } else {
                const symbols = await this.findSymbolsInDocument(document, expression.text);
                const variable = symbols.find(sym => sym.category === 'variable' || sym.category === 'member');
                inferred = variable?.typeHint;
            }
        } else if (expression.type === 'template_instantiation') {
            const normalized = this.normalizeTypeName(expression.text);
            inferred = normalized.length ? normalized : undefined;
        } else if (expression.type === 'member_expression') {
            const objectNode = expression.namedChild(0);
            const propertyNode = expression.namedChild(expression.namedChildCount - 1);
            const objectType = await this.inferTypeFromExpression(document, objectNode ?? undefined);
            if (objectType && propertyNode) {
                const member = this.getMemberInfo(objectType, propertyNode.text);
                inferred = member?.typeHint;
            }
        } else if (expression.type === 'call_expression') {
            inferred = await this.inferCallExpressionType(document, expression);
        }

        if (inferred) {
            cache.set(expression.id, inferred);
            this.typeInferenceCache.set(docKey, cache);
            return inferred;
        }

        cache.set(expression.id, '');
        this.typeInferenceCache.set(docKey, cache);
        return undefined;
    }

    /**
     * Infers the return type of a call expression, handling:
     * - Cast expressions: `cast<Type>(value)` → Type
     * - Member method calls: `obj.method()` → method's return type
     * - Free function calls: `func()` → function's return type
     * - Constructor calls: `Foo<T>()` → Foo
     */
    private async inferCallExpressionType(
        document: vscode.TextDocument,
        callExpression: Parser.SyntaxNode
    ): Promise<string | undefined> {
        const callee = this.getCallTarget(callExpression);
        if (!callee) { return undefined; }

        // Handle cast expressions: cast<Type>(value), static_cast<Type>(value), etc.
        if (callee.type === 'cast_operator') {
            return this.extractCastTargetType(callee);
        }

        // Handle member method calls: obj.method()
        if (callee.type === 'member_expression') {
            return this.inferMemberCallReturnType(document, callee);
        }

        // Handle free function calls or constructor calls
        const idNode = this.extractIdentifierFromExpression(callee);
        if (!idNode) { return undefined; }

        // Check if this looks like a constructor call (identifier matches a known class)
        const className = this.normalizeTypeName(callee.text);
        if (className) {
            const classSymbols = this.symbolIndex.get(className);
            const isClass = classSymbols?.some(sym =>
                sym.category === 'class' || sym.category === 'struct'
            );
            if (isClass) {
                return className;
            }
        }

        // Otherwise resolve as a free function call and get its return type
        const scopePath = this.getScopePathForNode(idNode);
        const candidates = this.resolveSymbols(idNode.text, scopePath, {
            uri: document.uri,
            context: { kind: 'free' },
            limit: 5
        });

        // Return the typeHint (return type) of the first matching function
        const match = candidates.find(candidate =>
            (candidate.category === 'function' || candidate.category === 'method') &&
            !!candidate.typeHint
        );
        return match?.typeHint;
    }

    /**
     * Extracts the target type from a cast_operator node.
     * Handles: cast<float>, static_cast<uint32>, reinterpret_cast<T>, checked_cast<Type>
     */
    private extractCastTargetType(castOperator: Parser.SyntaxNode): string | undefined {
        // The cast_operator structure is: cast<Type> where Type can be:
        // - type_specifier (identifier or templated)
        // - primitive_type (int, uint, float32, etc.)
        for (const child of castOperator.namedChildren) {
            if (child.type === 'type_specifier' ||
                child.type === 'primitive_type' ||
                child.type === 'modified_type' ||
                child.type === 'array_type') {
                return this.sanitizeTypeText(child.text);
            }
        }
        return undefined;
    }

    /**
     * Infers the return type of a member method call: obj.method()
     */
    private async inferMemberCallReturnType(
        document: vscode.TextDocument,
        memberExpression: Parser.SyntaxNode
    ): Promise<string | undefined> {
        const propertyNode = this.getMemberIdentifier(memberExpression);
        if (!propertyNode) { return undefined; }

        // First try to resolve as a member method
        const memberMatches = await this.resolveMemberSymbol(document, propertyNode);
        if (memberMatches?.length) {
            // Find a function/method with a return type
            const methodMatch = memberMatches.find(sym =>
                (sym.category === 'function' || sym.category === 'method') &&
                !!sym.typeHint
            );
            if (methodMatch?.typeHint) {
                return methodMatch.typeHint;
            }
        }

        // Fall back to any symbol with a type hint
        const anyMatch = memberMatches?.find(sym => !!sym.typeHint);
        return anyMatch?.typeHint;
    }

    public async resolveMemberSymbol(
        document: vscode.TextDocument,
        identifier: Parser.SyntaxNode
    ): Promise<SymbolInfo[] | undefined> {
        const parent = identifier.parent;
        if (!parent || parent.type !== 'member_expression') {
            return undefined;
        }

        const receiverNode = parent.namedChild(0);
        if (!receiverNode) { return undefined; }
        const memberName = identifier.text;

        const receiverType = await this.inferTypeFromExpression(document, receiverNode);
        if (!receiverType) { return undefined; }

        // Check if this is a call context (member is being called as a method)
        const grandparent = parent.parent;
        const isCallContext = grandparent?.type === 'call_expression';

        // Get both methods and fields - the caller can filter based on context
        const members = this.getMembersForType(receiverType, {
            includeMethods: true,
            includeFields: true
        });
        const matches = members.filter(sym => sym.name === memberName);
        
        // If in call context, prefer methods; otherwise prefer fields
        if (isCallContext && matches.length > 1) {
            const methods = matches.filter(sym => sym.category === 'method' || sym.category === 'function');
            if (methods.length > 0) {
                return methods;
            }
        }
        
        return matches.length ? matches : undefined;
    }

    public getMembersForType(typeName: string, options?: { includeMethods?: boolean; includeFields?: boolean }): SymbolInfo[] {
        if (!typeName) { return []; }
        const normalized = this.normalizeTypeName(typeName);
        if (!normalized) { return []; }
        const canonical = this.resolveAliasChain(normalized);

        if (this.memberCache.has(canonical)) {
            return this.filterMembers(this.memberCache.get(canonical) ?? [], options);
        }

        const results: SymbolInfo[] = [];
        const seen = new Set<string>();

        for (const list of this.symbolIndex.values()) {
            for (const sym of list) {
                if (!sym.scopePath.length) { continue; }
                const container = sym.scopePath[sym.scopePath.length - 1];
                if (!container) { continue; }
                const containerKey = this.resolveAliasChain(this.normalizeTypeName(container));
                if (containerKey !== canonical) { continue; }

                const key = `${sym.name}|${sym.uri.toString()}|${sym.range.start.line}|${sym.category}`;
                if (seen.has(key)) { continue; }
                seen.add(key);
                results.push(sym);
            }
        }

        results.sort((a, b) => {
            if (a.category === b.category) {
                return a.name.localeCompare(b.name);
            }
            if (a.category === 'method') { return -1; }
            if (b.category === 'method') { return 1; }
            return a.category.localeCompare(b.category);
        });

        this.memberCache.set(canonical, results.slice());
        return this.filterMembers(results, options);
    }

    public async getTemplateParametersForSymbol(symbol: SymbolInfo): Promise<SymbolInfo[]> {
        try {
            const document = await vscode.workspace.openTextDocument(symbol.uri);
            const tree = this.service.getTree(document) ?? this.service.parse(document);
            if (!tree) { return []; }
            const node = tree.rootNode.descendantForPosition({
                row: symbol.range.start.line,
                column: symbol.range.start.character
            });

            let templateNode = this.findTemplateAncestor(node);
            while (templateNode) {
                if (this.isTemplateWrapperApplicable(symbol.category, templateNode.type)) {
                    return this.getTemplateParameterSymbols(document, templateNode);
                }
                templateNode = this.findTemplateAncestor(templateNode.parent);
            }

            return [];
        } catch {
            return [];
        }
    }

    private isTemplateWrapperApplicable(category: SymbolCategory, wrapperType: string): boolean {
        switch (category) {
            case 'class':
            case 'struct':
            case 'union':
            case 'alias':
                return wrapperType === 'class_template' || wrapperType === 'struct_template' || wrapperType === 'union_template' || wrapperType === 'alias_template';
            case 'function':
            case 'method':
                return wrapperType === 'function_template';
            default:
                return false;
        }
    }

    public collectVisibleLocals(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree
    ): SymbolInfo[] {
        const offset = document.offsetAt(position);
        const seen = new Set<string>();
        const locals: SymbolInfo[] = [];
        const processedTemplates = new Set<number>();

        const lookupPosition = {
            row: position.line,
            column: Math.max(0, position.character - 1)
        };

        let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(lookupPosition);
        while (node) {
            if (node.type === 'block' || node.type === 'compound_statement') {
                this.collectDeclarationsInScope(document, node, offset, locals, seen);
            } else if (node.type === 'function_definition') {
                const templateNode = this.findTemplateAncestor(node);
                if (templateNode && !processedTemplates.has(templateNode.id)) {
                    for (const param of this.getTemplateParameterSymbols(document, templateNode)) {
                        if (seen.has(param.name)) { continue; }
                        locals.push(param);
                        seen.add(param.name);
                    }
                    processedTemplates.add(templateNode.id);
                }
                this.collectParametersFromFunction(document, node, locals, seen);
            }

            const ancestorTemplate = this.findTemplateAncestor(node.parent);
            if (ancestorTemplate && !processedTemplates.has(ancestorTemplate.id)) {
                for (const param of this.getTemplateParameterSymbols(document, ancestorTemplate)) {
                    if (seen.has(param.name)) { continue; }
                    locals.push(param);
                    seen.add(param.name);
                }
                processedTemplates.add(ancestorTemplate.id);
            }
            node = node.parent;
        }

        return locals;
    }

    private collectDeclarationsInScope(
        document: vscode.TextDocument,
        scopeNode: Parser.SyntaxNode,
        limit: number,
        locals: SymbolInfo[],
        seen: Set<string>
    ) {
        for (let i = scopeNode.namedChildren.length - 1; i >= 0; i--) {
            const child = scopeNode.namedChildren[i];
            if (child.startIndex >= limit) { continue; }

            if (child.type === 'variable_decl') {
                const nameNode = child.childForFieldName('name');
                if (!nameNode) { continue; }
                const name = nameNode.text;
                if (seen.has(name)) { continue; }
                locals.push(this.buildLocalSymbolInfo(document, child, name));
                seen.add(name);
            } else if (
                (child.type === 'block' || child.type === 'compound_statement') &&
                child.startIndex < limit &&
                child.endIndex >= limit
            ) {
                this.collectDeclarationsInScope(document, child, limit, locals, seen);
            }
        }
    }

    private collectParametersFromFunction(
        document: vscode.TextDocument,
        functionNode: Parser.SyntaxNode,
        locals: SymbolInfo[],
        seen: Set<string>
    ) {
        const params = functionNode.childForFieldName('parameters');
        if (!params) { return; }

        for (let i = params.namedChildren.length - 1; i >= 0; i--) {
            const child = params.namedChildren[i];
            if (child.type !== 'parameter') { continue; }
            const nameNode = child.childForFieldName('name');
            if (!nameNode) { continue; }
            const name = nameNode.text;
            if (seen.has(name)) { continue; }
            locals.push(this.buildLocalSymbolInfo(document, child, name));
            seen.add(name);
        }
    }

    private filterMembers(source: SymbolInfo[], options?: { includeMethods?: boolean; includeFields?: boolean }): SymbolInfo[] {
        const includeMethods = options?.includeMethods ?? true;
        const includeFields = options?.includeFields ?? true;

        return source.filter(sym =>
            (includeMethods && sym.category === 'method') ||
            (includeFields && sym.category === 'member')
        );
    }

    private getMemberInfo(typeName: string, memberName: string): SymbolInfo | undefined {
        const normalized = this.normalizeTypeName(typeName);
        if (!normalized) { return undefined; }

        const members = this.getMembersForType(normalized, { includeMethods: true, includeFields: true });
        return members.find(sym => sym.name === memberName);
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

    private sanitizeTypeText(text?: string): string | undefined {
        if (!text) { return undefined; }
        return text.replace(/\s+/g, ' ').trim();
    }

    private extractAliasTarget(node: Parser.SyntaxNode): string | undefined {
        const target = this.findTypeNode(node);
        return target ? target.text.trim() : undefined;
    }

    private resolveAliasChain(typeName: string): string {
        let current = typeName;
        const visited = new Set<string>();
        while (this.aliasMap.has(current) && !visited.has(current)) {
            visited.add(current);
            const entry = this.aliasMap.get(current);
            if (!entry) { break; }
            current = entry.target;
        }
        return current;
    }

    private getCallTarget(callExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        if (callExpression.type !== 'call_expression') { return undefined; }
        return callExpression.namedChild(0) ?? undefined;
    }

    private getMemberIdentifier(memberExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        if (memberExpression.type !== 'member_expression') { return undefined; }
        const count = memberExpression.namedChildCount;
        if (count === 0) { return undefined; }
        return memberExpression.namedChild(count - 1) ?? undefined;
    }

    private extractIdentifierFromExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        switch (node.type) {
            case 'identifier':
                return node;
            case 'scoped_identifier':
            case 'qualified_identifier':
                return node.namedChild(node.namedChildCount - 1) ?? undefined;
            case 'member_expression':
                return this.getMemberIdentifier(node);
            case 'template_instantiation': {
                const subject = node.namedChild(0);
                return subject ? this.extractIdentifierFromExpression(subject) : undefined;
            }
            default:
                return undefined;
        }
    }

    private findTemplateAncestor(node: Parser.SyntaxNode | null): Parser.SyntaxNode | undefined {
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (this.templateWrappers.has(current.type)) {
                return current;
            }
            current = current.parent;
        }
        return undefined;
    }

    private getTemplateParameterSymbols(document: vscode.TextDocument, templateNode: Parser.SyntaxNode): SymbolInfo[] {
        const paramsNode = templateNode.namedChildren.find(child => child.type === 'template_params');
        if (!paramsNode) { return []; }

        const symbols: SymbolInfo[] = [];
        for (const child of paramsNode.namedChildren) {
            if (child.type !== 'template_param') { continue; }
            const symbol = this.createTemplateParameterSymbol(document, templateNode, child);
            if (symbol) {
                symbols.push(symbol);
            }
        }
        return symbols;
    }

    private createTemplateParameterSymbol(
        document: vscode.TextDocument,
        templateNode: Parser.SyntaxNode,
        paramNode: Parser.SyntaxNode
    ): SymbolInfo | undefined {
        const nameNode = paramNode.namedChildren.find(child => child.type === 'identifier');
        if (!nameNode) { return undefined; }

        const firstChild = paramNode.child(0);
        let category: SymbolCategory = 'constant';
        let detail = 'template parameter';
        let typeHint: string | undefined;

        if (firstChild?.type === 'typename') {
            category = 'alias';
            detail = 'template type parameter';
            typeHint = 'typename';
        } else if (firstChild?.type === 'template') {
            category = 'alias';
            detail = 'template parameter';
            typeHint = 'template';
        } else {
            if (firstChild?.type === 'auto') {
                typeHint = 'auto';
            }

            for (const child of paramNode.namedChildren) {
                if (child.id === nameNode.id) { break; }
                if (child.type !== 'identifier') {
                    typeHint = child.text.trim();
                    break;
                }
            }
        }

        const range = new vscode.Range(
            new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
            new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
        );
        const signatureParts: string[] = [];
        if (typeHint) {
            signatureParts.push(typeHint.replace(/\s+/g, ' '));
        }
        signatureParts.push(nameNode.text);

        const docComment = this.collectTemplateParameterDoc(document, paramNode);

        return {
            name: nameNode.text,
            uri: document.uri,
            range,
            kind: category === 'alias' ? vscode.SymbolKind.TypeParameter : vscode.SymbolKind.Constant,
            detail,
            docMarkdown: docComment,
            signature: signatureParts.join(' '),
            scopePath: this.buildScopePath(templateNode),
            category,
            typeHint
        };
    }

    private getNodeText(document: vscode.TextDocument, node: Parser.SyntaxNode | null): string | undefined {
        if (!node) { return undefined; }
        const start = new vscode.Position(node.startPosition.row, node.startPosition.column);
        const end = new vscode.Position(node.endPosition.row, node.endPosition.column);
        return document.getText(new vscode.Range(start, end));
    }

    private stripInlineDocComments(text: string): string {
        const lines = text.split(/\r?\n/);
        const cleaned = lines.map(line => line.replace(/\/\/([|<]).*$/g, '').replace(/\s+$/u, ''));
        return cleaned.join('\n');
    }

    private collectTemplateParameterDoc(document: vscode.TextDocument, paramNode: Parser.SyntaxNode): string | undefined {
        const lineIndex = paramNode.endPosition.row;
        if (lineIndex >= document.lineCount) { return undefined; }

        const currentLine = document.lineAt(lineIndex).text;
        const parts: string[] = [];
        const inlineIndex = currentLine.indexOf('//<');
        if (inlineIndex !== -1) {
            const content = currentLine.slice(inlineIndex + 3).trim();
            if (content.length) { parts.push(content); }
        } else {
            return undefined;
        }

        let nextLine = lineIndex + 1;
        while (nextLine < document.lineCount) {
            const text = document.lineAt(nextLine).text;
            const trimmed = text.trim();
            if (!trimmed.startsWith('//')) { break; }
            const normalized = trimmed.replace(/^\/\/?<?\s?/, '').trim();
            if (normalized.length) {
                parts.push(normalized);
            }
            nextLine++;
        }

        if (!parts.length) { return undefined; }
        return parts.join('\n');
    }

    private collectLineCommentBlock(
        document: vscode.TextDocument,
        anchor: Parser.SyntaxNode
    ): string[] {
        const result: string[] = [];
        let line = anchor.startPosition.row - 1;

        while (line >= 0) {
            const text = document.lineAt(line).text;
            const trimmed = text.trim();
            if (!trimmed.startsWith('//') || trimmed.startsWith('//|') || trimmed.startsWith('//<')) {
                break;
            }
            const content = trimmed.replace(/^\/\/\s?/, '').trim();
            if (content.length) {
                result.unshift(content);
            }
            line--;
        }

        // Include doc comments captured via preDocs in case they weren't gathered
        return result;
    }

    private collectLeadingDocLines(
        document: vscode.TextDocument,
        anchor: Parser.SyntaxNode,
        preDocs: Map<number, string>
    ): string[] {
        const result: string[] = [];
        let line = anchor.startPosition.row - 1;

        while (line >= 0) {
            if (preDocs.has(line)) {
                result.unshift(preDocs.get(line)!);
                line--;
                continue;
            }

            const text = document.lineAt(line).text;
            const trimmed = text.trim();
            if (!trimmed.startsWith('//')) { break; }

            if (trimmed.startsWith('//<')) { break; }

            const content = trimmed.startsWith('//|')
                ? this.cleanDocComment(trimmed)
                : trimmed.replace(/^\/\/\s?/, '').trim();

            if (content.length) {
                result.unshift(content);
            }

            line--;
        }

        return result.length ? result : this.collectLineCommentBlock(document, anchor);
    }

    private findTemplateParameterSymbol(
        document: vscode.TextDocument,
        start: Parser.SyntaxNode | null,
        targetName: string
    ): SymbolInfo | undefined {
        const templateNode = this.findTemplateAncestor(start);
        if (!templateNode) { return undefined; }
        const symbols = this.getTemplateParameterSymbols(document, templateNode);
        return symbols.find(symbol => symbol.name === targetName);
    }

    private clearDocumentCaches(uri: vscode.Uri) {
        const key = uri.toString();
        this.typeInferenceCache.delete(key);
    }

    private findDeclarationInScope(scopeNode: Parser.SyntaxNode, targetName: string, limit: number): Parser.SyntaxNode | undefined {
        if (!scopeNode.namedChildren.length) { return undefined; }

        let candidate: Parser.SyntaxNode | undefined;
        for (const child of scopeNode.namedChildren) {
            if (child.startIndex > limit) {
                break;
            }

            const isBlock = child.type === 'block' || child.type === 'compound_statement';
            const shouldDescend = !isBlock || (child.startIndex <= limit && child.endIndex >= limit);

            if (shouldDescend) {
                const match = this.matchDeclarationNode(child, targetName, limit);
                if (match && (!candidate || match.startIndex > candidate.startIndex)) {
                    candidate = match;
                }

                const nested = this.findDeclarationInScope(child, targetName, limit);
                if (nested && (!candidate || nested.startIndex > candidate.startIndex)) {
                    candidate = nested;
                }
            }
        }

        return candidate;
    }

    private findParameterDeclaration(functionNode: Parser.SyntaxNode, targetName: string): Parser.SyntaxNode | undefined {
        const params = functionNode.childForFieldName('parameters');
        if (!params) { return undefined; }

        for (const child of params.namedChildren) {
            if (child.type !== 'parameter') { continue; }
            const nameNode = child.childForFieldName('name');
            if (nameNode && nameNode.text === targetName) {
                return child;
            }
        }

        return undefined;
    }

    private matchDeclarationNode(node: Parser.SyntaxNode, targetName: string, limit: number): Parser.SyntaxNode | undefined {
        if (node.type === 'variable_decl') {
            const nameNode = node.childForFieldName('name');
            if (nameNode && nameNode.text === targetName && node.startIndex < limit) {
                return node;
            }
        }
        return undefined;
    }

    private buildLocalSymbolInfo(document: vscode.TextDocument, declNode: Parser.SyntaxNode, name: string): SymbolInfo {
        const nameNode = declNode.childForFieldName('name');
        const range = nameNode
            ? new vscode.Range(
                new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
            )
            : new vscode.Range(
                new vscode.Position(declNode.startPosition.row, declNode.startPosition.column),
                new vscode.Position(declNode.startPosition.row, declNode.startPosition.column)
            );

        const typeNode = this.findTypeNode(declNode);
        const typeText = typeNode ? typeNode.text.trim() : undefined;
        const signatureParts: string[] = [];
        if (typeText) {
            signatureParts.push(typeText.replace(/\s+/g, ' '));
        }
        signatureParts.push(name);

        return {
            name,
            uri: document.uri,
            range,
            kind: vscode.SymbolKind.Variable,
            detail: 'variable',
            docMarkdown: undefined,
            signature: signatureParts.join(' '),
            scopePath: this.buildScopePath(declNode),
            category: 'variable',
            typeHint: typeText
        };
    }
}
