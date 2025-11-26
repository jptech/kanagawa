import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as path from 'path';
import { TreeSitterService } from './treeSitter';
import { QueryManager } from './query';
import { ImportConfigService, ImportConfiguration } from './importConfig';
import { matchesGlobPattern } from '../utils/globUtils';
import { perfLogger, PerfOps } from '../utils/perfLogger';
import {
    normalizeTypeName as normalizeTypeNameUtil,
    sanitizeTypeText as sanitizeTypeTextUtil,
    lastSegment as lastSegmentUtil
} from '../utils/typeUtils';
import {
    computeQualifiedName,
    computeAccessibilityScore,
    createResolutionResult,
    ResolutionResult
} from '../utils/symbolUtils';
import {
    ModuleExports,
    ResolvedImports,
    resolveImports,
    filterByAccessibility,
    extractModuleFromQualified
} from '../utils/importUtils';
import {
    MemberResolutionOptions,
    MemberResolutionResult,
    getContainerFromMember,
    filterDirectMembers,
    filterMembersByOptions,
    sortMembers,
    findBestContainer,
    extractTemplateBaseType
} from '../utils/memberUtils';
import {
    TemplateType,
    TemplateParameter,
    TemplateInstantiation,
    TemplateContext,
    isTemplatedType,
    parseTemplateType,
    createInstantiation,
    instantiateMethodSignature,
    substituteParameters,
    buildInstantiationKey,
    parseTemplateParameters,
    hasUnresolvedTemplateParams,
    applyTemplateContext,
    createEmptyContext
} from '../utils/templateUtils';

export type SymbolCategory =
    | 'module'
    | 'class'
    | 'struct'
    | 'union'
    | 'enum'
    | 'function'
    | 'method'
    | 'variable'
    | 'member'
    | 'constant'
    | 'alias'
    | 'other';

export interface DocumentImport {
    path: string;
    alias?: string;
}

export interface DocumentContext {
    modulePath?: string;
    imports: DocumentImport[];
}

export type SymbolContextHint =
    | { kind: 'method'; receiverType?: string }
    | { kind: 'free' }
    | { kind: 'unknown' };

export interface ResolveOptions {
    uri?: vscode.Uri;
    context?: SymbolContextHint;
    limit?: number;
}

export interface SymbolInfo {
    name: string;
    /** Fully qualified name in the form module::Container::name */
    qualifiedName: string;
    uri: vscode.Uri;
    range: vscode.Range;
    kind: vscode.SymbolKind;
    detail?: string;
    docMarkdown?: string;
    signature?: string;
    scopePath: string[];
    category: SymbolCategory;
    typeHint?: string;
}

/** Maximum depth for alias chain resolution to prevent infinite loops */
const MAX_ALIAS_CHAIN_DEPTH = 50;

/** Default chunk size for batch file processing during indexing */
const INDEX_CHUNK_SIZE = 10;

export class WorkspaceIndexer {
    /** Primary index: name → SymbolInfo[] (for prefix matching, completions) */
    private symbolIndex: Map<string, SymbolInfo[]> = new Map();
    /** Secondary index: qualifiedName → SymbolInfo (for exact resolution) */
    private qualifiedIndex: Map<string, SymbolInfo> = new Map();
    /** Module exports: modulePath → ModuleExports (for import-aware resolution) */
    private moduleExports: Map<string, ModuleExports> = new Map();
    /** Cached resolved imports per document */
    private resolvedImportsCache: Map<string, ResolvedImports> = new Map();
    private isIndexing = false;
    /** Cancellation token for the current indexing operation */
    private indexingCancellation: vscode.CancellationTokenSource | undefined;
    private documentContexts: Map<string, DocumentContext> = new Map();
    private verbose = false;
    private recentlyIndexed = 0;
    private readonly templateWrappers = new Set<string>([
        'function_template',
        'class_template',
        'struct_template',
        'union_template',
        'alias_template',
        'enum_template'
    ]);
    private readonly typeInferenceCache: Map<string, Map<number, string>> = new Map();
    private readonly memberCache: Map<string, SymbolInfo[]> = new Map();
    /** Reverse mapping: URI → Set of cache keys (type names) with members from that URI */
    private readonly memberCacheByUri: Map<string, Set<string>> = new Map();
    private readonly aliasMap: Map<string, { target: string; uri: string }> = new Map();
    /** Cache for template instantiations: key → TemplateInstantiation */
    private readonly templateInstantiationCache: Map<string, TemplateInstantiation> = new Map();
    /** Cache for template parameters by type: baseType → TemplateParameter[] */
    private readonly templateParameterCache: Map<string, TemplateParameter[]> = new Map();
    private readonly importConfigServices: Map<string, ImportConfigService> = new Map();
    private pendingRescan = false;
    /** Set of indexed file URIs for stats tracking */
    private indexedFiles: Set<string> = new Set();
    /** Callback for status updates during indexing */
    private onStatusChange?: (state: 'idle' | 'indexing' | 'error', symbolCount: number, fileCount: number, error?: string) => void;

    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager,
        private workspaceFolders?: readonly vscode.WorkspaceFolder[]
    ) {
        // Create import config service for each workspace folder
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                this.importConfigServices.set(folder.uri.toString(), new ImportConfigService(folder));
            }
        }
        // Fallback for no workspace folders
        if (this.importConfigServices.size === 0) {
            this.importConfigServices.set('default', new ImportConfigService(undefined));
        }
    }

    /**
     * Sets a callback to receive status updates during indexing.
     */
    setStatusCallback(callback: (state: 'idle' | 'indexing' | 'error', symbolCount: number, fileCount: number, error?: string) => void): void {
        this.onStatusChange = callback;
    }

    private notifyStatus(state: 'idle' | 'indexing' | 'error', error?: string): void {
        this.onStatusChange?.(state, this.symbolIndex.size, this.indexedFiles.size, error);
    }

    async init(context: vscode.ExtensionContext): Promise<void> {
        for (const importConfig of this.importConfigServices.values()) {
            await importConfig.init(context);
            context.subscriptions.push(importConfig.onDidChange(() => {
                this.memberCache.clear();
                this.typeInferenceCache.clear();
                this.handleImportConfigurationChanged();
            }));
        }
        
        // Listen for workspace folder changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders((event) => {
                // Add new folders
                for (const folder of event.added) {
                    const config = new ImportConfigService(folder);
                    this.importConfigServices.set(folder.uri.toString(), config);
                    config.init(context).catch(err => 
                        console.error('Kanagawa: Failed to init import config for folder:', err)
                    );
                }
                // Remove old folders
                for (const folder of event.removed) {
                    this.importConfigServices.delete(folder.uri.toString());
                }
                // Trigger rescan
                this.handleImportConfigurationChanged();
            })
        );
    }

    async getImportConfiguration(): Promise<ImportConfiguration> {
        // Merge configurations from all workspace folders
        const configs = await Promise.all(
            Array.from(this.importConfigServices.values()).map(s => s.resolveImportConfiguration())
        );
        
        const merged: ImportConfiguration = {
            importPaths: [],
            excludePatterns: []
        };
        
        const seenPaths = new Set<string>();
        const seenPatterns = new Set<string>();
        
        for (const config of configs) {
            for (const p of config.importPaths) {
                if (!seenPaths.has(p)) {
                    seenPaths.add(p);
                    merged.importPaths.push(p);
                }
            }
            for (const p of config.excludePatterns) {
                if (!seenPatterns.has(p)) {
                    seenPatterns.add(p);
                    merged.excludePatterns.push(p);
                }
            }
            if (config.stdlibPath && !merged.stdlibPath) {
                merged.stdlibPath = config.stdlibPath;
            }
        }
        
        return merged;
    }

    /**
     * Scans the workspace and indexes all Kanagawa source files.
     * Uses chunked processing with cancellation support to avoid blocking the UI.
     * 
     * @param token Optional cancellation token to abort the scan early
     */
    async scanWorkspace(token?: vscode.CancellationToken) {
        if (this.isIndexing) {
            this.pendingRescan = true;
            // Cancel any in-progress indexing if a new scan is requested
            this.indexingCancellation?.cancel();
            return;
        }

        const endTiming = perfLogger.start(PerfOps.INDEX_SCAN, 'workspace');

        // Create a new cancellation source that combines external token with internal control
        this.indexingCancellation = new vscode.CancellationTokenSource();
        if (token) {
            token.onCancellationRequested(() => this.indexingCancellation?.cancel());
        }
        const effectiveToken = this.indexingCancellation.token;

        this.isIndexing = true;
        let shouldRescan = false;

        try {
            // Clear all indices before starting fresh scan
            this.symbolIndex.clear();
            this.qualifiedIndex.clear();
            this.moduleExports.clear();
            this.resolvedImportsCache.clear();
            this.documentContexts.clear();
            this.memberCache.clear();
            this.typeInferenceCache.clear();
            this.aliasMap.clear();
            this.indexedFiles.clear();
            this.clearTemplateCaches();

            if (effectiveToken.isCancellationRequested) { return; }

            this.notifyStatus('indexing');
            const importConfiguration = await this.getImportConfiguration();

            // Ensure query is loaded and cached inside the query manager
            const queryString = await this.queryManager.loadQuery('definitions');
            if (!queryString) {
                console.error('Kanagawa: Unable to load definitions query.');
                return;
            }

            if (effectiveToken.isCancellationRequested) { return; }

            // Include stdlibPath in the paths to scan (it should be treated as an import path)
            const allImportPaths = [...importConfiguration.importPaths];
            if (importConfiguration.stdlibPath) {
                allImportPaths.push(importConfiguration.stdlibPath);
            }
            const files = await this.collectSourceFiles(allImportPaths, importConfiguration.excludePatterns);
            
            // Pre-load all documents in parallel (I/O bound)
            // This is much faster than loading one-by-one during indexing
            const preloadEndTiming = perfLogger.start(PerfOps.INDEX_PRELOAD, 'documents');
            const documentPromises = files.map(async (uri): Promise<vscode.TextDocument | undefined> => {
                try {
                    return await vscode.workspace.openTextDocument(uri);
                } catch (e) {
                    console.warn(`Kanagawa: Failed to open ${uri.toString()}:`, e);
                    return undefined;
                }
            });
            const documents = await Promise.all(documentPromises);
            preloadEndTiming();
            
            // Create a map for quick lookup
            const documentMap = new Map<string, vscode.TextDocument>();
            for (let i = 0; i < files.length; i++) {
                const doc = documents[i];
                if (doc) {
                    documentMap.set(files[i].toString(), doc);
                }
            }
            
            // Process in chunks to avoid blocking UI, with cancellation checks
            // Note: Parsing is serialized by mutex, but symbol extraction can overlap
            for (let i = 0; i < files.length; i += INDEX_CHUNK_SIZE) {
                if (effectiveToken.isCancellationRequested) {
                    console.log('Kanagawa: Workspace scan cancelled.');
                    return;
                }

                const chunk = files.slice(i, i + INDEX_CHUNK_SIZE);
                await Promise.all(chunk.map(async (uri: vscode.Uri) => {
                    if (!effectiveToken.isCancellationRequested) {
                        const doc = documentMap.get(uri.toString());
                        if (doc) {
                            await this.indexFileWithDocument(uri, doc, queryString);
                        }
                    }
                }));
                
                // Yield to event loop to keep UI responsive
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            
            if (effectiveToken.isCancellationRequested) { return; }

            // Build module exports index after all files are indexed
            this.buildModuleExports();
            
            this.recentlyIndexed = 0;
            console.log(`Kanagawa: Indexed ${this.symbolIndex.size} symbols from ${files.length} files.`);
            if (this.verbose) {
                console.log(`Kanagawa: Indexed ${this.symbolIndex.size} symbol names from ${files.length} files.`);
            }
            
            this.notifyStatus('idle');

            // Check if a rescan was requested while we were indexing
            shouldRescan = this.pendingRescan;
            this.pendingRescan = false;

        } catch (e) {
            console.error('Kanagawa: Error during workspace scan:', e);
            this.notifyStatus('error', String(e));
        } finally {
            // Always reset indexing state, even on error
            this.isIndexing = false;
            this.indexingCancellation?.dispose();
            this.indexingCancellation = undefined;
            endTiming();
        }

        // Trigger rescan outside of try/finally to avoid re-entrancy issues
        if (shouldRescan) {
            this.scanWorkspace().catch((err) => {
                console.error('Kanagawa: Error during pending rescan:', err);
                this.notifyStatus('error', String(err));
            });
        }
    }

    async indexFile(uri: vscode.Uri, queryString?: string) {
        const document = await vscode.workspace.openTextDocument(uri);
        return this.indexFileWithDocument(uri, document, queryString);
    }

    /**
     * Indexes a file with a pre-loaded document.
     * Used during workspace scan when documents are pre-loaded in parallel.
     */
    private async indexFileWithDocument(uri: vscode.Uri, document: vscode.TextDocument, queryString?: string) {
        const endTiming = perfLogger.start(PerfOps.INDEX_FILE, uri.toString());
        
        // Mark as indexed to prevent duplicate work from ensureFileIndexed
        this.indexedFiles.add(uri.toString());
        
        try {
            if (this.verbose) {
                console.log('Kanagawa: Indexing file:', uri.toString());
            }
            this.clearDocumentCaches(uri);
            
            // Parse document (serialized via mutex in TreeSitterService)
            const tree = await this.service.parse(document);
            if (!tree) { 
                console.warn('Kanagawa: No tree for file:', uri.toString());
                return; 
            }

            if (!queryString) {
                const loaded = await this.queryManager.loadQuery('definitions');
                if (!loaded) {
                    console.error('Kanagawa: Definitions query not loaded.');
                    return;
                }
                queryString = loaded;
            }

            // Symbol extraction (CPU-bound, can run in parallel after parsing)
            const symbols = this.extractSymbols(document, tree, queryString, uri);
            const context = this.collectDocumentContext(tree.rootNode);
            this.documentContexts.set(uri.toString(), context);
            this.addSymbols(symbols);
            // Smart cache invalidation: only clear cached members that could be affected
            // by changes in this specific file, rather than clearing the entire cache
            this.invalidateMemberCacheForUri(uri);
            this.recentlyIndexed += symbols.length;
        } catch (e) {
            console.error(`Failed to index ${uri.toString()}:`, e);
        } finally {
            endTiming();
        }
    }

    /**
     * Ensures a file is indexed. Called when a file is opened to provide
     * immediate hover/go-to-definition support even before full workspace scan completes.
     * 
     * This is a no-op if the file is already indexed.
     */
    async ensureFileIndexed(uri: vscode.Uri): Promise<void> {
        const uriStr = uri.toString();
        if (this.indexedFiles.has(uriStr)) {
            return; // Already indexed
        }

        // Mark as indexed to prevent duplicate work
        this.indexedFiles.add(uriStr);

        try {
            // Index the file
            await this.indexFile(uri);

            // Also index its imports for better resolution
            const context = this.documentContexts.get(uriStr);
            if (context?.imports) {
                for (const imp of context.imports) {
                    try {
                        // Resolve the import path to a URI and index if not already done
                        const importUri = await this.resolveImportToUri(imp.path);
                        if (importUri && !this.indexedFiles.has(importUri.toString())) {
                            this.indexedFiles.add(importUri.toString());
                            // Index imports in background (don't await, errors logged inside indexFile)
                            this.indexFile(importUri).catch((err) => {
                                console.warn(`Kanagawa: Failed to index import ${imp.path}:`, err);
                            });
                        }
                    } catch (err) {
                        // Ignore individual import resolution failures
                        console.warn(`Kanagawa: Failed to resolve import ${imp.path}:`, err);
                    }
                }
            }
        } catch (err) {
            // Remove from indexed set so it can be retried
            this.indexedFiles.delete(uriStr);
            throw err;
        }
    }

    /**
     * Resolves an import path to a file URI.
     */
    private async resolveImportToUri(importPath: string): Promise<vscode.Uri | undefined> {
        try {
            const config = await this.getImportConfiguration();
            const parts = importPath.split('.');
            const baseName = parts[parts.length - 1];
            // Try .k first, then .pd
            const possibleFileNames = [baseName + '.k', baseName + '.pd'];
            const dirPath = parts.slice(0, -1).join('/');

            for (const basePath of config.importPaths) {
                for (const fileName of possibleFileNames) {
                    const fullPath = dirPath ? `${basePath}/${dirPath}/${fileName}` : `${basePath}/${fileName}`;
                    const uri = vscode.Uri.file(fullPath);
                    try {
                        await vscode.workspace.fs.stat(uri);
                        return uri;
                    } catch {
                        // File doesn't exist at this path, try next
                    }
                }
            }
        } catch {
            // Ignore resolution errors
        }
        return undefined;
    }
    
    private findCaptureByName(
        captures: Parser.QueryCapture[],
        name: string,
        parentNode: Parser.SyntaxNode
    ): Parser.SyntaxNode | null {
        for (const capture of captures) {
            if (capture.name !== name) { continue; }

            // Fast path: check by range containment first. This avoids relying on
            // object identity for SyntaxNode wrappers, which are not stable across
            // repeated lookups when using the WASM bindings.
            if (capture.node.startIndex >= parentNode.startIndex && capture.node.endIndex <= parentNode.endIndex) {
                return capture.node;
            }

            // Fallback to ancestor walk for completeness (handles overlapping
            // captures such as templates where the identifier is nested under a
            // function definition which itself sits beneath the template node).
            let node: Parser.SyntaxNode | null = capture.node;
            while (node) {
                if (node.id === parentNode.id) { // Compare by node id to avoid wrapper inequality
                    return capture.node;
                }
                node = node.parent;
            }
        }
        return null;
    }

    private extractSymbols(
        document: vscode.TextDocument,
        tree: Parser.Tree,
        queryString: string,
        uri: vscode.Uri
    ): SymbolInfo[] {
        const captures = this.service.query(tree.rootNode, queryString);
        if (!captures.length) { return []; }

        const { preDocs, postDocs } = this.prepareDocCommentMaps(captures);
        const processedNodes = new Set<number>();
        const symbols: SymbolInfo[] = [];

        for (const capture of captures) {
            if (capture.name === 'doc.comment') { continue; }
            const nodeId = capture.node.id;
            if (processedNodes.has(nodeId)) { continue; }

            let kind = vscode.SymbolKind.Variable;
            let label = '';
            let nameCapture = '';
            let category: SymbolCategory = 'other';
            let typeHint: string | undefined;

            switch (capture.name) {
                case 'module':
                    kind = vscode.SymbolKind.Module;
                    label = 'module';
                    nameCapture = 'module.name';
                    category = 'module';
                    break;
                case 'class':
                    kind = vscode.SymbolKind.Class;
                    label = 'class';
                    nameCapture = 'class.name';
                    category = 'class';
                    break;
                case 'struct':
                    kind = vscode.SymbolKind.Struct;
                    label = 'struct';
                    nameCapture = 'struct.name';
                    category = 'struct';
                    break;
                case 'union':
                    kind = vscode.SymbolKind.Struct;
                    label = 'union';
                    nameCapture = 'union.name';
                    category = 'union';
                    break;
                case 'enum':
                    kind = vscode.SymbolKind.Enum;
                    label = 'enum';
                    nameCapture = 'enum.name';
                    category = 'enum';
                    break;
                case 'function':
                    kind = vscode.SymbolKind.Function;
                    label = 'function';
                    nameCapture = 'function.name';
                    category = this.isMethod(capture.node) ? 'method' : 'function';
                    {
                        const returnNode = capture.node.childForFieldName('return_type');
                        if (returnNode) {
                            typeHint = this.sanitizeTypeText(returnNode.text);
                        }
                    }
                    break;
                case 'alias':
                    kind = vscode.SymbolKind.TypeParameter;
                    label = 'type alias';
                    nameCapture = 'alias.name';
                    category = 'alias';
                    {
                        const aliasTarget = this.extractAliasTarget(capture.node);
                        if (aliasTarget) {
                            typeHint = this.sanitizeTypeText(aliasTarget);
                        }
                    }
                    break;
                case 'variable':
                    kind = vscode.SymbolKind.Variable;
                    label = 'variable';
                    nameCapture = 'variable.name';
                    category = 'variable';
                    typeHint = this.extractTypeHint(capture.node);
                    break;
                case 'member':
                    kind = vscode.SymbolKind.Field;
                    label = 'member';
                    nameCapture = 'member.name';
                    category = 'member';
                    typeHint = this.extractTypeHint(capture.node);
                    break;
                case 'constant':
                    kind = vscode.SymbolKind.EnumMember;
                    label = 'constant';
                    nameCapture = 'constant.name';
                    category = 'constant';
                    break;
                default:
                    continue;
            }

            const nameNode = this.findCaptureByName(captures, nameCapture, capture.node);
            if (!nameNode) { continue; }

            const range = new vscode.Range(
                new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
            );

            const docMarkdown = this.collectDocBlock(document, capture.node, preDocs, postDocs);
            let signature = this.buildSignature(document, capture.name, capture.node, nameNode);
            if (signature && signature.length > 180) {
                signature = signature.slice(0, 177) + '…';
            }

            if (category === 'alias' && typeHint) {
                const aliasKey = this.normalizeTypeName(nameNode.text);
                const targetNormalized = this.normalizeTypeName(typeHint);
                if (aliasKey && targetNormalized) {
                    const canonicalTarget = this.resolveAliasChain(targetNormalized);
                    this.aliasMap.set(aliasKey, { target: canonicalTarget, uri: uri.toString() });
                }
            }

            const scopePath = this.buildScopePath(capture.node);
            const qualifiedName = computeQualifiedName(nameNode.text, scopePath);

            symbols.push({
                name: nameNode.text,
                qualifiedName,
                uri,
                range,
                kind,
                detail: label,
                docMarkdown,
                signature,
                scopePath,
                category,
                typeHint
            });

            processedNodes.add(nodeId);
        }

        return symbols;
    }

    private addSymbols(symbols: SymbolInfo[]) {
        for (const info of symbols) {
            // Add to primary index (name → [symbols])
            const list = this.symbolIndex.get(info.name) ?? [];
            list.push(info);
            this.symbolIndex.set(info.name, list);
            
            // Add to qualified index (qualifiedName → symbol)
            // Note: last-write-wins for duplicate qualified names in the same file
            this.qualifiedIndex.set(info.qualifiedName, info);
        }
    }

    public clearIndex() {
        this.symbolIndex.clear();
        this.qualifiedIndex.clear();
        this.moduleExports.clear();
        this.resolvedImportsCache.clear();
        this.documentContexts.clear();
        this.memberCache.clear();
        this.memberCacheByUri.clear();
        this.typeInferenceCache.clear();
        this.recentlyIndexed = 0;
        this.aliasMap.clear();
        this.clearTemplateCaches();
    }

    /**
     * Builds the module exports index from all indexed symbols.
     * Called after indexing is complete.
     */
    private buildModuleExports(): void {
        this.moduleExports.clear();
        
        for (const symbol of this.qualifiedIndex.values()) {
            const modulePath = extractModuleFromQualified(symbol.qualifiedName);
            if (!modulePath) {
                continue; // Skip global symbols for module exports
            }
            
            let exports = this.moduleExports.get(modulePath);
            if (!exports) {
                exports = {
                    modulePath,
                    exportedSymbols: new Set(),
                    exportedNames: new Set()
                };
                this.moduleExports.set(modulePath, exports);
            }
            
            exports.exportedSymbols.add(symbol.qualifiedName);
            exports.exportedNames.add(symbol.name);
        }
        
        if (this.verbose) {
            console.log(`Kanagawa: Built exports for ${this.moduleExports.size} modules.`);
        }
    }

    /**
     * Gets or computes the resolved imports for a document.
     */
    public getResolvedImports(uri: vscode.Uri): ResolvedImports {
        const key = uri.toString();
        
        // Check cache
        const cached = this.resolvedImportsCache.get(key);
        if (cached) {
            return cached;
        }
        
        // Get document context
        const context = this.documentContexts.get(key);
        if (!context) {
            // Return empty resolved imports for unknown documents
            return {
                currentModule: undefined,
                importedModules: new Set(),
                aliasToModule: new Map(),
                accessibleQualifiedNames: new Set()
            };
        }
        
        // Resolve imports
        const resolved = resolveImports(
            context.modulePath,
            context.imports,
            this.moduleExports
        );
        
        // Cache and return
        this.resolvedImportsCache.set(key, resolved);
        return resolved;
    }

    /**
     * Invalidates the resolved imports cache for a document.
     */
    private invalidateResolvedImports(uri: vscode.Uri): void {
        this.resolvedImportsCache.delete(uri.toString());
    }

    public toggleVerbose() {
        this.verbose = !this.verbose;
        return this.verbose;
    }

    public getStats() {
        const files = new Set<string>();
        for (const list of this.symbolIndex.values()) {
            for (const sym of list) {
                files.add(sym.uri.toString());
            }
        }
        return {
            totalSymbols: this.symbolIndex.size,
            uniqueFiles: files.size,
            recentlyIndexed: this.recentlyIndexed,
            verbose: this.verbose
        };
    }

    private collectDocumentContext(root: Parser.SyntaxNode): DocumentContext {
        const context: DocumentContext = { imports: [] };

        for (const child of root.namedChildren) {
            if (!context.modulePath && child.type === 'module_decl') {
                const nameNode = child.childForFieldName('name');
                if (nameNode) {
                    context.modulePath = nameNode.text;
                }
            }

            if (child.type === 'import_decl') {
                const pathNode = child.childForFieldName('path');
                if (!pathNode) { continue; }
                const aliasNode = child.childForFieldName('alias');
                context.imports.push({
                    path: pathNode.text,
                    alias: aliasNode ? aliasNode.text : undefined
                });
            }
        }

        return context;
    }

    /**
     * Invalidates only the member cache entries that might be affected by changes to a specific URI.
     * This is more efficient than clearing the entire cache when a single file changes.
     * 
     * @param uri The URI of the changed document
     */
    private invalidateMemberCacheForUri(uri: vscode.Uri): void {
        const target = uri.toString();
        const affectedKeys = this.memberCacheByUri.get(target);
        
        if (affectedKeys) {
            // Remove cache entries for types that had members from this file
            for (const key of affectedKeys) {
                this.memberCache.delete(key);
            }
            this.memberCacheByUri.delete(target);
            
            if (this.verbose) {
                console.log(`Kanagawa: Invalidated ${affectedKeys.size} member cache entries for ${target}`);
            }
        }
        
        // Also clean up reverse mapping entries that reference this URI
        for (const [_, cacheKeys] of this.memberCacheByUri) {
            // Note: We don't need to do anything here since the forward mapping
            // will be rebuilt when getMembersForType is called
        }
    }

    private removeSymbolsForUri(uri: vscode.Uri) {
        const target = uri.toString();
        for (const [key, list] of this.symbolIndex.entries()) {
            const filtered = list.filter(entry => entry.uri.toString() !== target);
            if (filtered.length === 0) {
                this.symbolIndex.delete(key);
            } else if (filtered.length !== list.length) {
                this.symbolIndex.set(key, filtered);
            }
        }
        
        // Remove qualified index entries from this file
        for (const [qn, sym] of this.qualifiedIndex.entries()) {
            if (sym.uri.toString() === target) {
                this.qualifiedIndex.delete(qn);
            }
        }
        
        this.documentContexts.delete(target);
        this.typeInferenceCache.delete(target);
        
        // Use targeted cache invalidation instead of clearing everything
        this.invalidateMemberCacheForUri(uri);
        
        for (const [alias, record] of this.aliasMap.entries()) {
            if (record.uri === target) {
                this.aliasMap.delete(alias);
            }
        }
    }

    private isMethod(node: Parser.SyntaxNode): boolean {
        let current: Parser.SyntaxNode | null = node.parent;
        while (current) {
            if (current.type === 'member_decl') {
                return true;
            }
            if (current.type === 'class_decl' || current.type === 'struct_decl' || current.type === 'union_decl') {
                return true;
            }
            if (current.type === 'module_decl' || current.type === 'source_file') {
                return false;
            }
            current = current.parent;
        }
        return false;
    }

    private extractTypeHint(node: Parser.SyntaxNode): string | undefined {
        const typeNode = this.findTypeNode(node);
        return typeNode ? typeNode.text.trim() : undefined;
    }

    private findTypeNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
        const typeField = node.childForFieldName('type');
        if (typeField) { return typeField; }

        for (const child of node.namedChildren) {
            const nested = this.findTypeNode(child);
            if (nested) { return nested; }
        }

        return null;
    }

    private prepareDocCommentMaps(captures: Parser.QueryCapture[]) {
        const preDocs = new Map<number, string>();
        const postDocs = new Map<number, string>();

        for (const capture of captures) {
            if (capture.name !== 'doc.comment') { continue; }
            const text = capture.node.text;
            if (text.startsWith('//|')) {
                preDocs.set(capture.node.startPosition.row, this.cleanDocComment(text));
            } else if (text.startsWith('//<')) {
                postDocs.set(capture.node.startPosition.row, this.cleanDocComment(text));
            }
        }

        return { preDocs, postDocs };
    }

    private collectDocBlock(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        preDocs: Map<number, string>,
        postDocs: Map<number, string>
    ): string | undefined {
        const anchor = this.getDocAnchorNode(node);

        const lines = this.collectLeadingDocLines(document, anchor, preDocs);

        let line = node.endPosition.row;
        while (postDocs.has(line)) {
            lines.push(postDocs.get(line)!);
            line++;
        }

        if (!lines.length) { return undefined; }
        return lines.join('\n');
    }

    private cleanDocComment(raw: string): string {
        return raw.slice(3).trim();
    }

    private buildSignature(
        document: vscode.TextDocument,
        captureName: string,
        defNode: Parser.SyntaxNode,
        nameNode: Parser.SyntaxNode
    ): string | undefined {
        const anchor = this.getDocAnchorNode(defNode);
        const start = new vscode.Position(anchor.startPosition.row, anchor.startPosition.column);
        let end = new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column);

        if (captureName === 'function') {
            const params = defNode.childForFieldName('parameters');
            if (params) {
                end = new vscode.Position(params.endPosition.row, params.endPosition.column);
            }
        } else if (captureName === 'variable' || captureName === 'member') {
            const initializer = defNode.childForFieldName('initializer');
            if (initializer) {
                end = new vscode.Position(initializer.endPosition.row, initializer.endPosition.column);
            }
        }

        const rawText = document.getText(new vscode.Range(start, end));
        const stripped = this.stripInlineDocComments(rawText).trim();
        if (!stripped) { return undefined; }
        return stripped.replace(/\s+/g, ' ');
    }

    private getDocAnchorNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
        let anchor: Parser.SyntaxNode = node;
        while (anchor.parent && this.templateWrappers.has(anchor.parent.type)) {
            anchor = anchor.parent;
        }
        return anchor;
    }

    private buildScopePath(node: Parser.SyntaxNode): string[] {
        const anchor = this.getDocAnchorNode(node);
        return this.collectScopePath(anchor.parent);
    }

    private collectScopePath(start: Parser.SyntaxNode | null): string[] {
        const segments: string[] = [];
        let current = start;

        while (current) {
            const container = this.resolveContainerName(current);
            if (container) {
                segments.unshift(container);
            }
            current = current.parent;
        }

        return segments;
    }

    private resolveContainerName(node: Parser.SyntaxNode): string | undefined {
        switch (node.type) {
            case 'module_decl':
            case 'class_decl':
            case 'struct_decl':
            case 'union_decl':
            case 'enum_decl':
                return this.extractNodeName(node);
            case 'function_definition':
                return this.extractNodeName(node);
            case 'class_template':
            case 'struct_template':
            case 'union_template':
            case 'function_template':
            case 'alias_template':
            case 'enum_template':
                // Skip template wrapper; actual declarations handled by children.
                return undefined;
            default:
                return undefined;
        }
    }

    private extractNodeName(node: Parser.SyntaxNode): string | undefined {
        const field = node.childForFieldName('name');
        if (field) {
            return field.text;
        }

        for (const child of node.namedChildren) {
            if (child.type === 'identifier' || child.type === 'module_name') {
                return child.text;
            }
        }

        return undefined;
    }

    public getScopePathForNode(node: Parser.SyntaxNode): string[] {
        return this.collectScopePath(node.parent);
    }

    public findNearestLocalSymbol(document: vscode.TextDocument, identifier: Parser.SyntaxNode): SymbolInfo | undefined {
        const targetName = identifier.text;
        const limit = identifier.startIndex;

        let current: Parser.SyntaxNode | null = identifier.parent;
        while (current) {
            const templateSymbol = this.findTemplateParameterSymbol(document, current, targetName);
            if (templateSymbol) {
                return templateSymbol;
            }

            if (current.type === 'block' || current.type === 'compound_statement') {
                const decl = this.findDeclarationInScope(current, targetName, limit);
                if (decl) {
                    return this.buildLocalSymbolInfo(document, decl, targetName);
                }
            }

            if (current.type === 'function_definition') {
                const templateMatch = this.findTemplateParameterSymbol(document, current.parent, targetName);
                if (templateMatch) {
                    return templateMatch;
                }
                const param = this.findParameterDeclaration(current, targetName);
                if (param) {
                    return this.buildLocalSymbolInfo(document, param, targetName);
                }
            }

            current = current.parent;
        }

        return undefined;
    }

    /**
     * @deprecated Use `resolveWithContext()` instead for consistent resolution across providers.
     * This method is kept for backward compatibility but will be removed in a future version.
     * 
     * `resolveWithContext()` provides:
     * - Import-aware filtering
     * - Confidence scoring
     * - Consistent behavior with hover/definition/references
     */
    public resolveSymbols(name: string, scopePath: string[], options?: ResolveOptions): SymbolInfo[] {
        let candidates = this.symbolIndex.get(name) ?? [];
        if (candidates.length === 0) {
            const normalized = this.normalizeTypeName(name);
            if (normalized && normalized !== name) {
                candidates = this.symbolIndex.get(normalized) ?? [];
            }
            if (candidates.length === 0 && normalized) {
                const canonical = this.resolveAliasChain(normalized);
                if (canonical && canonical !== normalized) {
                    candidates = this.symbolIndex.get(canonical) ?? [];
                }
            }
        }
        if (candidates.length === 0) { return []; }

        const limit = options?.limit ?? 5;
        const uriString = options?.uri?.toString();

        const exactScope = candidates.filter(info => this.pathsEqual(info.scopePath, scopePath));
        if (exactScope.length > 0) {
            return this.sortCandidatesWithScore(exactScope, scopePath, options).slice(0, limit);
        }

        const sameFile = uriString ? candidates.filter(info => info.uri.toString() === uriString) : [];
        if (sameFile.length > 0) {
            return this.sortCandidatesWithScore(sameFile, scopePath, options).slice(0, limit);
        }

        const scoredAll = this.scoreCandidates(candidates, scopePath, options).sort((a, b) => b.score - a.score);
        if (scoredAll.length === 0) { return []; }

        const bestScore = scoredAll[0].score;
        const filtered = scoredAll.filter(entry => entry.score > 0 && entry.score >= bestScore - 10);
        const preferred = (filtered.length > 0 ? filtered : scoredAll).map(entry => entry.info);
        return preferred.slice(0, limit);
    }

    /**
     * Resolve a symbol by its fully qualified name.
     * Returns a single symbol with exact match, or undefined.
     */
    public resolveQualified(qualifiedName: string): SymbolInfo | undefined {
        return this.qualifiedIndex.get(qualifiedName);
    }

    /**
     * Resolve a symbol with full context awareness and confidence scoring.
     * Returns a resolution result with the best match and alternatives.
     * Uses import-aware filtering to prioritize accessible symbols.
     */
    public resolveWithContext(
        name: string,
        scopePath: string[],
        options?: ResolveOptions
    ): ResolutionResult<SymbolInfo> {
        let candidates = this.symbolIndex.get(name) ?? [];
        if (candidates.length === 0) {
            return createResolutionResult<SymbolInfo>([], () => 0);
        }

        // Get resolved imports for import-aware filtering
        const resolvedImports = options?.uri
            ? this.getResolvedImports(options.uri)
            : undefined;

        // Filter by accessibility if we have import information
        if (resolvedImports) {
            const filtered = filterByAccessibility(candidates, resolvedImports, {
                includeInaccessible: false
            });
            // Fall back to all candidates if nothing is accessible
            if (filtered.length > 0) {
                candidates = filtered;
            }
        }

        // Score candidates with additional context bonuses
        const scored = candidates.map(info => {
            let score = 0;

            // Import-based score
            if (resolvedImports) {
                const modulePath = extractModuleFromQualified(info.qualifiedName);
                
                // Same module = highest priority
                if (modulePath && modulePath === resolvedImports.currentModule) {
                    score += 100;
                }
                // Imported module
                else if (modulePath && resolvedImports.importedModules.has(modulePath)) {
                    score += 50;
                }
                // Global (no module)
                else if (!modulePath) {
                    score += 20;
                }
            } else {
                // Legacy scoring when no import info
                const documentModule = options?.uri
                    ? this.documentContexts.get(options.uri.toString())?.modulePath
                    : undefined;
                const imports = options?.uri
                    ? this.documentContexts.get(options.uri.toString())?.imports ?? []
                    : [];
                const symbolModule = info.scopePath.length > 0 && info.scopePath[0].includes('.')
                    ? info.scopePath[0]
                    : undefined;

                score = computeAccessibilityScore(
                    symbolModule,
                    info.scopePath,
                    documentModule,
                    imports,
                    scopePath
                );
            }

            // Context hint bonuses
            const hint = options?.context ?? { kind: 'unknown' };
            if (hint.kind === 'method') {
                if (info.category === 'method') {
                    score += 20;
                } else if (info.category === 'function') {
                    score -= 10;
                }
                if (hint.receiverType) {
                    const normalizedReceiver = this.normalizeTypeName(hint.receiverType);
                    const containerName = info.scopePath[info.scopePath.length - 1];
                    if (containerName && this.normalizeTypeName(containerName) === normalizedReceiver) {
                        score += 35;
                    }
                }
            } else if (hint.kind === 'free') {
                if (info.category === 'method') {
                    score -= 10;
                }
            }

            // Same file bonus
            if (options?.uri && info.uri.toString() === options.uri.toString()) {
                score += 15;
            }

            // Exact scope match bonus
            if (this.pathsEqual(info.scopePath, scopePath)) {
                score += 200;
            }

            return { info, score };
        });

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        const sortedSymbols = scored.map(s => s.info);
        const scoreGetter = (info: SymbolInfo) => {
            const entry = scored.find(s => s.info === info);
            return entry?.score ?? 0;
        };

        return createResolutionResult(sortedSymbols, scoreGetter);
    }

    /**
     * Resolve symbols with import-aware filtering.
     * Returns only symbols accessible from the given document.
     */
    public resolveAccessible(
        name: string,
        options?: ResolveOptions
    ): SymbolInfo[] {
        const candidates = this.symbolIndex.get(name) ?? [];
        if (candidates.length === 0) {
            return [];
        }

        if (!options?.uri) {
            return candidates;
        }

        const resolvedImports = this.getResolvedImports(options.uri);
        return filterByAccessibility(candidates, resolvedImports, {
            includeInaccessible: false
        });
    }

    /**
     * Get symbol by qualified name, with fallback to best-effort resolution.
     * Tries exact qualified match first, then falls back to scored resolution.
     */
    public getSymbol(
        name: string,
        scopePath: string[],
        options?: ResolveOptions
    ): SymbolInfo | undefined {
        // Try exact qualified match first
        const qualifiedName = computeQualifiedName(name, scopePath);
        const exact = this.qualifiedIndex.get(qualifiedName);
        if (exact) {
            return exact;
        }

        // Fall back to scored resolution
        const result = this.resolveWithContext(name, scopePath, options);
        return result.primary;
    }

    private handleImportConfigurationChanged(): void {
        if (this.isIndexing) {
            this.pendingRescan = true;
            return;
        }
        this.scanWorkspace().catch((err) => {
            console.error('Kanagawa: Error during import configuration change rescan:', err);
            this.notifyStatus('error', String(err));
        });
    }

    private async collectSourceFiles(extraPaths: string[], excludePatterns: string[]): Promise<vscode.Uri[]> {
        const workspaceFiles = await vscode.workspace.findFiles('**/*.{k,pd}', '**/node_modules/**');
        const externalFiles = await this.collectExternalSourceFiles(extraPaths, excludePatterns);
        const uriMap = new Map<string, vscode.Uri>();
        
        // Apply exclude patterns to workspace files
        for (const uri of workspaceFiles) {
            if (!this.isExcluded(uri, excludePatterns)) {
                const key = uri.toString();
                if (!uriMap.has(key)) {
                    uriMap.set(key, uri);
                }
            }
        }
        
        // External files already filtered during collection
        for (const uri of externalFiles) {
            const key = uri.toString();
            if (!uriMap.has(key)) {
                uriMap.set(key, uri);
            }
        }
        
        return Array.from(uriMap.values());
    }

    private isExcluded(uri: vscode.Uri, excludePatterns: string[]): boolean {
        if (excludePatterns.length === 0) { return false; }
        
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        
        for (const pattern of excludePatterns) {
            if (matchesGlobPattern(relativePath, pattern)) {
                return true;
            }
        }
        return false;
    }

    private async collectExternalSourceFiles(paths: string[], excludePatterns: string[]): Promise<vscode.Uri[]> {
        const results: vscode.Uri[] = [];
        const visitedRoots = new Set<string>();
        const visitedDirs = new Set<string>();

        for (const raw of paths) {
            if (!raw || !raw.trim()) { continue; }
            const normalized = path.normalize(path.resolve(raw));
            if (visitedRoots.has(normalized)) { continue; }
            visitedRoots.add(normalized);

            const rootUri = vscode.Uri.file(normalized);
            await this.walkKanagawaDirectory(rootUri, results, visitedDirs, excludePatterns, normalized);
        }

        return results;
    }

    private async walkKanagawaDirectory(
        rootUri: vscode.Uri,
        results: vscode.Uri[],
        visitedDirs: Set<string>,
        excludePatterns: string[],
        baseDir: string
    ): Promise<void> {
        const dirKey = rootUri.fsPath;
        if (visitedDirs.has(dirKey)) { return; }
        visitedDirs.add(dirKey);

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(rootUri);
        } catch {
            return;
        }

        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(rootUri, name);

            if ((type & vscode.FileType.SymbolicLink) !== 0) { continue; }

            if ((type & vscode.FileType.File) !== 0) {
                if (name.endsWith('.k') || name.endsWith('.pd')) {
                    // Check exclude patterns for external files
                    const relativePath = entryUri.fsPath.substring(baseDir.length + 1).replace(/\\/g, '/');
                    let excluded = false;
                    for (const pattern of excludePatterns) {
                        if (matchesGlobPattern(relativePath, pattern)) {
                            excluded = true;
                            break;
                        }
                    }
                    if (!excluded) {
                        results.push(entryUri);
                    }
                }
                continue;
            }

            if ((type & vscode.FileType.Directory) === 0) { continue; }

            if (this.shouldSkipDirectory(name)) { continue; }
            await this.walkKanagawaDirectory(entryUri, results, visitedDirs, excludePatterns, baseDir);
        }
    }

    private shouldSkipDirectory(name: string): boolean {
        const lower = name.toLowerCase();
        if (lower === '.git' || lower === '.hg' || lower === '.svn' || lower === 'node_modules') { return true; }
        if (lower === 'build' || lower === 'dist' || lower === 'out') { return true; }
        if (name.startsWith('.') && name !== '.kanagawa') { return true; }
        return false;
    }

    private computeScopeSimilarity(target: string[], candidate: string[]): number {
        if (target.length === 0 && candidate.length === 0) {
            return 10;
        }

        let reverseScore = 0;
        const minTail = Math.min(target.length, candidate.length);
        for (let i = 1; i <= minTail; i++) {
            if (target[target.length - i] === candidate[candidate.length - i]) {
                reverseScore += i * 20;
            } else {
                break;
            }
        }

        let prefixScore = 0;
        const minPrefix = Math.min(target.length, candidate.length);
        for (let i = 0; i < minPrefix; i++) {
            if (target[i] === candidate[i]) {
                prefixScore += 5;
            } else {
                break;
            }
        }

        return reverseScore + prefixScore;
    }

    private pathsEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) { return false; }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) { return false; }
        }
        return true;
    }

    async findSymbolsInDocument(document: vscode.TextDocument, name: string): Promise<SymbolInfo[]> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { return []; }

        const queryString = await this.queryManager.loadQuery('definitions');
        if (!queryString) { return []; }

        const symbols = this.extractSymbols(document, tree, queryString, document.uri);
        return symbols.filter(sym => sym.name === name);
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

    getIndexedUris(): vscode.Uri[] {
        const uris: vscode.Uri[] = [];
        for (const key of this.documentContexts.keys()) {
            try {
                uris.push(vscode.Uri.parse(key));
            } catch (e) {
                // ignore malformed entries
            }
        }
        return uris;
    }
    
    async updateFile(uri: vscode.Uri) {
        this.removeSymbolsForUri(uri);
        await this.indexFile(uri);
    }

    public async inferTypeFromExpression(document: vscode.TextDocument, expression?: Parser.SyntaxNode): Promise<string | undefined> {
        if (!expression) { return undefined; }

        const docKey = document.uri.toString();
        const cache = this.typeInferenceCache.get(docKey) ?? new Map<number, string>();
        if (cache.has(expression.id)) {
            const cached = cache.get(expression.id);
            return cached && cached.length ? cached : undefined;
        }

        let inferred: string | undefined;

        if (expression.type === 'identifier') {
            const local = this.findNearestLocalSymbol(document, expression);
            if (local?.typeHint) {
                inferred = local.typeHint;
            } else {
                const symbols = await this.findSymbolsInDocument(document, expression.text);
                const variable = symbols.find(sym => sym.category === 'variable' || sym.category === 'member');
                inferred = variable?.typeHint;
            }
        } else if (expression.type === 'qualified_identifier') {
            // Handle scope-qualified identifiers like Foo::Bar::VALUE
            // Extract all identifier segments and look up the member in the containing scope
            const identifiers = expression.children.filter(c => c.type === 'identifier');
            if (identifiers.length >= 2) {
                // Build the scope path from all but the last identifier
                const scopeParts = identifiers.slice(0, -1).map(id => id.text);
                const memberName = identifiers[identifiers.length - 1].text;
                const scopeType = scopeParts.join('::');
                
                // Look up the member in that scope
                const member = this.getMemberInfo(scopeType, memberName);
                if (member?.typeHint) {
                    inferred = member.typeHint;
                } else {
                    // Fall back to looking up the full qualified name
                    const fullName = expression.text.replace(/::/g, '::');
                    const symbols = this.symbolIndex.get(memberName);
                    const match = symbols?.find(sym => 
                        sym.scopePath.join('::') === scopeType || 
                        sym.qualifiedName === fullName
                    );
                    inferred = match?.typeHint;
                }
            }
        } else if (expression.type === 'template_instantiation') {
            const normalized = this.normalizeTypeName(expression.text);
            inferred = normalized.length ? normalized : undefined;
        } else if (expression.type === 'member_expression') {
            const objectNode = expression.namedChild(0);
            const propertyNode = expression.namedChild(expression.namedChildCount - 1);
            const objectType = await this.inferTypeFromExpression(document, objectNode ?? undefined);
            if (objectType && propertyNode) {
                const member = this.getMemberInfo(objectType, propertyNode.text);
                inferred = member?.typeHint;
            }
        } else if (expression.type === 'call_expression') {
            inferred = await this.inferCallExpressionType(document, expression);
        }

        // Apply enclosing template context if the inferred type has unresolved parameters
        if (inferred && hasUnresolvedTemplateParams(inferred)) {
            const enclosingContext = this.getEnclosingTemplateContext(document, expression);
            if (enclosingContext.parameters.size > 0) {
                inferred = applyTemplateContext(inferred, enclosingContext);
            }
        }

        if (inferred) {
            cache.set(expression.id, inferred);
            this.typeInferenceCache.set(docKey, cache);
            return inferred;
        }

        cache.set(expression.id, '');
        this.typeInferenceCache.set(docKey, cache);
        return undefined;
    }

    /**
     * Infers the return type of a call expression, handling:
     * - Cast expressions: `cast<Type>(value)` → Type
     * - Member method calls: `obj.method()` → method's return type
     * - Free function calls: `func()` → function's return type
     * - Constructor calls: `Foo<T>()` → Foo
     */
    private async inferCallExpressionType(
        document: vscode.TextDocument,
        callExpression: Parser.SyntaxNode
    ): Promise<string | undefined> {
        const callee = this.getCallTarget(callExpression);
        if (!callee) { return undefined; }

        // Handle cast expressions: cast<Type>(value), static_cast<Type>(value), etc.
        if (callee.type === 'cast_operator') {
            return this.extractCastTargetType(callee);
        }

        // Handle member method calls: obj.method()
        if (callee.type === 'member_expression') {
            return this.inferMemberCallReturnType(document, callee);
        }

        // Handle free function calls or constructor calls
        const idNode = this.extractIdentifierFromExpression(callee);
        if (!idNode) { return undefined; }

        // Check if this looks like a constructor call (identifier matches a known class)
        const className = this.normalizeTypeName(callee.text);
        if (className) {
            const classSymbols = this.symbolIndex.get(className);
            const isClass = classSymbols?.some(sym =>
                sym.category === 'class' || sym.category === 'struct'
            );
            if (isClass) {
                return className;
            }
        }

        // Otherwise resolve as a free function call and get its return type
        const scopePath = this.getScopePathForNode(idNode);
        // Use resolveWithContext for consistency with other providers
        const resolution = this.resolveWithContext(idNode.text, scopePath, {
            uri: document.uri,
            context: { kind: 'free' }
        });

        // Collect all candidates (primary + alternatives)
        const candidates: SymbolInfo[] = [];
        if (resolution.primary) {
            candidates.push(resolution.primary);
        }
        candidates.push(...resolution.alternatives);

        // Return the typeHint (return type) of the first matching function
        const match = candidates.find(candidate =>
            (candidate.category === 'function' || candidate.category === 'method') &&
            !!candidate.typeHint
        );
        return match?.typeHint;
    }

    /**
     * Extracts the target type from a cast_operator node.
     * Handles: cast<float>, static_cast<uint32>, reinterpret_cast<T>, checked_cast<Type>
     */
    private extractCastTargetType(castOperator: Parser.SyntaxNode): string | undefined {
        // The cast_operator structure is: cast<Type> where Type can be:
        // - type_specifier (identifier or templated)
        // - primitive_type (int, uint, float32, etc.)
        for (const child of castOperator.namedChildren) {
            if (child.type === 'type_specifier' ||
                child.type === 'primitive_type' ||
                child.type === 'modified_type' ||
                child.type === 'array_type') {
                return this.sanitizeTypeText(child.text);
            }
        }
        return undefined;
    }

    /**
     * Infers the return type of a member method call: obj.method()
     */
    private async inferMemberCallReturnType(
        document: vscode.TextDocument,
        memberExpression: Parser.SyntaxNode
    ): Promise<string | undefined> {
        const propertyNode = this.getMemberIdentifier(memberExpression);
        if (!propertyNode) { return undefined; }

        // First try to resolve as a member method
        const memberMatches = await this.resolveMemberSymbol(document, propertyNode);
        if (memberMatches?.length) {
            // Find a function/method with a return type
            const methodMatch = memberMatches.find(sym =>
                (sym.category === 'function' || sym.category === 'method') &&
                !!sym.typeHint
            );
            if (methodMatch?.typeHint) {
                return methodMatch.typeHint;
            }
        }

        // Fall back to any symbol with a type hint
        const anyMatch = memberMatches?.find(sym => !!sym.typeHint);
        return anyMatch?.typeHint;
    }

    public async resolveMemberSymbol(
        document: vscode.TextDocument,
        identifier: Parser.SyntaxNode
    ): Promise<SymbolInfo[] | undefined> {
        const parent = identifier.parent;
        if (!parent || parent.type !== 'member_expression') {
            return undefined;
        }

        const receiverNode = parent.namedChild(0);
        if (!receiverNode) { return undefined; }
        const memberName = identifier.text;

        const receiverType = await this.inferTypeFromExpression(document, receiverNode);
        if (!receiverType) { return undefined; }

        // Check if this is a call context (member is being called as a method)
        const grandparent = parent.parent;
        const isCallContext = grandparent?.type === 'call_expression';

        // Get both methods and fields - the caller can filter based on context
        const members = this.getMembersForType(receiverType, {
            includeMethods: true,
            includeFields: true
        });
        let matches = members.filter(sym => sym.name === memberName);
        
        // If in call context, prefer methods; otherwise prefer fields
        if (isCallContext && matches.length > 1) {
            const methods = matches.filter(sym => sym.category === 'method' || sym.category === 'function');
            if (methods.length > 0) {
                matches = methods;
            }
        }

        if (matches.length === 0) {
            return undefined;
        }
        
        // Apply template instantiation if the receiver is a templated type
        if (isTemplatedType(receiverType)) {
            const instantiation = await this.getTemplateInstantiation(receiverType);
            if (instantiation) {
                // Return copies of symbols with instantiated signatures and typeHints
                return matches.map(sym => {
                    if (!sym.signature && !sym.typeHint) {
                        return sym;
                    }
                    
                    const instantiatedSignature = sym.signature 
                        ? instantiateMethodSignature(sym.signature, instantiation)
                        : undefined;
                    const instantiatedTypeHint = sym.typeHint
                        ? substituteParameters(sym.typeHint, instantiation.substitutions)
                        : undefined;
                    
                    // Only return a new object if something changed
                    if (instantiatedSignature === sym.signature && instantiatedTypeHint === sym.typeHint) {
                        return sym;
                    }
                    
                    return {
                        ...sym,
                        signature: instantiatedSignature ?? sym.signature,
                        typeHint: instantiatedTypeHint ?? sym.typeHint
                    };
                });
            }
        }
        
        return matches;
    }

    public getMembersForType(typeName: string, options?: { includeMethods?: boolean; includeFields?: boolean }): SymbolInfo[] {
        if (!typeName) { return []; }
        const normalized = this.normalizeTypeName(typeName);
        if (!normalized) { return []; }
        const canonical = this.resolveAliasChain(normalized);

        if (this.memberCache.has(canonical)) {
            return this.filterMembers(this.memberCache.get(canonical) ?? [], options);
        }

        const results: SymbolInfo[] = [];
        const seen = new Set<string>();
        const contributingUris = new Set<string>();

        for (const list of this.symbolIndex.values()) {
            for (const sym of list) {
                if (!sym.scopePath.length) { continue; }
                const container = sym.scopePath[sym.scopePath.length - 1];
                if (!container) { continue; }
                const containerKey = this.resolveAliasChain(this.normalizeTypeName(container));
                if (containerKey !== canonical) { continue; }

                const key = `${sym.name}|${sym.uri.toString()}|${sym.range.start.line}|${sym.category}`;
                if (seen.has(key)) { continue; }
                seen.add(key);
                results.push(sym);
                
                // Track which URIs contribute to this cache entry
                contributingUris.add(sym.uri.toString());
            }
        }

        results.sort((a, b) => {
            if (a.category === b.category) {
                return a.name.localeCompare(b.name);
            }
            if (a.category === 'method') { return -1; }
            if (b.category === 'method') { return 1; }
            return a.category.localeCompare(b.category);
        });

        // Only cache non-empty results to avoid "stuck" empty caches
        // Empty results might occur if indexing hasn't completed yet, and we don't want
        // to cache that state as it won't be properly invalidated later
        if (results.length > 0) {
            // Cache results and track reverse mapping for targeted invalidation
            this.memberCache.set(canonical, results.slice());
            
            // Update reverse mapping: URI → cache keys that include members from that URI
            for (const uri of contributingUris) {
                let cacheKeys = this.memberCacheByUri.get(uri);
                if (!cacheKeys) {
                    cacheKeys = new Set();
                    this.memberCacheByUri.set(uri, cacheKeys);
                }
                cacheKeys.add(canonical);
            }
        }

        return this.filterMembers(results, options);
    }

    /**
     * Resolves members for a type with enhanced precision using qualified names.
     * This is the preferred method for member lookup as it uses the qualified index.
     */
    public resolveMembersForType(
        typeName: string,
        options?: MemberResolutionOptions
    ): MemberResolutionResult {
        if (!typeName) {
            return { members: [], containerType: typeName, isExactMatch: false };
        }

        // Handle template instantiations by extracting base type
        const baseType = extractTemplateBaseType(typeName);
        const normalized = this.normalizeTypeName(baseType);
        if (!normalized) {
            return { members: [], containerType: typeName, isExactMatch: false };
        }

        const canonical = this.resolveAliasChain(normalized);

        // Try to find the container using the qualified index
        const containerMatch = findBestContainer(canonical, this.qualifiedIndex);
        
        if (!containerMatch) {
            // Fall back to legacy resolution
            const legacyMembers = this.getMembersForType(typeName, {
                includeMethods: options?.includeMethods,
                includeFields: options?.includeFields
            });
            return {
                members: filterMembersByOptions(legacyMembers, options ?? {}),
                containerType: canonical,
                isExactMatch: false
            };
        }

        // Get direct members using qualified name prefix
        const containerQualified = containerMatch.qualifiedName;
        const members: SymbolInfo[] = [];
        const prefix = containerQualified + '::';

        for (const [qualifiedName, symbol] of this.qualifiedIndex) {
            // Check if this symbol is a direct member of the container
            const symbolContainer = getContainerFromMember(qualifiedName);
            if (symbolContainer === containerQualified) {
                members.push(symbol);
            }
        }

        // Filter and sort
        const filtered = filterMembersByOptions(members, options ?? {});
        const sorted = sortMembers(filtered);

        return {
            members: sorted,
            containerType: canonical,
            containerQualified,
            isExactMatch: containerMatch.score >= 100
        };
    }

    /**
     * Gets a specific member from a type by name.
     * Returns the best match if multiple exist.
     */
    public getMemberByName(
        typeName: string,
        memberName: string,
        options?: { preferMethod?: boolean }
    ): SymbolInfo | undefined {
        const result = this.resolveMembersForType(typeName, {
            includeMethods: true,
            includeFields: true,
            includeConstants: true
        });

        const matches = result.members.filter(m => m.name === memberName);
        
        if (matches.length === 0) {
            return undefined;
        }
        
        if (matches.length === 1) {
            return matches[0];
        }

        // Prefer methods if specified
        if (options?.preferMethod) {
            const method = matches.find(m => m.category === 'method');
            if (method) {
                return method;
            }
        }

        // Return first match
        return matches[0];
    }

    /**
     * Gets the template instantiation for a type, creating it if necessary.
     * For `FIFO<uint32, 32>`, returns instantiation with T→uint32, N→32 substitutions.
     */
    public async getTemplateInstantiation(typeName: string): Promise<TemplateInstantiation | undefined> {
        const parsed = parseTemplateType(typeName);
        if (!parsed) {
            return undefined;
        }

        // Check cache first
        const cacheKey = buildInstantiationKey(parsed.baseName, parsed.arguments);
        const cached = this.templateInstantiationCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        // Get template parameters for the base type
        const parameters = await this.getTemplateParametersForType(parsed.baseName);
        if (parameters.length === 0) {
            return undefined;
        }

        // Create and cache the instantiation
        const instantiation = createInstantiation(parsed.baseName, parameters, parsed.arguments);
        this.templateInstantiationCache.set(cacheKey, instantiation);
        return instantiation;
    }

    /**
     * Gets template parameters for a type by looking up its definition.
     * Uses the AST-based template parameter extraction for accuracy.
     */
    public async getTemplateParametersForType(baseType: string): Promise<TemplateParameter[]> {
        // Check cache first
        const cached = this.templateParameterCache.get(baseType);
        if (cached) {
            return cached;
        }

        // Look up the type symbol to find its template parameters
        const symbols = this.symbolIndex.get(baseType) ?? [];
        if (symbols.length === 0) {
            return [];
        }

        // Find a class/struct symbol (templates are on classes, not methods)
        const typeSymbol = symbols.find(s => 
            s.category === 'class' || s.category === 'struct' || s.category === 'alias'
        ) ?? symbols[0];

        // Use the AST-based method to get accurate template parameters
        const templateSymbols = await this.getTemplateParametersForSymbol(typeSymbol);
        if (templateSymbols.length > 0) {
            const params: TemplateParameter[] = templateSymbols.map(sym => ({
                name: sym.name,
                kind: sym.category === 'alias' ? 'type' as const : 'value' as const,
                defaultValue: undefined, // Could extract from typeHint if needed
                constraint: sym.typeHint
            }));
            this.templateParameterCache.set(baseType, params);
            return params;
        }

        // Fallback: try to parse from the symbol's detail/signature
        const templateParamMatch = typeSymbol.detail?.match(/<[^>]+>/);
        if (templateParamMatch) {
            const params = parseTemplateParameters(templateParamMatch[0]);
            this.templateParameterCache.set(baseType, params);
            return params;
        }

        return [];
    }

    /**
     * Gets a member with instantiated signature for a templated type.
     * For `FIFO<uint32, 32>.pop()`, returns member with signature `uint32 pop()`.
     */
    public async getInstantiatedMember(
        typeName: string,
        memberName: string,
        options?: { preferMethod?: boolean }
    ): Promise<{ symbol: SymbolInfo; instantiatedSignature?: string } | undefined> {
        const member = this.getMemberByName(typeName, memberName, options);
        if (!member) {
            return undefined;
        }

        // If not a templated type, return as-is
        if (!isTemplatedType(typeName)) {
            return { symbol: member };
        }

        // Get instantiation and apply to signature
        const instantiation = await this.getTemplateInstantiation(typeName);
        if (!instantiation || !member.signature) {
            return { symbol: member };
        }

        const instantiatedSignature = instantiateMethodSignature(member.signature, instantiation);
        return {
            symbol: member,
            instantiatedSignature
        };
    }

    /**
     * Resolves members for a templated type with instantiated signatures.
     * Extends resolveMembersForType with template substitution.
     */
    public async resolveInstantiatedMembers(
        typeName: string,
        options?: MemberResolutionOptions
    ): Promise<MemberResolutionResult & { instantiation?: TemplateInstantiation }> {
        const baseResult = this.resolveMembersForType(typeName, options);
        
        // If not templated, return base result
        if (!isTemplatedType(typeName)) {
            return baseResult;
        }

        const instantiation = await this.getTemplateInstantiation(typeName);
        if (!instantiation) {
            return baseResult;
        }

        // Create copies of members with instantiated signatures and typeHints
        const instantiatedMembers = baseResult.members.map(member => {
            if (!member.signature && !member.typeHint) {
                return member;
            }
            
            const instantiatedSignature = member.signature
                ? instantiateMethodSignature(member.signature, instantiation)
                : undefined;
            const instantiatedTypeHint = member.typeHint
                ? substituteParameters(member.typeHint, instantiation.substitutions)
                : undefined;

            // Only return a new object if something changed
            if (instantiatedSignature === member.signature && instantiatedTypeHint === member.typeHint) {
                return member;
            }

            return {
                ...member,
                signature: instantiatedSignature ?? member.signature,
                typeHint: instantiatedTypeHint ?? member.typeHint
            };
        });

        return {
            ...baseResult,
            members: instantiatedMembers,
            instantiation
        };
    }

    /**
     * Clears template-related caches. Called when the index is rebuilt.
     */
    private clearTemplateCaches(): void {
        this.templateInstantiationCache.clear();
        this.templateParameterCache.clear();
    }

    public async getTemplateParametersForSymbol(symbol: SymbolInfo): Promise<SymbolInfo[]> {
        try {
            const document = await vscode.workspace.openTextDocument(symbol.uri);
            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) { return []; }
            const node = tree.rootNode.descendantForPosition({
                row: symbol.range.start.line,
                column: symbol.range.start.character
            });

            let templateNode = this.findTemplateAncestor(node);
            while (templateNode) {
                if (this.isTemplateWrapperApplicable(symbol.category, templateNode.type)) {
                    return this.getTemplateParameterSymbols(document, templateNode);
                }
                templateNode = this.findTemplateAncestor(templateNode.parent);
            }

            return [];
        } catch {
            return [];
        }
    }

    private isTemplateWrapperApplicable(category: SymbolCategory, wrapperType: string): boolean {
        switch (category) {
            case 'class':
            case 'struct':
            case 'union':
            case 'alias':
                return wrapperType === 'class_template' || wrapperType === 'struct_template' || wrapperType === 'union_template' || wrapperType === 'alias_template';
            case 'function':
            case 'method':
                return wrapperType === 'function_template';
            default:
                return false;
        }
    }

    public collectVisibleLocals(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree
    ): SymbolInfo[] {
        const offset = document.offsetAt(position);
        const seen = new Set<string>();
        const locals: SymbolInfo[] = [];
        const processedTemplates = new Set<number>();

        const lookupPosition = {
            row: position.line,
            column: Math.max(0, position.character - 1)
        };

        let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(lookupPosition);
        while (node) {
            if (node.type === 'block' || node.type === 'compound_statement') {
                this.collectDeclarationsInScope(document, node, offset, locals, seen);
            } else if (node.type === 'function_definition') {
                const templateNode = this.findTemplateAncestor(node);
                if (templateNode && !processedTemplates.has(templateNode.id)) {
                    for (const param of this.getTemplateParameterSymbols(document, templateNode)) {
                        if (seen.has(param.name)) { continue; }
                        locals.push(param);
                        seen.add(param.name);
                    }
                    processedTemplates.add(templateNode.id);
                }
                this.collectParametersFromFunction(document, node, locals, seen);
            }

            const ancestorTemplate = this.findTemplateAncestor(node.parent);
            if (ancestorTemplate && !processedTemplates.has(ancestorTemplate.id)) {
                for (const param of this.getTemplateParameterSymbols(document, ancestorTemplate)) {
                    if (seen.has(param.name)) { continue; }
                    locals.push(param);
                    seen.add(param.name);
                }
                processedTemplates.add(ancestorTemplate.id);
            }
            node = node.parent;
        }

        return locals;
    }

    private collectDeclarationsInScope(
        document: vscode.TextDocument,
        scopeNode: Parser.SyntaxNode,
        limit: number,
        locals: SymbolInfo[],
        seen: Set<string>
    ) {
        for (let i = scopeNode.namedChildren.length - 1; i >= 0; i--) {
            const child = scopeNode.namedChildren[i];
            if (child.startIndex >= limit) { continue; }

            if (child.type === 'variable_decl') {
                const nameNode = child.childForFieldName('name');
                if (!nameNode) { continue; }
                const name = nameNode.text;
                if (seen.has(name)) { continue; }
                locals.push(this.buildLocalSymbolInfo(document, child, name));
                seen.add(name);
            } else if (
                (child.type === 'block' || child.type === 'compound_statement') &&
                child.startIndex < limit &&
                child.endIndex >= limit
            ) {
                this.collectDeclarationsInScope(document, child, limit, locals, seen);
            }
        }
    }

    private collectParametersFromFunction(
        document: vscode.TextDocument,
        functionNode: Parser.SyntaxNode,
        locals: SymbolInfo[],
        seen: Set<string>
    ) {
        const params = functionNode.childForFieldName('parameters');
        if (!params) { return; }

        for (let i = params.namedChildren.length - 1; i >= 0; i--) {
            const child = params.namedChildren[i];
            if (child.type !== 'parameter') { continue; }
            const nameNode = child.childForFieldName('name');
            if (!nameNode) { continue; }
            const name = nameNode.text;
            if (seen.has(name)) { continue; }
            locals.push(this.buildLocalSymbolInfo(document, child, name));
            seen.add(name);
        }
    }

    private filterMembers(source: SymbolInfo[], options?: { includeMethods?: boolean; includeFields?: boolean }): SymbolInfo[] {
        const includeMethods = options?.includeMethods ?? true;
        const includeFields = options?.includeFields ?? true;

        return source.filter(sym =>
            (includeMethods && sym.category === 'method') ||
            (includeFields && sym.category === 'member')
        );
    }

    private getMemberInfo(typeName: string, memberName: string): SymbolInfo | undefined {
        const normalized = this.normalizeTypeName(typeName);
        if (!normalized) { return undefined; }

        const members = this.getMembersForType(normalized, { includeMethods: true, includeFields: true });
        return members.find(sym => sym.name === memberName);
    }

    private scoreCandidates(list: SymbolInfo[], scopePath: string[], options?: ResolveOptions) {
        return list.map(info => ({ info, score: this.scoreCandidate(info, scopePath, options) }));
    }

    private sortCandidatesWithScore(list: SymbolInfo[], scopePath: string[], options?: ResolveOptions): SymbolInfo[] {
        return this.scoreCandidates(list, scopePath, options)
            .sort((a, b) => b.score - a.score)
            .map(entry => entry.info);
    }

    private scoreCandidate(info: SymbolInfo, scopePath: string[], options?: ResolveOptions): number {
        let score = this.computeScopeSimilarity(scopePath, info.scopePath);

        if (options?.uri && info.uri.toString() === options.uri.toString()) {
            score += 15;
        }

        const docContext = options?.uri ? this.documentContexts.get(options.uri.toString()) : undefined;
        if (docContext) {
            if (docContext.modulePath && info.scopePath[0] === docContext.modulePath) {
                score += 25;
            }

            if (info.scopePath.length > 0) {
                const moduleName = info.scopePath[0];
                const moduleTail = this.lastSegment(moduleName);
                for (const entry of docContext.imports) {
                    if (
                        entry.path === moduleName ||
                        moduleName.endsWith(entry.path) ||
                        entry.path.endsWith(moduleName) ||
                        (entry.alias && entry.alias === moduleName) ||
                        (entry.alias && entry.alias === moduleTail)
                    ) {
                        score += 15;
                        break;
                    }
                }
            }
        }

        const hint = options?.context ?? { kind: 'unknown' } as SymbolContextHint;
        if (hint.kind === 'method') {
            if (info.category === 'method') {
                score += 20;
            } else if (info.category === 'function') {
                score -= 10;
            }

            if (hint.receiverType) {
                const normalizedReceiver = this.normalizeTypeName(hint.receiverType);
                const containerName = info.scopePath[info.scopePath.length - 1];
                if (containerName && this.normalizeTypeName(containerName) === normalizedReceiver) {
                    score += 35;
                } else if (info.typeHint && this.normalizeTypeName(info.typeHint) === normalizedReceiver) {
                    score += 20;
                }
            }
        } else if (hint.kind === 'free') {
            if (info.category === 'method') {
                score -= 10;
            }
        }

        return score;
    }

    private lastSegment(value: string): string {
        return lastSegmentUtil(value);
    }

    private normalizeTypeName(raw: string): string {
        return normalizeTypeNameUtil(raw);
    }

    private sanitizeTypeText(text?: string): string | undefined {
        return sanitizeTypeTextUtil(text);
    }

    private extractAliasTarget(node: Parser.SyntaxNode): string | undefined {
        const target = this.findTypeNode(node);
        return target ? target.text.trim() : undefined;
    }

    /**
     * Resolves a type alias chain to its canonical type.
     * Handles circular references via visited set and enforces depth limit.
     * 
     * @param typeName The type name to resolve
     * @returns The canonical type name after following all alias declarations
     */
    private resolveAliasChain(typeName: string): string {
        let current = typeName;
        const visited = new Set<string>();
        let depth = 0;

        while (this.aliasMap.has(current) && !visited.has(current)) {
            // Prevent infinite loops and excessive recursion
            if (++depth > MAX_ALIAS_CHAIN_DEPTH) {
                console.warn(`Kanagawa: Alias chain depth exceeded for '${typeName}', stopping at '${current}'`);
                break;
            }

            visited.add(current);
            const entry = this.aliasMap.get(current);
            if (!entry) { break; }
            current = entry.target;
        }
        return current;
    }

    private getCallTarget(callExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        if (callExpression.type !== 'call_expression') { return undefined; }
        return callExpression.namedChild(0) ?? undefined;
    }

    private getMemberIdentifier(memberExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        if (memberExpression.type !== 'member_expression') { return undefined; }
        const count = memberExpression.namedChildCount;
        if (count === 0) { return undefined; }
        return memberExpression.namedChild(count - 1) ?? undefined;
    }

    private extractIdentifierFromExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        switch (node.type) {
            case 'identifier':
                return node;
            case 'scoped_identifier':
            case 'qualified_identifier':
                return node.namedChild(node.namedChildCount - 1) ?? undefined;
            case 'member_expression':
                return this.getMemberIdentifier(node);
            case 'template_instantiation': {
                const subject = node.namedChild(0);
                return subject ? this.extractIdentifierFromExpression(subject) : undefined;
            }
            default:
                return undefined;
        }
    }

    private findTemplateAncestor(node: Parser.SyntaxNode | null): Parser.SyntaxNode | undefined {
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (this.templateWrappers.has(current.type)) {
                return current;
            }
            current = current.parent;
        }
        return undefined;
    }

    /**
     * Collects the template context from all enclosing template definitions.
     * This allows resolving template parameters like T when inside a template class.
     * 
     * @example
     * For code inside `template<typename T> class Foo { FIFO<T> fifo; }`:
     * Returns context with T mapped to itself (still a parameter).
     * 
     * For code inside an instantiation context, the parameters are resolved.
     */
    public getEnclosingTemplateContext(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
    ): TemplateContext {
        const context = createEmptyContext();
        const processedTemplates = new Set<number>();
        
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            const templateNode = this.findTemplateAncestor(current);
            if (templateNode && !processedTemplates.has(templateNode.id)) {
                processedTemplates.add(templateNode.id);
                
                // Get template parameters from this template
                const params = this.getTemplateParameterSymbols(document, templateNode);
                for (const param of params) {
                    // Map parameter to itself - it's in scope but not yet instantiated
                    // This will be substituted later if we have an actual instantiation
                    if (!context.parameters.has(param.name)) {
                        context.parameters.set(param.name, param.name);
                    }
                }
                
                current = templateNode.parent;
            } else {
                current = current?.parent ?? null;
            }
        }
        
        return context;
    }

    private getTemplateParameterSymbols(document: vscode.TextDocument, templateNode: Parser.SyntaxNode): SymbolInfo[] {
        const paramsNode = templateNode.namedChildren.find(child => child.type === 'template_params');
        if (!paramsNode) { return []; }

        const symbols: SymbolInfo[] = [];
        for (const child of paramsNode.namedChildren) {
            if (child.type !== 'template_param') { continue; }
            const symbol = this.createTemplateParameterSymbol(document, templateNode, child);
            if (symbol) {
                symbols.push(symbol);
            }
        }
        return symbols;
    }

    private createTemplateParameterSymbol(
        document: vscode.TextDocument,
        templateNode: Parser.SyntaxNode,
        paramNode: Parser.SyntaxNode
    ): SymbolInfo | undefined {
        const nameNode = paramNode.namedChildren.find(child => child.type === 'identifier');
        if (!nameNode) { return undefined; }

        const firstChild = paramNode.child(0);
        let category: SymbolCategory = 'constant';
        let detail = 'template parameter';
        let typeHint: string | undefined;

        if (firstChild?.type === 'typename') {
            category = 'alias';
            detail = 'template type parameter';
            typeHint = 'typename';
        } else if (firstChild?.type === 'template') {
            category = 'alias';
            detail = 'template parameter';
            typeHint = 'template';
        } else {
            if (firstChild?.type === 'auto') {
                typeHint = 'auto';
            }

            for (const child of paramNode.namedChildren) {
                if (child.id === nameNode.id) { break; }
                if (child.type !== 'identifier') {
                    typeHint = child.text.trim();
                    break;
                }
            }
        }

        const range = new vscode.Range(
            new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
            new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
        );
        const signatureParts: string[] = [];
        if (typeHint) {
            signatureParts.push(typeHint.replace(/\s+/g, ' '));
        }
        signatureParts.push(nameNode.text);

        const docComment = this.collectTemplateParameterDoc(document, paramNode);
        const scopePath = this.buildScopePath(templateNode);
        const qualifiedName = computeQualifiedName(nameNode.text, scopePath);

        return {
            name: nameNode.text,
            qualifiedName,
            uri: document.uri,
            range,
            kind: category === 'alias' ? vscode.SymbolKind.TypeParameter : vscode.SymbolKind.Constant,
            detail,
            docMarkdown: docComment,
            signature: signatureParts.join(' '),
            scopePath,
            category,
            typeHint
        };
    }

    private stripInlineDocComments(text: string): string {
        const lines = text.split(/\r?\n/);
        const cleaned = lines.map(line => line.replace(/\/\/([|<]).*$/g, '').replace(/\s+$/u, ''));
        return cleaned.join('\n');
    }

    private collectTemplateParameterDoc(document: vscode.TextDocument, paramNode: Parser.SyntaxNode): string | undefined {
        const lineIndex = paramNode.endPosition.row;
        if (lineIndex >= document.lineCount) { return undefined; }

        const currentLine = document.lineAt(lineIndex).text;
        const parts: string[] = [];
        const inlineIndex = currentLine.indexOf('//<');
        if (inlineIndex !== -1) {
            const content = currentLine.slice(inlineIndex + 3).trim();
            if (content.length) { parts.push(content); }
        } else {
            return undefined;
        }

        let nextLine = lineIndex + 1;
        while (nextLine < document.lineCount) {
            const text = document.lineAt(nextLine).text;
            const trimmed = text.trim();
            if (!trimmed.startsWith('//')) { break; }
            const normalized = trimmed.replace(/^\/\/?<?\s?/, '').trim();
            if (normalized.length) {
                parts.push(normalized);
            }
            nextLine++;
        }

        if (!parts.length) { return undefined; }
        return parts.join('\n');
    }

    private collectLineCommentBlock(
        document: vscode.TextDocument,
        anchor: Parser.SyntaxNode
    ): string[] {
        const result: string[] = [];
        let line = anchor.startPosition.row - 1;

        while (line >= 0) {
            const text = document.lineAt(line).text;
            const trimmed = text.trim();
            if (!trimmed.startsWith('//') || trimmed.startsWith('//|') || trimmed.startsWith('//<')) {
                break;
            }
            const content = trimmed.replace(/^\/\/\s?/, '').trim();
            if (content.length) {
                result.unshift(content);
            }
            line--;
        }

        // Include doc comments captured via preDocs in case they weren't gathered
        return result;
    }

    private collectLeadingDocLines(
        document: vscode.TextDocument,
        anchor: Parser.SyntaxNode,
        preDocs: Map<number, string>
    ): string[] {
        const result: string[] = [];
        let line = anchor.startPosition.row - 1;

        while (line >= 0) {
            if (preDocs.has(line)) {
                result.unshift(preDocs.get(line)!);
                line--;
                continue;
            }

            const text = document.lineAt(line).text;
            const trimmed = text.trim();
            if (!trimmed.startsWith('//')) { break; }

            if (trimmed.startsWith('//<')) { break; }

            const content = trimmed.startsWith('//|')
                ? this.cleanDocComment(trimmed)
                : trimmed.replace(/^\/\/\s?/, '').trim();

            if (content.length) {
                result.unshift(content);
            }

            line--;
        }

        return result.length ? result : this.collectLineCommentBlock(document, anchor);
    }

    private findTemplateParameterSymbol(
        document: vscode.TextDocument,
        start: Parser.SyntaxNode | null,
        targetName: string
    ): SymbolInfo | undefined {
        const templateNode = this.findTemplateAncestor(start);
        if (!templateNode) { return undefined; }
        const symbols = this.getTemplateParameterSymbols(document, templateNode);
        return symbols.find(symbol => symbol.name === targetName);
    }

    private clearDocumentCaches(uri: vscode.Uri) {
        const key = uri.toString();
        this.typeInferenceCache.delete(key);
        this.invalidateResolvedImports(uri);
    }

    private findDeclarationInScope(scopeNode: Parser.SyntaxNode, targetName: string, limit: number): Parser.SyntaxNode | undefined {
        if (!scopeNode.namedChildren.length) { return undefined; }

        let candidate: Parser.SyntaxNode | undefined;
        for (const child of scopeNode.namedChildren) {
            if (child.startIndex > limit) {
                break;
            }

            const isBlock = child.type === 'block' || child.type === 'compound_statement';
            const shouldDescend = !isBlock || (child.startIndex <= limit && child.endIndex >= limit);

            if (shouldDescend) {
                const match = this.matchDeclarationNode(child, targetName, limit);
                if (match && (!candidate || match.startIndex > candidate.startIndex)) {
                    candidate = match;
                }

                const nested = this.findDeclarationInScope(child, targetName, limit);
                if (nested && (!candidate || nested.startIndex > candidate.startIndex)) {
                    candidate = nested;
                }
            }
        }

        return candidate;
    }

    private findParameterDeclaration(functionNode: Parser.SyntaxNode, targetName: string): Parser.SyntaxNode | undefined {
        const params = functionNode.childForFieldName('parameters');
        if (!params) { return undefined; }

        for (const child of params.namedChildren) {
            if (child.type !== 'parameter') { continue; }
            const nameNode = child.childForFieldName('name');
            if (nameNode && nameNode.text === targetName) {
                return child;
            }
        }

        return undefined;
    }

    private matchDeclarationNode(node: Parser.SyntaxNode, targetName: string, limit: number): Parser.SyntaxNode | undefined {
        if (node.type === 'variable_decl') {
            const nameNode = node.childForFieldName('name');
            if (nameNode && nameNode.text === targetName && node.startIndex < limit) {
                return node;
            }
        }
        return undefined;
    }

    private buildLocalSymbolInfo(document: vscode.TextDocument, declNode: Parser.SyntaxNode, name: string): SymbolInfo {
        const nameNode = declNode.childForFieldName('name');
        const range = nameNode
            ? new vscode.Range(
                new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column),
                new vscode.Position(nameNode.endPosition.row, nameNode.endPosition.column)
            )
            : new vscode.Range(
                new vscode.Position(declNode.startPosition.row, declNode.startPosition.column),
                new vscode.Position(declNode.startPosition.row, declNode.startPosition.column)
            );

        const typeNode = this.findTypeNode(declNode);
        const typeText = typeNode ? typeNode.text.trim() : undefined;
        const signatureParts: string[] = [];
        if (typeText) {
            signatureParts.push(typeText.replace(/\s+/g, ' '));
        }
        signatureParts.push(name);

        const scopePath = this.buildScopePath(declNode);
        const qualifiedName = computeQualifiedName(name, scopePath);

        return {
            name,
            qualifiedName,
            uri: document.uri,
            range,
            kind: vscode.SymbolKind.Variable,
            detail: 'variable',
            docMarkdown: undefined,
            signature: signatureParts.join(' '),
            scopePath,
            category: 'variable',
            typeHint: typeText
        };
    }
}
