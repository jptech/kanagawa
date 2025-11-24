import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from '../service/indexer';

export class KanagawaHoverProvider implements vscode.HoverProvider {
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const tree = this.service.getTree(document);
        if (!tree) {
            return undefined;
        }

        const node = tree.rootNode.descendantForPosition({
            row: position.line,
            column: position.character
        });

        const identifier = this.resolveIdentifierNode(node);
        if (!identifier) {
            return undefined;
        }

        const hoverRange = new vscode.Range(
            new vscode.Position(identifier.startPosition.row, identifier.startPosition.column),
            new vscode.Position(identifier.endPosition.row, identifier.endPosition.column)
        );

        const name = identifier.text;
        const markdowns: vscode.MarkdownString[] = [];
        const seen = new Set<string>();

        const scopePath = this.indexer.getScopePathForNode(identifier);
        const contextHint = await this.buildContextHint(document, identifier);

        const localSymbol = this.indexer.findNearestLocalSymbol(document, identifier);
        if (localSymbol) {
            await this.appendSymbolMarkdown(document, localSymbol, markdowns, seen);
        }

        const memberMatches = await this.indexer.resolveMemberSymbol(document, identifier);
        let hasMemberMatch = false;
        if (memberMatches) {
            for (const sym of memberMatches) {
                await this.appendSymbolMarkdown(document, sym, markdowns, seen);
                hasMemberMatch = true;
            }
        }

        if (!hasMemberMatch) {
            const scopedSymbols = this.indexer.resolveSymbols(name, scopePath, {
                uri: document.uri,
                context: contextHint,
                limit: 5
            });
            for (const sym of scopedSymbols) {
                await this.appendSymbolMarkdown(document, sym, markdowns, seen);
            }
        }

        if (markdowns.length === 0) {
            const locals = await this.indexer.findSymbolsInDocument(document, name);
            for (const sym of locals) {
                await this.appendSymbolMarkdown(document, sym, markdowns, seen);
            }
        }

        if (markdowns.length > 0) {
            return new vscode.Hover(markdowns, hoverRange);
        }

        const typeInfo = this.findLocalTypeInfo(document, identifier);
        if (typeInfo) {
            const md = new vscode.MarkdownString();
            md.appendCodeblock(typeInfo.signature, 'kanagawa');
            if (typeInfo.initializer) {
                md.appendMarkdown(`\n\n**Initializer:** \`${typeInfo.initializer}\``);
            }
            return new vscode.Hover(md, hoverRange);
        }

        return undefined;
    }

    private async appendSymbolMarkdown(
        document: vscode.TextDocument,
        sym: SymbolInfo,
        bucket: vscode.MarkdownString[],
        seen: Set<string>
    ) {
        const key = `${sym.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}`;
        if (seen.has(key)) { return; }
        seen.add(key);

        const summary = (sym.signature ?? `${sym.detail ?? ''} ${sym.name}`.trim()).trim() || sym.name;
        const md = new vscode.MarkdownString();
        md.appendCodeblock(summary, 'kanagawa');
        if (sym.docMarkdown) {
            md.appendMarkdown(`\n\n${sym.docMarkdown}`);
        }

            const templateParams = (sym.category === 'class' || sym.category === 'struct' || sym.category === 'union' || sym.category === 'alias' || sym.category === 'function' || sym.category === 'method')
                ? await this.indexer.getTemplateParametersForSymbol(sym)
                : [];
            if (templateParams.length) {
                md.appendMarkdown(`\n\n**Template Parameters:**\n`);
                for (const param of templateParams) {
                    const label = param.signature ?? param.name;
                    const doc = param.docMarkdown
                        ? param.docMarkdown
                            .split(/\r?\n/)
                            .map(part => part.trim())
                            .filter(part => part.length)
                            .join(' ')
                        : undefined;
                    const line = doc ? `\`${label}\` — ${doc}` : `\`${label}\``;
                    md.appendMarkdown(`\n${line}  `);
                }
            }

        if (sym.scopePath.length > 0) {
            md.appendMarkdown(`\n\n**Scope:** ${sym.scopePath.join('::')}`);
        }
        const relative = vscode.workspace.asRelativePath(sym.uri, false);
        md.appendMarkdown(`\n\n*Defined in ${relative}*`);
        bucket.push(md);
    }

    private resolveIdentifierNode(node: any): any {
        let current = node;
        while (current) {
            if (current.type === 'identifier' || current.type === 'type_identifier') {
                return current;
            }
            if ((current.type === 'qualified_identifier' || current.type === 'template_instantiation') && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            if (current.type === 'module_name' && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            current = current.parent;
        }
        return null;
    }

    private findLocalTypeInfo(document: vscode.TextDocument, identifier: any): { signature: string; initializer?: string } | undefined {
        let current = identifier?.parent;
        while (current) {
            if (current.type === 'variable_decl') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    const typeNode = current.childForFieldName('type');
                    const initializerNode = current.childForFieldName('initializer');
                    const typeText = this.getNodeText(document, typeNode);
                    const initializerText = this.getNodeText(document, initializerNode)?.trim();
                    const signatureParts = [] as string[];
                    if (typeText) {
                        signatureParts.push(typeText.trim());
                    }
                    signatureParts.push(identifier.text);
                    return {
                        signature: signatureParts.join(' '),
                        initializer: initializerText
                    };
                }
            } else if (current.type === 'parameter') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    const typeNode = current.childForFieldName('type');
                    const typeText = this.getNodeText(document, typeNode)?.trim();
                    const signature = typeText ? `${typeText} ${identifier.text}` : identifier.text;
                    return { signature };
                }
            }
            current = current.parent;
        }
        return undefined;
    }

    private getNodeText(document: vscode.TextDocument, node: any): string | undefined {
        if (!node) { return undefined; }
        const start = new vscode.Position(node.startPosition.row, node.startPosition.column);
        const end = new vscode.Position(node.endPosition.row, node.endPosition.column);
        return document.getText(new vscode.Range(start, end));
    }

    private async buildContextHint(document: vscode.TextDocument, identifier: any): Promise<SymbolContextHint> {
        let current = identifier.parent;
        while (current) {
            if (current.type === 'member_expression' && current.namedChildCount >= 2) {
                const propertyNode = current.namedChild(current.namedChildCount - 1);
                if (propertyNode === identifier) {
                    const receiverNode = current.namedChild(0);
                    const receiverType = await this.indexer.inferTypeFromExpression(document, receiverNode ?? undefined);
                    return { kind: 'method', receiverType };
                }
            }
            current = current.parent;
        }
        return { kind: 'free' };
    }
}
