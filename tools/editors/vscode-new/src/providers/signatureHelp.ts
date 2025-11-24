import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from '../service/indexer';

interface CallContext {
    callExpression: Parser.SyntaxNode;
    argumentList: Parser.SyntaxNode;
    callee: Parser.SyntaxNode;
}

export class KanagawaSignatureHelpProvider implements vscode.SignatureHelpProvider {
    constructor(
        private readonly service: TreeSitterService,
        private readonly indexer: WorkspaceIndexer
    ) {}

    async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.SignatureHelpContext
    ): Promise<vscode.SignatureHelp | undefined> {
        const tree = this.service.getTree(document);
        if (!tree) { return undefined; }

        const node = tree.rootNode.descendantForPosition({
            row: position.line,
            column: position.character
        });

        const callContext = this.findCallContext(node);
        if (!callContext) { return undefined; }

        const offset = document.offsetAt(position);
        const activeParameter = this.computeActiveParameter(document, callContext.argumentList, offset);

        const candidates = await this.resolveSignatures(document, callContext);
        if (!candidates.length) { return undefined; }

        const signatureHelp = new vscode.SignatureHelp();
        signatureHelp.signatures = candidates;
        signatureHelp.activeSignature = 0;
        if (signatureHelp.signatures.length > 0) {
            const paramCount = signatureHelp.signatures[0].parameters.length;
            signatureHelp.activeParameter = paramCount === 0
                ? 0
                : Math.min(activeParameter, Math.max(0, paramCount - 1));
        }

        return signatureHelp;
    }

    private findCallContext(node: Parser.SyntaxNode | null): CallContext | undefined {
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (current.type === 'argument_list') {
                const callExpression = current.parent;
                if (!callExpression || callExpression.type !== 'call_expression') {
                    return undefined;
                }
                const callee = this.getCalleeNode(callExpression);
                if (!callee) { return undefined; }
                return { callExpression, argumentList: current, callee };
            }
            current = current.parent;
        }
        return undefined;
    }

    private getCalleeNode(callExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        for (const child of callExpression.namedChildren) {
            if (child.type === 'argument_list') { continue; }
            if (child.type === 'call_attributes') { continue; }
            return child;
        }
        return undefined;
    }

    private computeActiveParameter(
        document: vscode.TextDocument,
        argumentList: Parser.SyntaxNode,
        offset: number
    ): number {
        const args = argumentList.namedChildren.filter(child => child.type !== ',');
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (offset <= arg.startIndex) {
                return i;
            }
            if (offset <= arg.endIndex) {
                return i;
            }
        }

        const text = this.getNodeText(document, argumentList);
        if (!text) { return args.length; }

        const relative = Math.min(Math.max(0, offset - argumentList.startIndex), text.length);
        let commas = 0;
        let parenDepth = 0;
        let angleDepth = 0;
        let bracketDepth = 0;
        for (let i = 0; i < relative; i++) {
            const ch = text[i];
            switch (ch) {
                case '(': parenDepth++; break;
                case ')': parenDepth = Math.max(0, parenDepth - 1); break;
                case '<': angleDepth++; break;
                case '>': angleDepth = Math.max(0, angleDepth - 1); break;
                case '[': bracketDepth++; break;
                case ']': bracketDepth = Math.max(0, bracketDepth - 1); break;
                case ',':
                    if (parenDepth <= 1 && angleDepth === 0 && bracketDepth === 0) {
                        commas++;
                    }
                    break;
                default:
                    break;
            }
        }
        return Math.min(commas, args.length);
    }

    private async resolveSignatures(
        document: vscode.TextDocument,
        callContext: CallContext
    ): Promise<vscode.SignatureInformation[]> {
        const { callee } = callContext;
        let symbols: SymbolInfo[] = [];

        if (callee.type === 'member_expression') {
            const propertyNode = callee.namedChild(callee.namedChildCount - 1);
            if (propertyNode) {
                const matches = await this.indexer.resolveMemberSymbol(document, propertyNode);
                if (matches && matches.length > 0) {
                    symbols = matches;
                }
            }
        }

        if (!symbols.length) {
            const identifier = this.extractIdentifierNode(callee);
            if (identifier) {
                const scopePath = this.indexer.getScopePathForNode(identifier);
                const contextHint: SymbolContextHint = { kind: 'free' };
                const resolved = this.indexer.resolveSymbols(identifier.text, scopePath, {
                    uri: document.uri,
                    context: contextHint,
                    limit: 5
                });
                symbols = resolved;
            }
        }

        if (!symbols.length) {
            return [];
        }

        return symbols.map(symbol => this.convertToSignatureInformation(symbol));
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

    private convertToSignatureInformation(symbol: SymbolInfo): vscode.SignatureInformation {
        const fallback = `${symbol.detail ?? ''} ${symbol.name}`.trim();
        const label = (symbol.signature ?? fallback) || symbol.name;
        const signatureInfo = new vscode.SignatureInformation(label, symbol.docMarkdown);
        const parameters = this.parseParametersFromSignature(label);
        signatureInfo.parameters = parameters.map(paramLabel => new vscode.ParameterInformation(paramLabel.trim()));
        return signatureInfo;
    }

    private parseParametersFromSignature(signature: string): string[] {
        const openIndex = signature.indexOf('(');
        const closeIndex = signature.lastIndexOf(')');
        if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
            return [];
        }
        const body = signature.slice(openIndex + 1, closeIndex).trim();
        if (!body.length) { return []; }

        const parts: string[] = [];
        let current = '';
        let parenDepth = 0;
        let angleDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;

        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            switch (ch) {
                case '(': parenDepth++; current += ch; break;
                case ')': parenDepth = Math.max(0, parenDepth - 1); current += ch; break;
                case '<': angleDepth++; current += ch; break;
                case '>': angleDepth = Math.max(0, angleDepth - 1); current += ch; break;
                case '[': bracketDepth++; current += ch; break;
                case ']': bracketDepth = Math.max(0, bracketDepth - 1); current += ch; break;
                case '{': braceDepth++; current += ch; break;
                case '}': braceDepth = Math.max(0, braceDepth - 1); current += ch; break;
                case ',':
                    if (parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                        parts.push(current.trim());
                        current = '';
                    } else {
                        current += ch;
                    }
                    break;
                default:
                    current += ch;
                    break;
            }
        }
        if (current.trim().length > 0) {
            parts.push(current.trim());
        }
        return parts;
    }

    private getNodeText(document: vscode.TextDocument, node: Parser.SyntaxNode | null): string | undefined {
        if (!node) { return undefined; }
        const start = new vscode.Position(node.startPosition.row, node.startPosition.column);
        const end = new vscode.Position(node.endPosition.row, node.endPosition.column);
        return document.getText(new vscode.Range(start, end));
    }
}
