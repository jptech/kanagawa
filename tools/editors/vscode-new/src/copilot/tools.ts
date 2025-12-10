/**
 * Copilot Tool Implementations
 * 
 * Language Model Tools that expose the Kanagawa indexer to GitHub Copilot agents.
 * Each tool implements vscode.LanguageModelTool<T> and wraps pure logic functions.
 * 
 * The actual business logic is in toolLogic.ts to enable unit testing without vscode.
 */

import * as vscode from 'vscode';
import { IWorkspaceIndexer } from '../service/IWorkspaceIndexer';
import { TreeSitterService } from '../service/treeSitter';
import {
    LookupSymbolInput,
    GetTypeMembersInput,
    InferTypeInput,
    InferTypeOutput,
    GetModuleExportsInput,
    GetImportsInput,
    createErrorResponse
} from './types';
import {
    lookupSymbolLogic,
    getTypeMembersLogic,
    getModuleExportsLogic,
    getImportsLogic,
    searchSymbolsLogic,
    SearchSymbolsInput
} from './toolLogic';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a LanguageModelToolResult from a response object.
 * Accepts any JSON-serializable object.
 */
function toToolResult(response: unknown): vscode.LanguageModelToolResult {
    const json = JSON.stringify(response, null, 2);
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(json)
    ]);
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
            return toToolResult(result);
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
            return toToolResult(result);
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
        _token: vscode.CancellationToken
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
            const uri = vscode.Uri.file(filePath);
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch {
                return toToolResult(createErrorResponse(
                    `File not found: ${filePath}`,
                    'FILE_NOT_FOUND'
                ));
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
                location: `${filePath}:${line}:${character}`
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
                (path) => vscode.Uri.file(path)
            );
            return toToolResult(result);
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
                (path) => vscode.Uri.file(path)
            );
            return toToolResult(result);
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
                (path) => vscode.Uri.file(path)
            );
            return toToolResult(result);
        } catch (error) {
            console.error('Kanagawa: SearchSymbolsTool error:', error);
            return toToolResult(createErrorResponse(
                `Internal error: ${error instanceof Error ? error.message : String(error)}`,
                'INTERNAL_ERROR'
            ));
        }
    }
}
