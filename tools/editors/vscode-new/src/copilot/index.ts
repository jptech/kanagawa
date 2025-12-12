/**
 * Copilot Tools Registration
 * 
 * Entry point for registering all Kanagawa Language Model Tools with VS Code.
 */

import * as vscode from 'vscode';
import { WorkspaceIndexer } from '../service/indexer';
import { TreeSitterService } from '../service/treeSitter';
import {
    LookupSymbolTool,
    GetTypeMembersTool,
    InferTypeTool,
    GetModuleExportsTool,
    GetImportsTool,
    SearchSymbolsTool,
    GetSymbolDetailsTool,
    ResolveSymbolAtPositionTool,
    GetDefinitionLocationsTool,
    FindReferencesAtPositionTool,
    ListModulesTool,
    GetModuleApiTool,
    GetDocumentSymbolsTool
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
    SEARCH_SYMBOLS: 'kanagawa_search_symbols',
    GET_SYMBOL_DETAILS: 'kanagawa_get_symbol_details',

    RESOLVE_AT_POSITION: 'kanagawa_resolve_symbol_at_position',
    GET_DEFINITIONS: 'kanagawa_get_definition_locations',
    FIND_REFERENCES: 'kanagawa_find_references',
    LIST_MODULES: 'kanagawa_list_modules',
    GET_MODULE_API: 'kanagawa_get_module_api',
    GET_DOCUMENT_SYMBOLS: 'kanagawa_get_document_symbols'
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
    indexer: WorkspaceIndexer,
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

        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_SYMBOL_DETAILS,
                new GetSymbolDetailsTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_SYMBOL_DETAILS}`);

        // New v2 navigation + discovery tools
        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.RESOLVE_AT_POSITION,
                new ResolveSymbolAtPositionTool(indexer, treeSitterService)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.RESOLVE_AT_POSITION}`);

        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_DEFINITIONS,
                new GetDefinitionLocationsTool(indexer, treeSitterService)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_DEFINITIONS}`);

        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.FIND_REFERENCES,
                new FindReferencesAtPositionTool(treeSitterService, indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.FIND_REFERENCES}`);

        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.LIST_MODULES,
                new ListModulesTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.LIST_MODULES}`);

        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_MODULE_API,
                new GetModuleApiTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_MODULE_API}`);

        disposables.push(
            vscode.lm.registerTool(
                TOOL_NAMES.GET_DOCUMENT_SYMBOLS,
                new GetDocumentSymbolsTool(indexer)
            )
        );
        console.log(`Kanagawa: Registered tool ${TOOL_NAMES.GET_DOCUMENT_SYMBOLS}`);

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
