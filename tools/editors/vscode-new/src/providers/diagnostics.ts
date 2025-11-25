import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { perfLogger, PerfOps } from '../utils/perfLogger';

export class KanagawaDiagnosticsProvider {
    private collection: vscode.DiagnosticCollection;

    constructor(private service: TreeSitterService) {
        this.collection = vscode.languages.createDiagnosticCollection('kanagawa');
    }

    /**
     * Updates diagnostics for a document by analyzing its parse tree.
     */
    async updateDiagnostics(document: vscode.TextDocument) {
        const endTiming = perfLogger.start(PerfOps.DIAGNOSTICS, document.uri.toString());
        try {
            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) { return; }

            const diagnostics: vscode.Diagnostic[] = [];

            this.findErrors(document, tree.rootNode, diagnostics);

            this.collection.set(document.uri, diagnostics);
        } finally {
            endTiming();
        }
    }

    /**
     * Clears diagnostics for a document (e.g., when it's closed).
     */
    clearDiagnostics(document: vscode.TextDocument) {
        this.collection.delete(document.uri);
    }

    private findErrors(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        diagnostics: vscode.Diagnostic[]
    ) {
        if (!node.hasError()) {
            return;
        }

        if (node.type === 'ERROR') {
            const suppressed = this.isTransientCallError(node);
            const range = suppressed
                ? this.computeClampedRange(document, node)
                : new vscode.Range(
                    new vscode.Position(node.startPosition.row, node.startPosition.column),
                    new vscode.Position(node.endPosition.row, node.endPosition.column)
                );
            diagnostics.push(new vscode.Diagnostic(
                range,
                suppressed
                    ? 'Incomplete argument list; continue typing to resolve.'
                    : `Syntax error: Unexpected token '${node.text}'`,
                suppressed ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error
            ));
            return; // Don't traverse children of ERROR? Usually ERROR has children that were skipped.
        } else if (node.isMissing()) {
            const transient = this.isTransientMissingNode(node);
            const range = transient
                ? this.computeClampedRange(document, node)
                : new vscode.Range(
                    new vscode.Position(node.startPosition.row, node.startPosition.column),
                    new vscode.Position(node.endPosition.row, node.endPosition.column)
                );
            diagnostics.push(new vscode.Diagnostic(
                range,
                transient
                    ? `Incomplete ${node.type === ')' ? 'argument list' : node.type}; continue typing to resolve.`
                    : `Syntax error: Missing ${node.type}`,
                transient ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error
            ));
        }

        for (const child of node.children) {
            this.findErrors(document, child, diagnostics);
        }
    }

    private isTransientCallError(node: Parser.SyntaxNode): boolean {
        const parent = node.parent;
        if (!parent) { return false; }
        const transientContainers = new Set([
            'argument_list',
            'template_args',
            'parameter_list',
            'initializer_list'
        ]);
        if (transientContainers.has(parent.type)) {
            return true;
        }
        if (parent.type === 'call_expression') {
            const lastNamed = parent.namedChildCount > 0 ? parent.namedChild(parent.namedChildCount - 1) : undefined;
            if (lastNamed && lastNamed.id === node.id) {
                return true;
            }
        }
        return false;
    }

    private isTransientMissingNode(node: Parser.SyntaxNode): boolean {
        if (!node.isMissing()) { return false; }
        const parent = node.parent;
        if (!parent) { return false; }
        const transientTypes = new Set(['argument_list', 'template_args', 'parameter_list', 'initializer_list', 'call_expression']);
        if (!transientTypes.has(parent.type)) {
            return false;
        }
        const missingTokens = new Set([')', '>', '}', ']', ',']);
        if (missingTokens.has(node.type)) {
            return true;
        }
        return false;
    }

    private computeClampedRange(document: vscode.TextDocument, node: Parser.SyntaxNode): vscode.Range {
        const start = new vscode.Position(node.startPosition.row, node.startPosition.column);
        const lineText = document.lineAt(start.line).text;
        const endCharacter = Math.min(lineText.length, start.character + 1);
        const end = new vscode.Position(start.line, endCharacter);
        return new vscode.Range(start, end);
    }

    dispose() {
        this.collection.dispose();
    }
}
