import * as vscode from 'vscode';
import * as path from 'path';

export class QueryManager {
    private queries: Map<string, string> = new Map();

    constructor(private context: vscode.ExtensionContext) {}

    async loadQuery(name: string): Promise<string> {
        if (this.queries.has(name)) {
            return this.queries.get(name)!;
        }

        try {
            const queryPath = vscode.Uri.joinPath(this.context.extensionUri, 'queries', `${name}.scm`);
            const bytes = await vscode.workspace.fs.readFile(queryPath);
            const content = new TextDecoder().decode(bytes);
            this.queries.set(name, content);
            return content;
        } catch (e) {
            console.error(`Failed to load query ${name}:`, e);
            return '';
        }
    }

    getQuery(name: string): string {
        return this.queries.get(name) || '';
    }
}
