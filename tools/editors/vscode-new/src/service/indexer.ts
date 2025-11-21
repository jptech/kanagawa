import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from './treeSitter';
import { QueryManager } from './query';

export interface SymbolInfo {
    name: string;
    uri: vscode.Uri;
    range: vscode.Range;
    kind: vscode.SymbolKind;
    detail?: string;
    docMarkdown?: string;
    signature?: string;
}

export class WorkspaceIndexer {
    private symbolIndex: Map<string, SymbolInfo[]> = new Map();
    private isIndexing = false;

    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager
    ) {}

    async scanWorkspace() {
        if (this.isIndexing) { return; }
        this.isIndexing = true;
        this.symbolIndex.clear();

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

            switch (capture.name) {
                case 'module':
                    kind = vscode.SymbolKind.Module;
                    label = 'module';
                    nameCapture = 'module.name';
                    break;
                case 'class':
                    kind = vscode.SymbolKind.Class;
                    label = 'class';
                    nameCapture = 'class.name';
                    break;
                case 'struct':
                    kind = vscode.SymbolKind.Struct;
                    label = 'struct';
                    nameCapture = 'struct.name';
                    break;
                case 'union':
                    kind = vscode.SymbolKind.Struct;
                    label = 'union';
                    nameCapture = 'union.name';
                    break;
                case 'enum':
                    kind = vscode.SymbolKind.Enum;
                    label = 'enum';
                    nameCapture = 'enum.name';
                    break;
                case 'function':
                    kind = vscode.SymbolKind.Function;
                    label = 'function';
                    nameCapture = 'function.name';
                    break;
                case 'alias':
                    kind = vscode.SymbolKind.TypeParameter;
                    label = 'type alias';
                    nameCapture = 'alias.name';
                    break;
                case 'variable':
                    kind = vscode.SymbolKind.Variable;
                    label = 'variable';
                    nameCapture = 'variable.name';
                    break;
                case 'member':
                    kind = vscode.SymbolKind.Field;
                    label = 'member';
                    nameCapture = 'member.name';
                    break;
                case 'constant':
                    kind = vscode.SymbolKind.EnumMember;
                    label = 'constant';
                    nameCapture = 'constant.name';
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

            symbols.push({
                name: nameNode.text,
                uri,
                range,
                kind,
                detail: label,
                docMarkdown,
                signature
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

        let line = node.startPosition.row - 1;
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
        const start = new vscode.Position(defNode.startPosition.row, defNode.startPosition.column);
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
}
