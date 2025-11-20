import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';

export class KanagawaDiagnosticsProvider {
    private collection: vscode.DiagnosticCollection;

    constructor(private service: TreeSitterService) {
        this.collection = vscode.languages.createDiagnosticCollection('kanagawa');
    }

    updateDiagnostics(document: vscode.TextDocument) {
        const tree = this.service.getTree(document);
        if (!tree) { return; }

        const diagnostics: vscode.Diagnostic[] = [];
        
        this.findErrors(tree.rootNode, diagnostics);
        
        this.collection.set(document.uri, diagnostics);
    }

    private findErrors(node: Parser.SyntaxNode, diagnostics: vscode.Diagnostic[]) {
        if (!node.hasError()) {
            return;
        }

        if (node.type === 'ERROR') {
            const range = new vscode.Range(
                new vscode.Position(node.startPosition.row, node.startPosition.column),
                new vscode.Position(node.endPosition.row, node.endPosition.column)
            );
            diagnostics.push(new vscode.Diagnostic(
                range,
                `Syntax error: Unexpected token '${node.text}'`,
                vscode.DiagnosticSeverity.Error
            ));
            return; // Don't traverse children of ERROR? Usually ERROR has children that were skipped.
        } else if (node.isMissing()) {
            const range = new vscode.Range(
                new vscode.Position(node.startPosition.row, node.startPosition.column),
                new vscode.Position(node.endPosition.row, node.endPosition.column)
            );
            diagnostics.push(new vscode.Diagnostic(
                range,
                `Syntax error: Missing ${node.type}`,
                vscode.DiagnosticSeverity.Error
            ));
        }

        for (const child of node.children) {
            this.findErrors(child, diagnostics);
        }
    }

    dispose() {
        this.collection.dispose();
    }
}
