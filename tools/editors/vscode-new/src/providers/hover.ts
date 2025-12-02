import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { SymbolResolutionService, ResolutionResult } from '../service/resolution';
import { extractModuleFromQualified } from '../utils/importUtils';
import { getNodeText, resolveToIdentifier } from '../utils/nodeUtils';
import { perfLogger, PerfOps } from '../utils/perfLogger';
import { OPERATION_TIMEOUTS, withTimeout } from '../utils/timeout';

/**
 * Result of resolving hover candidates with confidence scoring.
 * Uses ResolutionResult from the SymbolResolutionService.
 */
type HoverResolution = ResolutionResult;

export class KanagawaHoverProvider implements vscode.HoverProvider {
    private readonly resolutionService: SymbolResolutionService;

    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {
        this.resolutionService = new SymbolResolutionService(indexer);
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        try {
            return await perfLogger.measure(PerfOps.HOVER, document.uri.toString(), async () => {
                // Check for cancellation early
                if (token.isCancellationRequested) { return undefined; }
                
                const tree = this.service.getTree(document) ?? await this.service.parse(document);
                if (!tree) {
                    return undefined;
                }

                if (token.isCancellationRequested) { return undefined; }

                const node = tree.rootNode.descendantForPosition({
                    row: position.line,
                    column: position.character
                });

                const identifier = resolveToIdentifier(node);
                if (!identifier) {
                    return undefined;
                }

                const hoverRange = new vscode.Range(
                    new vscode.Position(identifier.startPosition.row, identifier.startPosition.column),
                    new vscode.Position(identifier.endPosition.row, identifier.endPosition.column)
                );

                // Try local variable/parameter first
                const typeInfo = await this.findLocalTypeInfo(document, identifier);
                if (typeInfo) {
                    // If this is an auto variable with an inlay hint showing the type,
                    // suppress the hover to avoid redundancy
                    if (typeInfo.isAutoWithInlayHint) {
                        return undefined;
                    }
                    
                    const md = new vscode.MarkdownString();
                    md.appendCodeblock(typeInfo.signature, 'kanagawa');
                    if (typeInfo.initializer) {
                        md.appendMarkdown(`\n\n**Initializer:** \`${typeInfo.initializer}\``);
                    }
                    return new vscode.Hover(md, hoverRange);
                }

                if (token.isCancellationRequested) { return undefined; }

                // Resolve with confidence scoring using centralized service
                // Wrap in timeout to prevent hanging on complex resolution
                const resolution = await withTimeout(
                    'hover symbol resolution',
                    this.resolutionService.resolveAtPosition(
                        { document, position, tree, identifier },
                        { includeInaccessible: true }
                    ),
                    OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                );

                if (!resolution || resolution.confidence === 'none') {
                    return undefined;
                }

                // Build hover content based on confidence
                const markdowns = await this.buildHoverContent(document, resolution);

                if (markdowns.length > 0) {
                    return new vscode.Hover(markdowns, hoverRange);
                }

                return undefined;
            }); // end perfLogger.measure
        } catch (error) {
            // Log error but don't crash the provider
            console.error('Kanagawa: Hover provider error:', error);
            return undefined;
        }
    }

    /**
     * Builds hover markdown content based on resolution result.
     */
    private async buildHoverContent(
        document: vscode.TextDocument,
        resolution: HoverResolution
    ): Promise<vscode.MarkdownString[]> {
        const markdowns: vscode.MarkdownString[] = [];

        if (!resolution.primary) {
            return markdowns;
        }

        // Build primary symbol markdown
        const primaryMd = await this.buildSymbolMarkdown(document, resolution.primary);
        
        // Add alternatives count if there are any
        if (resolution.alternatives.length > 0) {
            primaryMd.appendMarkdown(
                `\n\n*+${resolution.alternatives.length} other definition${resolution.alternatives.length === 1 ? '' : 's'}*`
            );
        }

        markdowns.push(primaryMd);

        // Add import suggestion for inaccessible symbols
        if (resolution.confidence === 'low' && resolution.inaccessible.length > 0) {
            const inaccessibleSym = resolution.inaccessible[0];
            const modulePath = extractModuleFromQualified(inaccessibleSym.qualifiedName);
            if (modulePath) {
                const suggestMd = new vscode.MarkdownString();
                suggestMd.appendMarkdown(`\n\n💡 *Did you mean to import \`${modulePath}\`?*`);
                markdowns.push(suggestMd);
            }
        }

        return markdowns;
    }

    /**
     * Builds markdown for a single symbol.
     */
    private async buildSymbolMarkdown(
        document: vscode.TextDocument,
        sym: SymbolInfo
    ): Promise<vscode.MarkdownString> {
        const summary = (sym.signature ?? `${sym.detail ?? ''} ${sym.name}`.trim()).trim() || sym.name;
        const md = new vscode.MarkdownString();
        md.appendCodeblock(summary, 'kanagawa');

        if (sym.docMarkdown) {
            md.appendMarkdown(`\n\n${sym.docMarkdown}`);
        }

        // Template parameters for applicable symbol types
        const templateCategories = ['class', 'struct', 'union', 'alias', 'function', 'method'];
        if (templateCategories.includes(sym.category)) {
            const templateParams = await this.indexer.getTemplateParametersForSymbol(sym);
            if (templateParams.length > 0) {
                md.appendMarkdown(`\n\n**Template Parameters:**\n`);
                for (const param of templateParams) {
                    const label = param.signature ?? param.name;
                    const doc = param.docMarkdown
                        ? param.docMarkdown
                            .split(/\r?\n/)
                            .map(part => part.trim())
                            .filter(part => part.length)
                            .join(' ')
                        : undefined;
                    const line = doc ? `\`${label}\` — ${doc}` : `\`${label}\``;
                    md.appendMarkdown(`\n${line}  `);
                }
            }
        }

        if (sym.scopePath.length > 0) {
            md.appendMarkdown(`\n\n**Scope:** ${sym.scopePath.join('::')}`);
        }

        const relative = vscode.workspace.asRelativePath(sym.uri, false);
        md.appendMarkdown(`\n\n*Defined in ${relative}*`);

        return md;
    }

    /**
     * Finds local type information for a variable or parameter.
     * Also detects if this is an auto variable that would have an inlay type hint shown.
     */
    private async findLocalTypeInfo(
        document: vscode.TextDocument, 
        identifier: Parser.SyntaxNode
    ): Promise<{ signature: string; initializer?: string; isAutoWithInlayHint?: boolean } | undefined> {
        let current: Parser.SyntaxNode | null = identifier.parent;
        while (current) {
            if (current.type === 'variable_decl') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    const typeNode = current.childForFieldName('type');
                    const initializerNode = current.childForFieldName('initializer');
                    const typeText = getNodeText(document, typeNode);
                    const initializerText = getNodeText(document, initializerNode)?.trim();
                    
                    // Check if this is an auto variable
                    const isAuto = typeText?.includes('auto') ?? false;
                    let isAutoWithInlayHint = false;
                    
                    // If auto with initializer, check if we can infer the type
                    // (which means an inlay hint would be shown)
                    if (isAuto && initializerNode) {
                        const config = vscode.workspace.getConfiguration('kanagawa.inlayHints');
                        const typeHintsEnabled = config.get<boolean>('typeHints.enabled', true);
                        
                        if (typeHintsEnabled) {
                            // Check if we can infer the type - if so, inlay hint is showing
                            const initValue = this.findInitializerValue(current) ?? initializerNode;
                            const inferredType = await this.indexer.inferTypeFromExpression(document, initValue);
                            
                            if (inferredType && inferredType !== 'auto' && inferredType !== 'unknown') {
                                isAutoWithInlayHint = true;
                            }
                        }
                    }
                    
                    const signatureParts = [] as string[];
                    if (typeText) {
                        signatureParts.push(typeText.trim());
                    }
                    signatureParts.push(identifier.text);
                    return {
                        signature: signatureParts.join(' '),
                        initializer: initializerText,
                        isAutoWithInlayHint
                    };
                }
            } else if (current.type === 'parameter') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    const typeNode = current.childForFieldName('type');
                    const typeText = getNodeText(document, typeNode)?.trim();
                    const signature = typeText ? `${typeText} ${identifier.text}` : identifier.text;
                    return { signature };
                }
            }
            current = current.parent;
        }
        return undefined;
    }

    /**
     * Finds the initializer value in a variable declaration.
     */
    private findInitializerValue(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        // Look for pattern: name = value or name = { ... }
        let foundEquals = false;
        for (const child of node.children) {
            if (child.type === '=' || child.text === '=') {
                foundEquals = true;
                continue;
            }
            if (foundEquals && child.type !== ';') {
                return child;
            }
        }
        return undefined;
    }
}
