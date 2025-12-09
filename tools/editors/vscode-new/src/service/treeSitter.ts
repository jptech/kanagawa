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
 * Error thrown when mutex acquisition times out.
 */
class MutexTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Mutex acquisition timed out after ${timeoutMs}ms`);
        this.name = 'MutexTimeoutError';
    }
}

/** Default timeout for mutex acquisition (5 seconds) */
const DEFAULT_MUTEX_TIMEOUT_MS = 5000;

/**
 * Simple mutex for serializing async operations.
 * Tree-sitter WASM is not thread-safe and cannot handle concurrent parsing.
 * 
 * Features:
 * - Timeout protection to prevent indefinite blocking
 * - Queue tracking for diagnostics
 */
class AsyncMutex {
    private locked = false;
    private waiting: { resolve: () => void; reject: (error: Error) => void; timeoutId?: NodeJS.Timeout }[] = [];

    /**
     * Acquires the mutex lock.
     * 
     * @param timeoutMs Maximum time to wait for lock acquisition (default: 5000ms)
     * @throws MutexTimeoutError if timeout is exceeded
     */
    async acquire(timeoutMs: number = DEFAULT_MUTEX_TIMEOUT_MS): Promise<void> {
        if (!this.locked) {
            this.locked = true;
            return;
        }

        return new Promise<void>((resolve, reject) => {
            const entry: { resolve: () => void; reject: (error: Error) => void; timeoutId?: NodeJS.Timeout } = {
                resolve,
                reject
            };
            
            // Set up timeout
            entry.timeoutId = setTimeout(() => {
                // Remove from waiting queue
                const index = this.waiting.indexOf(entry);
                if (index !== -1) {
                    this.waiting.splice(index, 1);
                }
                reject(new MutexTimeoutError(timeoutMs));
            }, timeoutMs);
            
            this.waiting.push(entry);
        });
    }

    release(): void {
        if (this.waiting.length > 0) {
            const next = this.waiting.shift()!;
            // Clear the timeout since we're granting the lock
            if (next.timeoutId) {
                clearTimeout(next.timeoutId);
            }
            next.resolve();
        } else {
            this.locked = false;
        }
    }
    
    /**
     * Returns the number of operations waiting for the lock.
     * Useful for diagnostics.
     */
    getQueueLength(): number {
        return this.waiting.length;
    }
    
    /**
     * Returns true if the mutex is currently locked.
     */
    isLocked(): boolean {
        return this.locked;
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

    /** Track initialization state for graceful degradation */
    private initialized = false;
    private initializationError: Error | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Initialize the Tree-sitter parser and language.
     * @returns true if initialization succeeded, false otherwise
     */
    async init(): Promise<boolean> {
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
            this.initialized = true;
            console.log('Kanagawa: Tree-sitter initialized successfully.');
            return true;
        } catch (e) {
            this.initializationError = e instanceof Error ? e : new Error(String(e));
            console.error('Failed to initialize TreeSitterService:', e);
            vscode.window.showErrorMessage(`Kanagawa: Failed to load Tree-sitter parser: ${e}`);
            return false;
        }
    }

    /**
     * Returns true if the parser is ready to use.
     */
    isReady(): boolean {
        return this.initialized && this.parser !== undefined;
    }

    /**
     * Returns the initialization error if init failed.
     */
    getInitError(): Error | undefined {
        return this.initializationError;
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
        // Use timeout to prevent indefinite blocking if a parse operation hangs
        try {
            await this.parseMutex.acquire();
        } catch (error) {
            if (error instanceof Error && error.name === 'MutexTimeoutError') {
                console.error(`Kanagawa: Parse mutex acquisition timed out for ${uri}. Another parse operation may be hanging.`);
                endTiming();
                // Return cached tree if available, otherwise undefined
                return this.trees.get(uri);
            }
            throw error;
        }
        
        const previous = this.trees.get(uri);

        try {
            let newTree: Parser.Tree;

            // Use incremental parsing if we have a previous tree and content changes
            if (previous && isIncremental) {
                try {
                    newTree = this.parseIncremental(document, previous, contentChanges!);
                } catch (incrementalError) {
                    // Incremental parse failed - fall back to full reparse
                    console.warn('Kanagawa: Incremental parse failed, falling back to full parse:', incrementalError);
                    newTree = this.parser.parse(document.getText());
                }
            } else {
                // Full reparse - either no previous tree or no change information
                newTree = this.parser.parse(document.getText());
            }

            // Clean up old tree after successful parse
            if (previous) {
                try {
                    previous.delete();
                } catch (deleteError) {
                    // Tree deletion can fail if already deleted - ignore
                    console.warn('Kanagawa: Failed to delete old tree:', deleteError);
                }
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
     * 
     * Note: This method is synchronized with parse() to prevent race conditions
     * where a tree is being removed while it's being replaced.
     */
    async remove(document: vscode.TextDocument): Promise<void> {
        const uri = document.uri.toString();
        
        // Acquire mutex to prevent race with concurrent parse operations
        await this.parseMutex.acquire();
        try {
            const tree = this.trees.get(uri);
            if (tree) {
                try {
                    tree.delete();
                } catch (e) {
                    // Tree may already be deleted - this is fine
                    console.warn('Kanagawa: Failed to delete tree on remove:', e);
                }
                this.trees.delete(uri);
            }
        } finally {
            this.parseMutex.release();
        }
    }
    
    /**
     * Synchronous version of remove for use in event handlers.
     * Does not wait for mutex - best effort cleanup.
     * Use this when you can't await (e.g., in synchronous event handlers).
     */
    removeSync(document: vscode.TextDocument): void {
        const uri = document.uri.toString();
        const tree = this.trees.get(uri);
        if (tree) {
            try {
                tree.delete();
            } catch (e) {
                // Tree may already be deleted or in use - ignore
            }
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
