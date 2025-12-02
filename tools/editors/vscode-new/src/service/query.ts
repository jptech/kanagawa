import * as vscode from 'vscode';

/** Maximum retries for loading a query file */
const MAX_LOAD_RETRIES = 3;
/** Delay between retries in milliseconds */
const RETRY_DELAY_MS = 100;

export class QueryManager {
    private queries: Map<string, string> = new Map();
    /** Track failed queries to avoid repeated error messages */
    private failedQueries: Set<string> = new Set();

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Load a query file with retry logic.
     * Returns cached query if already loaded.
     */
    async loadQuery(name: string): Promise<string> {
        if (this.queries.has(name)) {
            return this.queries.get(name)!;
        }

        // Don't retry queries that have permanently failed
        if (this.failedQueries.has(name)) {
            return '';
        }

        let lastError: Error | undefined;
        
        for (let attempt = 1; attempt <= MAX_LOAD_RETRIES; attempt++) {
            try {
                const queryPath = vscode.Uri.joinPath(this.context.extensionUri, 'queries', `${name}.scm`);
                const bytes = await vscode.workspace.fs.readFile(queryPath);
                const content = new TextDecoder().decode(bytes);
                
                if (content.trim().length === 0) {
                    console.warn(`Kanagawa: Query file ${name}.scm is empty`);
                }
                
                this.queries.set(name, content);
                return content;
            } catch (e) {
                lastError = e instanceof Error ? e : new Error(String(e));
                if (attempt < MAX_LOAD_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                }
            }
        }
        
        // All retries failed
        console.error(`Kanagawa: Failed to load query ${name} after ${MAX_LOAD_RETRIES} attempts:`, lastError);
        this.failedQueries.add(name);
        return '';
    }

    /**
     * Get a previously loaded query. Returns empty string if not loaded.
     */
    getQuery(name: string): string {
        return this.queries.get(name) || '';
    }

    /**
     * Check if a query is available.
     */
    hasQuery(name: string): boolean {
        return this.queries.has(name) && this.queries.get(name)!.length > 0;
    }

    /**
     * Clear the failed queries set to allow retrying.
     */
    clearFailedQueries(): void {
        this.failedQueries.clear();
    }
}
