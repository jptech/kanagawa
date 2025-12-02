import * as vscode from 'vscode';
import { SymbolInfo, SymbolCategory, DocumentContext } from './indexer';

/**
 * Cached data for a single file.
 */
interface FileCacheEntry {
    /** File URI as string */
    uri: string;
    /** File modification time (ms since epoch) */
    mtime: number;
    /** File size in bytes (for quick change detection) */
    size: number;
    /** Extracted symbols */
    symbols: SerializedSymbol[];
    /** Document context (imports, module path) */
    context: DocumentContext;
}

/**
 * Serialized symbol for storage (ranges as numbers, not Range objects).
 */
interface SerializedSymbol {
    name: string;
    qualifiedName: string;
    // Range stored as [startLine, startChar, endLine, endChar]
    range: [number, number, number, number];
    kind: number; // vscode.SymbolKind as number
    detail?: string;
    docMarkdown?: string;
    signature?: string;
    scopePath: string[];
    category: SymbolCategory;
    typeHint?: string;
}

/**
 * Full index cache structure.
 */
interface IndexCache {
    /** Cache format version - increment when format changes */
    version: number;
    /** Timestamp when cache was created */
    timestamp: number;
    /** Map of file URI to cached data */
    files: Record<string, FileCacheEntry>;
}

const CACHE_VERSION = 1;
const CACHE_FILENAME = '.kanagawa-index-cache.json';

/**
 * Service for persisting and restoring the symbol index to/from disk.
 * This allows fast startup by only re-indexing files that have changed.
 */
export class IndexCacheService {
    private cacheUri: vscode.Uri | undefined;
    private enabled = true;

    constructor(private workspaceFolder?: vscode.WorkspaceFolder) {
        if (workspaceFolder) {
            this.cacheUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', CACHE_FILENAME);
        }
    }

    /**
     * Enables or disables caching.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * Loads the index cache from disk.
     * Returns undefined if cache doesn't exist, is invalid, or caching is disabled.
     */
    async loadCache(): Promise<IndexCache | undefined> {
        if (!this.enabled || !this.cacheUri) {
            return undefined;
        }

        try {
            const data = await vscode.workspace.fs.readFile(this.cacheUri);
            const cache = JSON.parse(Buffer.from(data).toString('utf-8')) as IndexCache;

            // Validate version
            if (cache.version !== CACHE_VERSION) {
                console.log(`Kanagawa: Index cache version mismatch (${cache.version} vs ${CACHE_VERSION}), ignoring.`);
                return undefined;
            }

            return cache;
        } catch (e) {
            // File doesn't exist or is invalid - that's fine
            return undefined;
        }
    }

    /**
     * Saves the index cache to disk.
     */
    async saveCache(cache: IndexCache): Promise<void> {
        if (!this.enabled || !this.cacheUri) {
            return;
        }

        try {
            // Ensure .vscode directory exists
            const vscodeDirUri = vscode.Uri.joinPath(this.cacheUri, '..');
            try {
                await vscode.workspace.fs.createDirectory(vscodeDirUri);
            } catch {
                // Directory may already exist
            }

            const data = Buffer.from(JSON.stringify(cache, null, 2), 'utf-8');
            await vscode.workspace.fs.writeFile(this.cacheUri, data);
        } catch (e) {
            console.warn('Kanagawa: Failed to save index cache:', e);
        }
    }

    /**
     * Deletes the index cache from disk.
     */
    async clearCache(): Promise<void> {
        if (!this.cacheUri) {
            return;
        }

        try {
            await vscode.workspace.fs.delete(this.cacheUri);
        } catch {
            // File may not exist
        }
    }

    /**
     * Checks if a file has changed since it was cached.
     * Returns true if the file should be re-indexed.
     */
    async hasFileChanged(uri: vscode.Uri, cached: FileCacheEntry | undefined): Promise<boolean> {
        if (!cached) {
            return true; // Not in cache, needs indexing
        }

        try {
            const stat = await vscode.workspace.fs.stat(uri);
            // Check both mtime and size for quick change detection
            return stat.mtime !== cached.mtime || stat.size !== cached.size;
        } catch {
            return true; // File may have been deleted/moved
        }
    }

    /**
     * Gets file stats for caching.
     */
    async getFileStats(uri: vscode.Uri): Promise<{ mtime: number; size: number } | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            return { mtime: stat.mtime, size: stat.size };
        } catch {
            return undefined;
        }
    }

    /**
     * Creates an empty cache structure.
     */
    createEmptyCache(): IndexCache {
        return {
            version: CACHE_VERSION,
            timestamp: Date.now(),
            files: {}
        };
    }

    /**
     * Serializes a SymbolInfo for storage.
     */
    serializeSymbol(symbol: SymbolInfo): SerializedSymbol {
        return {
            name: symbol.name,
            qualifiedName: symbol.qualifiedName,
            range: [
                symbol.range.start.line,
                symbol.range.start.character,
                symbol.range.end.line,
                symbol.range.end.character
            ],
            kind: symbol.kind,
            detail: symbol.detail,
            docMarkdown: symbol.docMarkdown,
            signature: symbol.signature,
            scopePath: symbol.scopePath,
            category: symbol.category,
            typeHint: symbol.typeHint
        };
    }

    /**
     * Deserializes a stored symbol back to SymbolInfo.
     */
    deserializeSymbol(serialized: SerializedSymbol, uri: vscode.Uri): SymbolInfo {
        return {
            name: serialized.name,
            qualifiedName: serialized.qualifiedName,
            uri,
            range: new vscode.Range(
                serialized.range[0],
                serialized.range[1],
                serialized.range[2],
                serialized.range[3]
            ),
            kind: serialized.kind as vscode.SymbolKind,
            detail: serialized.detail,
            docMarkdown: serialized.docMarkdown,
            signature: serialized.signature,
            scopePath: serialized.scopePath,
            category: serialized.category,
            typeHint: serialized.typeHint
        };
    }

    /**
     * Creates a cache entry for a file.
     */
    createFileCacheEntry(
        uri: vscode.Uri,
        mtime: number,
        size: number,
        symbols: SymbolInfo[],
        context: DocumentContext
    ): FileCacheEntry {
        return {
            uri: uri.toString(),
            mtime,
            size,
            symbols: symbols.map(s => this.serializeSymbol(s)),
            context
        };
    }
}
