/**
 * Copilot Tool Implementations
 * 
 * Language Model Tools that expose the Kanagawa indexer to GitHub Copilot agents.
 * Each tool implements vscode.LanguageModelTool<T> and wraps pure logic functions.
 * 
 * The actual business logic is in toolLogic.ts to enable unit testing without vscode.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { IWorkspaceIndexer } from '../service/IWorkspaceIndexer';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer } from '../service/indexer';
import { SymbolResolutionService } from '../service/resolution';
import { findIdentifierNode } from '../utils/nodeUtils';
import { KanagawaReferencesProvider } from '../providers/references';
import { formatWorkspacePathForTool, WorkspaceFolderLike } from '../utils/workspacePathFormat';
import {
    LookupSymbolInput,
    GetTypeMembersInput,
    InferTypeInput,
    InferTypeOutput,
    GetModuleExportsInput,
    GetImportsInput,
    SearchSymbolsInput,
    GetSymbolDetailsInput,
    ResolveSymbolAtPositionInput,
    GetDefinitionLocationsInput,
    FindReferencesAtPositionInput,
    ListModulesInput,
    GetModuleApiInput,
    GetDocumentSymbolsInput,
    createErrorResponse
} from './types';
import {
    lookupSymbolLogic,
    getTypeMembersLogic,
    getModuleExportsLogic,
    getImportsLogic,
    searchSymbolsLogic,
    getSymbolDetailsLogic,
    listModulesLogic,
    getModuleApiLogic,
    getDocumentSymbolsLogic,
    symbolToToolInfo
} from './toolLogic';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a LanguageModelToolResult from a response object.
 * Accepts any JSON-serializable object.
 */
function toToolResult(response: unknown): vscode.LanguageModelToolResult {
    // Tools are consumed by LLM agents; minimize tokens by default.
    const json = JSON.stringify(response);
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(json)
    ]);
}

function toWorkspaceFoldersLike(): readonly WorkspaceFolderLike[] | undefined {
    return vscode.workspace.workspaceFolders?.map(f => ({ uri: { fsPath: f.uri.fsPath }, name: f.name }));
}

function uriFromToolFilePath(filePath: string): vscode.Uri | undefined {
    if (!filePath || typeof filePath !== 'string') return undefined;

    const isAbsolute = path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath);
    if (isAbsolute) {
        return vscode.Uri.file(filePath);
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        // Best-effort fallback: treat as a file path relative to process CWD.
        return vscode.Uri.file(filePath);
    }

    const parts = filePath.split(/[\\/]+/).filter(Boolean);
    return vscode.Uri.joinPath(root.uri, ...parts);
}

function uriFactoryFromToolPath(filePath: string): vscode.Uri {
    return uriFromToolFilePath(filePath) ?? vscode.Uri.file(filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isToolLocationLike(value: unknown): value is { uri: string; path: string } & Record<string, unknown> {
    return (
        isRecord(value) &&
        typeof value.uri === 'string' &&
        typeof value.path === 'string'
    );
}

function rewriteToolLocation(location: unknown): void {
    if (!isToolLocationLike(location)) return;

    try {
        const uri = vscode.Uri.parse(location.uri);
        if (uri.scheme === 'file') {
            location.path = formatWorkspacePathForTool(uri.fsPath, toWorkspaceFoldersLike());
        } else {
            // Keep path as-is for non-file URIs
            location.path = location.path.replace(/\\/g, '/');
        }
    } catch {
        location.path = location.path.replace(/\\/g, '/');
    }
}

function rewriteLocationsDeep(value: unknown): void {
    if (!value) return;
    if (Array.isArray(value)) {
        for (const item of value) rewriteLocationsDeep(item);
        return;
    }
    if (!isRecord(value)) return;

    // Common pattern in our outputs
    if ('location' in value) {
        const loc = value.location;
        // `location` can be a ToolLocation or nested object (infer-type)
        if (isToolLocationLike(loc)) {
            rewriteToolLocation(loc);
        } else {
            rewriteLocationsDeep(loc);
        }
    }
    if ('file' in value) {
        rewriteLocationsDeep(value.file);
    }
    if ('declaringFile' in value) {
        rewriteLocationsDeep(value.declaringFile);
    }
    if ('definitions' in value) {
        rewriteLocationsDeep(value.definitions);
    }
    if ('references' in value) {
        rewriteLocationsDeep(value.references);
    }
    if ('results' in value) {
        rewriteLocationsDeep(value.results);
    }
    if ('primary' in value) {
        rewriteLocationsDeep(value.primary);
    }
    if ('alternatives' in value) {
        rewriteLocationsDeep(value.alternatives);
    }
    if ('inaccessible' in value) {
        rewriteLocationsDeep(value.inaccessible);
    }
    if ('exports' in value) {
        rewriteLocationsDeep(value.exports);
    }
    if ('outline' in value) {
        rewriteLocationsDeep(value.outline);
    }

    for (const key of Object.keys(value)) {
        rewriteLocationsDeep(value[key]);
    }
}

function toToolResultWithRewrittenLocations(response: unknown): vscode.LanguageModelToolResult {
    rewriteLocationsDeep(response);
    return toToolResult(response);
}

// ============================================================================
// LookupSymbolTool
// ============================================================================

/**
 * Tool: kanagawa_lookup_symbol
 * 
 * Looks up symbol definitions by name in the workspace index.
 * Supports optional scope path for disambiguation.
 */
export class LookupSymbolTool implements vscode.LanguageModelTool<LookupSymbolInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<LookupSymbolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { symbolName, scopePath } = options.input;
        const scopeStr = scopePath?.length ? ` in scope ${scopePath.join('::')}` : '';
        return {
            invocationMessage: `Looking up symbol "${symbolName}"${scopeStr}...`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<LookupSymbolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = lookupSymbolLogic(this.indexer, options.input);
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: LookupSymbolTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// GetTypeMembersTool
// ============================================================================

/**
 * Tool: kanagawa_get_type_members
 * 
 * Gets all members (methods, fields) of a type with template instantiation support.
 */
export class GetTypeMembersTool implements vscode.LanguageModelTool<GetTypeMembersInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetTypeMembersInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Getting members of type "${options.input.typeName}"...`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTypeMembersInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await getTypeMembersLogic(this.indexer, options.input);
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetTypeMembersTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// InferTypeTool
// ============================================================================

/**
 * Tool: kanagawa_infer_type
 * 
 * Infers the type of an expression at a specific location in a file.
 */
export class InferTypeTool implements vscode.LanguageModelTool<InferTypeInput> {
    constructor(
        private readonly indexer: IWorkspaceIndexer,
        private readonly treeSitterService: TreeSitterService
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<InferTypeInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, line, character } = options.input;
        return {
            invocationMessage: `Inferring type at ${filePath}:${line}:${character}...`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<InferTypeInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, line, character } = options.input;

        if (!filePath || typeof filePath !== 'string') {
            return toToolResult(createErrorResponse(
                'filePath is required and must be a string',
                'INVALID_INPUT'
            ));
        }

        if (typeof line !== 'number' || typeof character !== 'number') {
            return toToolResult(createErrorResponse(
                'line and character are required and must be numbers',
                'INVALID_INPUT'
            ));
        }

        try {
            // Convert to 0-indexed for VS Code API
            const zeroLine = line - 1;
            const zeroChar = character - 1;

            if (zeroLine < 0 || zeroChar < 0) {
                return toToolResult(createErrorResponse(
                    'line and character must be positive (1-indexed)',
                    'INVALID_POSITION'
                ));
            }

            // Open the document
            const uri = uriFromToolFilePath(filePath);
            if (!uri) {
                return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
            }
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch {
                return toToolResult(createErrorResponse(
                    `File not found: ${filePath}`,
                    'FILE_NOT_FOUND'
                ));
            }

            if (token.isCancellationRequested) {
                return toToolResult(createErrorResponse('Cancelled', 'CANCELLED'));
            }

            // Validate position
            if (zeroLine >= document.lineCount) {
                return toToolResult(createErrorResponse(
                    `Line ${line} is outside document (${document.lineCount} lines)`,
                    'INVALID_POSITION'
                ));
            }

            const lineText = document.lineAt(zeroLine);
            if (zeroChar > lineText.text.length) {
                return toToolResult(createErrorResponse(
                    `Character ${character} is outside line ${line} (${lineText.text.length} chars)`,
                    'INVALID_POSITION'
                ));
            }

            // Get or parse the tree
            const tree = this.treeSitterService.getTree(document) ?? 
                         await this.treeSitterService.parse(document);
            
            if (!tree) {
                return toToolResult(createErrorResponse(
                    `Failed to parse document: ${filePath}`,
                    'PARSE_ERROR'
                ));
            }

            // Find the node at the position
            const position = { row: zeroLine, column: zeroChar };
            const node = tree.rootNode.descendantForPosition(position);

            if (!node) {
                return toToolResult(createErrorResponse(
                    `No syntax node at position ${line}:${character}`,
                    'INVALID_POSITION'
                ));
            }

            // Infer the type
            const inferredType = await this.indexer.inferTypeFromExpression(document, node);

            if (!inferredType) {
                return toToolResult(createErrorResponse(
                    `Could not infer type at ${filePath}:${line}:${character}`,
                    'SYMBOL_NOT_FOUND'
                ));
            }

            const output: InferTypeOutput = {
                type: inferredType,
                location: {
                    file: {
                        uri: uri.toString(),
                        path: formatWorkspacePathForTool(uri.fsPath, toWorkspaceFoldersLike())
                    },
                    position: { line, character }
                }
            };

            return toToolResult(output);
        } catch (error) {
            console.error('Kanagawa: InferTypeTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// GetModuleExportsTool
// ============================================================================

/**
 * Tool: kanagawa_get_module_exports
 * 
 * Lists all symbols exported by a module/file.
 */
export class GetModuleExportsTool implements vscode.LanguageModelTool<GetModuleExportsInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetModuleExportsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Getting exports from "${options.input.filePath}"...`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetModuleExportsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = getModuleExportsLogic(
                this.indexer,
                options.input,
                (p) => uriFactoryFromToolPath(p)
            );
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetModuleExportsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// GetImportsTool
// ============================================================================

/**
 * Tool: kanagawa_get_imports
 * 
 * Gets resolved imports for a file to understand dependencies.
 */
export class GetImportsTool implements vscode.LanguageModelTool<GetImportsInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetImportsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Getting imports for "${options.input.filePath}"...`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetImportsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = getImportsLogic(
                this.indexer,
                options.input,
                (p) => uriFactoryFromToolPath(p)
            );
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetImportsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// SearchSymbolsTool
// ============================================================================

/**
 * Tool: kanagawa_search_symbols
 * 
 * Searches for symbols by prefix/substring match.
 * Useful for exploring the codebase when you don't know exact names.
 */
export class SearchSymbolsTool implements vscode.LanguageModelTool<SearchSymbolsInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SearchSymbolsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { query, category, filePath } = options.input;
        let msg = `Searching for symbols matching "${query}"`;
        if (category) msg += ` (category: ${category})`;
        if (filePath) msg += ` in ${filePath}`;
        return { invocationMessage: msg + '...' };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchSymbolsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = searchSymbolsLogic(
                this.indexer,
                options.input,
                (p) => uriFactoryFromToolPath(p)
            );
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: SearchSymbolsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// GetSymbolDetailsTool
// ============================================================================

export class GetSymbolDetailsTool implements vscode.LanguageModelTool<GetSymbolDetailsInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetSymbolDetailsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Getting details for "${options.input.qualifiedName}"...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetSymbolDetailsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = getSymbolDetailsLogic(this.indexer, options.input);
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetSymbolDetailsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// New: ResolveSymbolAtPositionTool
// ============================================================================

export class ResolveSymbolAtPositionTool implements vscode.LanguageModelTool<ResolveSymbolAtPositionInput> {
    private readonly resolver: SymbolResolutionService;

    constructor(
        private readonly indexer: WorkspaceIndexer,
        private readonly treeSitterService: TreeSitterService
    ) {
        this.resolver = new SymbolResolutionService(indexer);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ResolveSymbolAtPositionInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, line, character } = options.input;
        return { invocationMessage: `Resolving symbol at ${filePath}:${line}:${character}...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ResolveSymbolAtPositionInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, line, character, includeInaccessible = true, maxAlternatives = 10 } = options.input;

        if (!filePath || typeof filePath !== 'string') {
            return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
        }
        if (typeof line !== 'number' || typeof character !== 'number') {
            return toToolResult(createErrorResponse('line and character are required and must be numbers', 'INVALID_INPUT'));
        }

        try {
            const resolvedUri = uriFromToolFilePath(filePath);
            if (!resolvedUri) {
                return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
            }
            const document = await vscode.workspace.openTextDocument(resolvedUri);
            if (token.isCancellationRequested) {
                return toToolResult(createErrorResponse('Cancelled', 'CANCELLED'));
            }

            const position = new vscode.Position(line - 1, character - 1);
            const tree = this.treeSitterService.getTree(document) ?? await this.treeSitterService.parse(document);
            if (!tree) {
                return toToolResult(createErrorResponse(`Failed to parse document: ${filePath}`, 'PARSE_ERROR'));
            }

            const identifier = findIdentifierNode(tree, position);
            if (!identifier) {
                return toToolResult({
                    primary: undefined,
                    confidence: 'none',
                    alternatives: [],
                    inaccessible: []
                });
            }

            const resolution = await this.resolver.resolveAtPosition(
                { document, position, tree, identifier },
                { includeInaccessible, maxAlternatives }
            );

            const result = {
                primary: resolution.primary ? symbolToToolInfo(resolution.primary) : undefined,
                confidence: resolution.confidence,
                alternatives: resolution.alternatives.map(s => symbolToToolInfo(s)),
                inaccessible: resolution.inaccessible.map(s => symbolToToolInfo(s))
            };

            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: ResolveSymbolAtPositionTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// New: GetDefinitionLocationsTool
// ============================================================================

export class GetDefinitionLocationsTool implements vscode.LanguageModelTool<GetDefinitionLocationsInput> {
    private readonly resolver: SymbolResolutionService;

    constructor(
        private readonly indexer: WorkspaceIndexer,
        private readonly treeSitterService: TreeSitterService
    ) {
        this.resolver = new SymbolResolutionService(indexer);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetDefinitionLocationsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, line, character } = options.input;
        return { invocationMessage: `Getting definition(s) for ${filePath}:${line}:${character}...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDefinitionLocationsInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, line, character, maxLocations = 10 } = options.input;

        if (!filePath || typeof filePath !== 'string') {
            return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
        }

        try {
            const resolvedUri = uriFromToolFilePath(filePath);
            if (!resolvedUri) {
                return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
            }
            const document = await vscode.workspace.openTextDocument(resolvedUri);
            const position = new vscode.Position(line - 1, character - 1);

            const tree = this.treeSitterService.getTree(document) ?? await this.treeSitterService.parse(document);
            if (!tree) {
                return toToolResult(createErrorResponse(`Failed to parse document: ${filePath}`, 'PARSE_ERROR'));
            }

            const identifier = findIdentifierNode(tree, position);
            if (!identifier) {
                return toToolResult({ definitions: [], truncated: false });
            }

            if (token.isCancellationRequested) {
                return toToolResult(createErrorResponse('Cancelled', 'CANCELLED'));
            }

            const resolution = await this.resolver.resolveAtPosition(
                { document, position, tree, identifier },
                { includeInaccessible: false, maxAlternatives: maxLocations }
            );

            type ResolvedSymbolLike = { uri: vscode.Uri; range: vscode.Range };

            const locations: Array<{ uri: string; path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> = [];
            const seen = new Set<string>();
            const push = (sym: ResolvedSymbolLike) => {
                const key = sym.uri.toString() + '#' + sym.range.start.line + ':' + sym.range.start.character;
                if (seen.has(key)) return;
                seen.add(key);
                locations.push({
                    uri: sym.uri.toString(),
                    path: sym.uri.fsPath,
                    range: {
                        start: { line: sym.range.start.line + 1, character: sym.range.start.character + 1 },
                        end: { line: sym.range.end.line + 1, character: sym.range.end.character + 1 }
                    }
                });
            };

            if (resolution.primary) push(resolution.primary);
            for (const alt of resolution.alternatives) push(alt);

            locations.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);

            const truncated = locations.length > maxLocations;
            const result = { definitions: locations.slice(0, maxLocations), truncated };
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetDefinitionLocationsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// New: FindReferencesAtPositionTool
// ============================================================================

export class FindReferencesAtPositionTool implements vscode.LanguageModelTool<FindReferencesAtPositionInput> {
    private readonly provider: KanagawaReferencesProvider;

    constructor(
        service: TreeSitterService,
        indexer: WorkspaceIndexer
    ) {
        this.provider = new KanagawaReferencesProvider(service, indexer);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindReferencesAtPositionInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, line, character } = options.input;
        return { invocationMessage: `Finding references at ${filePath}:${line}:${character}...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindReferencesAtPositionInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, line, character, includeDeclaration = false, limit = 200 } = options.input;

        if (!filePath || typeof filePath !== 'string') {
            return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
        }
        if (typeof line !== 'number' || typeof character !== 'number') {
            return toToolResult(createErrorResponse('line and character are required and must be numbers', 'INVALID_INPUT'));
        }

        try {
            const resolvedUri = uriFromToolFilePath(filePath);
            if (!resolvedUri) {
                return toToolResult(createErrorResponse('filePath is required and must be a string', 'INVALID_INPUT'));
            }
            const document = await vscode.workspace.openTextDocument(resolvedUri);
            const position = new vscode.Position(line - 1, character - 1);

            const locations = await this.provider.provideReferences(
                document,
                position,
                { includeDeclaration },
                token
            );

            if (!locations) {
                return toToolResult({ references: [], totalCount: 0, truncated: false });
            }

            const formatted = locations.map(loc => ({
                uri: loc.uri.toString(),
                path: loc.uri.fsPath,
                range: {
                    start: { line: loc.range.start.line + 1, character: loc.range.start.character + 1 },
                    end: { line: loc.range.end.line + 1, character: loc.range.end.character + 1 }
                }
            }));

            formatted.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);

            const truncated = formatted.length > limit;
            const result = { references: formatted.slice(0, limit), totalCount: formatted.length, truncated };
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: FindReferencesAtPositionTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// New: ListModulesTool
// ============================================================================

export class ListModulesTool implements vscode.LanguageModelTool<ListModulesInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ListModulesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { prefix } = options.input;
        return { invocationMessage: prefix ? `Listing modules with prefix "${prefix}"...` : 'Listing modules...' };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListModulesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = listModulesLogic(this.indexer, options.input);
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: ListModulesTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// New: GetModuleApiTool
// ============================================================================

export class GetModuleApiTool implements vscode.LanguageModelTool<GetModuleApiInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetModuleApiInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Getting module API for "${options.input.modulePath}"...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetModuleApiInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = getModuleApiLogic(this.indexer, options.input);
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetModuleApiTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}

// ============================================================================
// GetDocumentSymbolsTool
// ============================================================================

export class GetDocumentSymbolsTool implements vscode.LanguageModelTool<GetDocumentSymbolsInput> {
    constructor(private readonly indexer: IWorkspaceIndexer) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetDocumentSymbolsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Getting document symbols for "${options.input.filePath}"...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDocumentSymbolsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = getDocumentSymbolsLogic(
                this.indexer,
                options.input,
                (p) => uriFactoryFromToolPath(p)
            );
            return toToolResultWithRewrittenLocations(result);
        } catch (error) {
            console.error('Kanagawa: GetDocumentSymbolsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}
