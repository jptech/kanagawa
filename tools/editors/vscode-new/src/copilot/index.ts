/**
 * Copilot Tools Registration
 * 
 * Entry point for registering all Kanagawa Language Model Tools with VS Code.
 */

import * as vscode from 'vscode';
import { IWorkspaceIndexer } from '../service/IWorkspaceIndexer';
import { TreeSitterService } from '../service/treeSitter';
import {
    LookupSymbolTool,
    GetTypeMembersTool,
    InferTypeTool,
    GetModuleExportsTool,
    GetImportsTool,
    SearchSymbolsTool
} from './tools';

/**
 * Tool names as registered with VS Code.
 * These must match the names in package.json contributes.languageModelTools.
 */
export const TOOL_NAMES = {
    LOOKUP_SYMBOL: 'kanagawa_lookup_symbol',
    GET_TYPE_MEMBERS: 'kanagawa_get_type_members',
    INFER_TYPE: 'kanagawa_infer_type',
    GET_MODULE_EXPORTS: 'kanagawa_get_module_exports',
    GET_IMPORTS: 'kanagawa_get_imports',
    SEARCH_SYMBOLS: 'kanagawa_search_symbols'
} as const;

/**
 * Registers all Kanagawa Copilot tools with VS Code.
 * 
 * @param context Extension context for managing subscriptions
 * @param indexer Workspace indexer instance
 * @param treeSitterService Tree-sitter service for parsing
 * @returns Array of disposables for all registered tools
 */
export function registerCopilotTools(
    context: vscode.ExtensionContext,
    indexer: IWorkspaceIndexer,
    treeSitterService: TreeSitterService
): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // Check if Language Model API is available (VS Code 1.90+)
    if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
        console.log('Kanagawa: Language Model API not available, skipping Copilot tools registration');
        return disposables;
    }

    try {
        // Register LookupSymbolTool
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.LOOKUP_SYMBOL,
                new LookupSymbolTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.LOOKUP_SYMBOL}`);

        // Register GetTypeMembersTool
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_TYPE_MEMBERS,
                new GetTypeMembersTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_TYPE_MEMBERS}`);

        // Register InferTypeTool
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.INFER_TYPE,
                new InferTypeTool(indexer, treeSitterService)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.INFER_TYPE}`);

        // Register GetModuleExportsTool
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_MODULE_EXPORTS,
                new GetModuleExportsTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_MODULE_EXPORTS}`);

        // Register GetImportsTool
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_IMPORTS,
                new GetImportsTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_IMPORTS}`);

        // Register SearchSymbolsTool
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.SEARCH_SYMBOLS,
                new SearchSymbolsTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.SEARCH_SYMBOLS}`);

        console.log(`Kanagawa: Successfully registered ${disposables.length} Copilot tools`);
    } catch (error) {
        console.error('Kanagawa: Failed to register Copilot tools:', error);
    }

    // Add all disposables to extension context
    context.subscriptions.push(...disposables);

    return disposables;
}

// Re-export types for convenience
export * from './types';
export * from './tools';
export * from './toolLogic';
