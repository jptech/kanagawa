import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as path from 'path';
import { perfLogger, PerfOps } from '../utils/perfLogger';

/**
 * Cached query objects to avoid repeated parsing of query strings.
 */
interface QueryCache {
    query: Parser.Query;
    queryString: string;
}

/**
 * Simple mutex for serializing async operations.
 * Tree-sitter WASM is not thread-safe and cannot handle concurrent parsing.
 */
class AsyncMutex {
    private locked = false;
    private waiting: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (!this.locked) {
            this.locked = true;
            return;
        }

        return new Promise<void>(resolve => {
            this.waiting.push(resolve);
        });
    }

    release(): void {
        if (this.waiting.length > 0) {
            const next = this.waiting.shift()!;
            next();
        } else {
            this.locked = false;
        }
    }
}

/**
 * TreeSitterService provides parsing services for Kanagawa source files.
 * 
 * Features:
 * - Incremental parsing for efficient updates during editing
 * - Query caching to avoid repeated query compilation
 * - Proper resource cleanup for parse trees
 * - Thread-safe parsing via mutex (WASM parser is not thread-safe)
 */
export class TreeSitterService {
    private parser: Parser | undefined;
    private trees: Map<string, Parser.Tree> = new Map();
    private language: Parser.Language | undefined;
    
    /** Cache for compiled queries to avoid re-parsing query strings */
    private queryCache: Map<string, QueryCache> = new Map();
    
    /** Maximum number of queries to cache */
    private static readonly MAX_QUERY_CACHE_SIZE = 20;

    /** 
     * Mutex to serialize parsing operations.
     * Tree-sitter WASM cannot handle concurrent parse calls.
     */
    private parseMutex = new AsyncMutex();

    constructor(private context: vscode.ExtensionContext) {}

    async init() {
        try {
            // Explicitly point to the runtime WASM in the dist folder
            const runtimeWasmPath = path.join(this.context.extensionPath, 'dist', 'tree-sitter.wasm');
            await Parser.init({
                locateFile: () => runtimeWasmPath
            });

            const langWasmPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'tree-sitter-kanagawa.wasm');
            
            // For web compatibility, we read file as bytes.
            const bits = await vscode.workspace.fs.readFile(langWasmPath);
            this.language = await Parser.Language.load(bits);
            
            this.parser = new Parser();
            this.parser.setLanguage(this.language);
            console.log('Kanagawa: Tree-sitter initialized successfully.');
        } catch (e) {
            console.error('Failed to initialize TreeSitterService:', e);
            vscode.window.showErrorMessage(`Kanagawa: Failed to load Tree-sitter parser: ${e}`);
        }
    }

    getParser(): Parser | undefined {
        return this.parser;
    }

    getLanguage(): Parser.Language | undefined {
        return this.language;
    }

    getTree(document: vscode.TextDocument): Parser.Tree | undefined {
        return this.trees.get(document.uri.toString());
    }

    /**
     * Parses a document, using incremental parsing if possible.
     * This method is serialized via mutex because Tree-sitter WASM is not thread-safe.
     * 
     * @param document The document to parse
     * @param contentChanges Optional content changes for incremental parsing.
     *                       If not provided, a full reparse is performed.
     * @returns The parse tree, or undefined if parsing failed
     */
    async parse(
        document: vscode.TextDocument,
        contentChanges?: readonly vscode.TextDocumentContentChangeEvent[]
    ): Promise<Parser.Tree | undefined> {
        if (!this.parser) {
            console.warn('Kanagawa: Parser not initialized.');
            return undefined;
        }

        const uri = document.uri.toString();
        const isIncremental = contentChanges && contentChanges.length > 0;
        const opName = isIncremental ? PerfOps.PARSE_INCREMENTAL : PerfOps.PARSE_FULL;
        const endTiming = perfLogger.start(opName, uri);

        // Serialize parsing operations - Tree-sitter WASM cannot handle concurrent parsing
        await this.parseMutex.acquire();
        
        const previous = this.trees.get(uri);

        try {
            let newTree: Parser.Tree;

            // Use incremental parsing if we have a previous tree and content changes
            if (previous && isIncremental) {
                newTree = this.parseIncremental(document, previous, contentChanges!);
            } else {
                // Full reparse - either no previous tree or no change information
                newTree = this.parser.parse(document.getText());
            }

            // Clean up old tree after successful parse
            if (previous) {
                previous.delete();
            }

            this.trees.set(uri, newTree);
            return newTree;
        } catch (e) {
            console.error('Kanagawa: Parse failed:', e);
            // Keep the old tree on parse failure rather than leaving no tree
            return previous;
        } finally {
            this.parseMutex.release();
            endTiming();
        }
    }

    /**
     * Performs incremental parsing by applying edits to the old tree.
     * This is significantly faster than full reparsing for small changes.
     */
    private parseIncremental(
        document: vscode.TextDocument,
        oldTree: Parser.Tree,
        changes: readonly vscode.TextDocumentContentChangeEvent[]
    ): Parser.Tree {
        // Apply each edit to the tree in order
        // Note: Tree-sitter expects edits to be applied in the order they occurred
        for (const change of changes) {
            // Handle full document replacement (no range)
            if (!change.range) {
                // Full document change - fall back to full reparse
                return this.parser!.parse(document.getText());
            }

            const startIndex = document.offsetAt(change.range.start);
            const oldEndIndex = startIndex + change.rangeLength;
            const newEndIndex = startIndex + change.text.length;

            const startPosition = {
                row: change.range.start.line,
                column: change.range.start.character
            };

            // Calculate old end position from the range
            const oldEndPosition = {
                row: change.range.end.line,
                column: change.range.end.character
            };

            // Calculate new end position based on inserted text
            const newEndPosition = this.calculateNewEndPosition(
                change.range.start,
                change.text
            );

            oldTree.edit({
                startIndex,
                oldEndIndex,
                newEndIndex,
                startPosition,
                oldEndPosition,
                newEndPosition
            });
        }

        // Parse with the edited tree for incremental parsing
        return this.parser!.parse(document.getText(), oldTree);
    }

    /**
     * Calculates the end position after inserting text at a given start position.
     */
    private calculateNewEndPosition(
        start: vscode.Position,
        insertedText: string
    ): Parser.Point {
        const lines = insertedText.split(/\r?\n/);
        
        if (lines.length === 1) {
            // Single line - end is on same row, column advanced by text length
            return {
                row: start.line,
                column: start.character + insertedText.length
            };
        } else {
            // Multi-line - end is on the last line
            return {
                row: start.line + lines.length - 1,
                column: lines[lines.length - 1].length
            };
        }
    }

    /**
     * Removes the cached parse tree for a document.
     * Should be called when a document is closed to free memory.
     */
    remove(document: vscode.TextDocument) {
        const uri = document.uri.toString();
        const tree = this.trees.get(uri);
        if (tree) {
            tree.delete();
            this.trees.delete(uri);
        }
    }

    /**
     * Executes a Tree-sitter query on a syntax node.
     * Queries are cached for performance.
     * 
     * @param node The node to query
     * @param queryString The Tree-sitter query string (S-expression)
     * @returns Array of query captures, or empty array on error
     */
    query(node: Parser.SyntaxNode, queryString: string): Parser.QueryCapture[] {
        if (!this.language) { return []; }

        return perfLogger.measureSync(PerfOps.QUERY_EXECUTE, undefined, () => {
            try {
                const query = this.getOrCreateQuery(queryString);
                return query.captures(node);
            } catch (e) {
                console.error('Kanagawa: Query failed:', e);
                return [];
            }
        });
    }

    /**
     * Gets a cached query or creates and caches a new one.
     */
    private getOrCreateQuery(queryString: string): Parser.Query {
        const cached = this.queryCache.get(queryString);
        if (cached) {
            return cached.query;
        }

        // Create new query
        const query = this.language!.query(queryString);
        
        // Evict oldest entries if cache is full
        if (this.queryCache.size >= TreeSitterService.MAX_QUERY_CACHE_SIZE) {
            const firstKey = this.queryCache.keys().next().value;
            if (firstKey) {
                this.queryCache.delete(firstKey);
            }
        }

        this.queryCache.set(queryString, { query, queryString });
        return query;
    }

    /**
     * Clears the query cache. Useful if queries are updated externally.
     */
    clearQueryCache() {
        this.queryCache.clear();
    }

    /**
     * Returns the number of documents currently being tracked.
     */
    getTrackedDocumentCount(): number {
        return this.trees.size;
    }
}
