import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from './treeSitter';
import { QueryManager } from './query';
import * as path from 'path';

export interface SymbolInfo {
    name: string;
    uri: vscode.Uri;
    range: vscode.Range;
    kind: vscode.SymbolKind;
    detail?: string;
    docMarkdown?: string;
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

        // Ensure query is loaded
        await this.queryManager.loadQuery('definitions');

        const files = await vscode.workspace.findFiles('**/*.k', '**/node_modules/**');
        
        // Process in chunks to avoid blocking UI
        const chunkSize = 10;
        for (let i = 0; i < files.length; i += chunkSize) {
            const chunk = files.slice(i, i + chunkSize);
            await Promise.all(chunk.map(uri => this.indexFile(uri)));
            // Yield to event loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        this.isIndexing = false;
        console.log(`Kanagawa: Indexed ${this.symbolIndex.size} symbols from ${files.length} files.`);
    }

    async indexFile(uri: vscode.Uri) {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const tree = this.service.parse(document);
            if (!tree) { return; }

            const queryString = this.queryManager.getQuery('definitions');
            if (!queryString) { return; }

            const captures = this.service.query(tree.rootNode, queryString);
            
            // Build map of comment nodes for doc comment extraction
            const comments: Parser.SyntaxNode[] = [];
            for (const capture of captures) {
                if (capture.name === 'doc.comment') {
                    comments.push(capture.node);
                }
            }

            // Process definition captures
            const processedNodes = new Set<Parser.SyntaxNode>();
            
            for (const capture of captures) {
                // Skip if we've already processed this node or if it's a comment
                if (processedNodes.has(capture.node) || capture.name === 'doc.comment') {
                    continue;
                }
                
                const node = capture.node;
                let kind = vscode.SymbolKind.Variable;
                let detail = '';
                let nameNode: Parser.SyntaxNode | null = null;
                
                // Determine the symbol type and extract the name node
                switch (capture.name) {
                    case 'module':
                        kind = vscode.SymbolKind.Module;
                        detail = 'module';
                        nameNode = this.findCaptureByName(captures, 'module.name', node);
                        break;
                        
                    case 'class':
                        kind = vscode.SymbolKind.Class;
                        detail = 'class';
                        nameNode = this.findCaptureByName(captures, 'class.name', node);
                        break;
                        
                    case 'struct':
                        kind = vscode.SymbolKind.Struct;
                        detail = 'struct';
                        nameNode = this.findCaptureByName(captures, 'struct.name', node);
                        break;
                        
                    case 'union':
                        kind = vscode.SymbolKind.Struct;
                        detail = 'union';
                        nameNode = this.findCaptureByName(captures, 'union.name', node);
                        break;
                        
                    case 'enum':
                        kind = vscode.SymbolKind.Enum;
                        detail = 'enum';
                        nameNode = this.findCaptureByName(captures, 'enum.name', node);
                        break;
                        
                    case 'function':
                        kind = vscode.SymbolKind.Function;
                        detail = 'function';
                        nameNode = this.findCaptureByName(captures, 'function.name', node);
                        break;
                        
                    case 'alias':
                        kind = vscode.SymbolKind.TypeParameter;
                        detail = 'type alias';
                        nameNode = this.findCaptureByName(captures, 'alias.name', node);
                        break;
                        
                    case 'variable':
                        kind = vscode.SymbolKind.Variable;
                        detail = 'variable';
                        nameNode = this.findCaptureByName(captures, 'variable.name', node);
                        break;
                        
                    case 'member':
                        kind = vscode.SymbolKind.Field;
                        detail = 'member';
                        nameNode = this.findCaptureByName(captures, 'member.name', node);
                        break;
                        
                    case 'constant':
                        kind = vscode.SymbolKind.EnumMember;
                        detail = 'constant';
                        nameNode = this.findCaptureByName(captures, 'constant.name', node);
                        break;
                        
                    default:
                        continue;
                }

                if (!nameNode) {
                    continue;
                }

                const name = nameNode.text;
                const range = new vscode.Range(
                    new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                    new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
                );

                // Find doc comments
                const docMarkdown = this.findDocComment(node, comments);

                const info: SymbolInfo = {
                    name,
                    uri,
                    range,
                    kind,
                    detail,
                    docMarkdown
                };

                if (!this.symbolIndex.has(name)) {
                    this.symbolIndex.set(name, []);
                }
                this.symbolIndex.get(name)?.push(info);
                
                processedNodes.add(node);
            }

        } catch (e) {
            console.error(`Failed to index ${uri.toString()}:`, e);
        }
    }
    
    private findCaptureByName(captures: any[], name: string, parentNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
        for (const capture of captures) {
            if (capture.name === name) {
                // Check if this capture's node is a descendant of parentNode
                let node = capture.node;
                while (node) {
                    if (node === parentNode) {
                        return capture.node;
                    }
                    node = node.parent;
                }
            }
        }
        return null;
    }

    private findDocComment(node: Parser.SyntaxNode, comments: Parser.SyntaxNode[]): string | undefined {
        // Look for comments immediately before the node
        const nodeStartLine = node.startPosition.row;
        
        // Filter comments that are strictly before and adjacent
        // Simple heuristic: check lines immediately preceding
        let docLines: string[] = [];
        
        // Reverse iterate comments to find the ones right before
        for (let i = comments.length - 1; i >= 0; i--) {
            const comment = comments[i];
            const commentEndLine = comment.endPosition.row;
            
            // Check if comment is //| (pre-doc)
            if (comment.text.startsWith('//|')) {
                // Must be on line nodeStartLine - 1 (or connected to previous doc comment)
                // For simplicity, let's just grab any //| that is close enough?
                // Better: check if commentEndLine == nodeStartLine - 1 - (distance)
                // But we need to handle multiple lines of comments.
                
                // Let's just check if it's within 5 lines above for now, 
                // and strictly ordered.
                if (commentEndLine < nodeStartLine && commentEndLine >= nodeStartLine - 5) {
                     docLines.unshift(comment.text.substring(3).trim());
                }
            }
        }
        
        if (docLines.length > 0) {
            return docLines.join('\n');
        }
        return undefined;
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
    
    updateFile(uri: vscode.Uri) {
        // Remove old symbols for this file? 
        // In a map<string, list>, it's hard to remove by URI without iterating everything.
        // Optimization: Keep a separate Map<Uri, SymbolNames[]> to know what to remove.
        // For LSP-Lite, we might just append and accept duplicates or filter them at lookup time.
        // Let's do a full re-index of the file which is safer.
        
        // First, remove entries for this URI
        for (const [key, list] of this.symbolIndex.entries()) {
            const newList = list.filter(s => s.uri.toString() !== uri.toString());
            if (newList.length === 0) {
                this.symbolIndex.delete(key);
            } else {
                this.symbolIndex.set(key, newList);
            }
        }
        
        this.indexFile(uri);
    }
}
