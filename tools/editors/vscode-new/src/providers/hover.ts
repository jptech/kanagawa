import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from '../service/indexer';
import { extractModuleFromQualified } from '../utils/importUtils';
import { getNodeText } from '../utils/nodeUtils';
import { perfLogger, PerfOps } from '../utils/perfLogger';

/**
 * Result of resolving hover candidates with confidence scoring.
 */
interface HoverResolution {
    /** Primary symbol to display */
    primary: SymbolInfo | undefined;
    /** Resolution confidence level */
    confidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
    /** Additional candidates beyond primary */
    alternatives: SymbolInfo[];
    /** Symbols that would require an import */
    inaccessible: SymbolInfo[];
}

export class KanagawaHoverProvider implements vscode.HoverProvider {
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        return perfLogger.measure(PerfOps.HOVER, document.uri.toString(), async () => {
            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) {
                return undefined;
            }

            const node = tree.rootNode.descendantForPosition({
                row: position.line,
                column: position.character
            });

            const identifier = this.resolveIdentifierNode(node);
            if (!identifier) {
                return undefined;
            }

            const hoverRange = new vscode.Range(
                new vscode.Position(identifier.startPosition.row, identifier.startPosition.column),
                new vscode.Position(identifier.endPosition.row, identifier.endPosition.column)
            );

            // Try local variable/parameter first
            const typeInfo = this.findLocalTypeInfo(document, identifier);
            if (typeInfo) {
                const md = new vscode.MarkdownString();
                md.appendCodeblock(typeInfo.signature, 'kanagawa');
                if (typeInfo.initializer) {
                    md.appendMarkdown(`\n\n**Initializer:** \`${typeInfo.initializer}\``);
                }
                return new vscode.Hover(md, hoverRange);
            }

            // Resolve with confidence scoring
            const resolution = await this.resolveWithConfidence(document, identifier);

            if (resolution.confidence === 'none') {
                return undefined;
            }

            // Build hover content based on confidence
            const markdowns = await this.buildHoverContent(document, resolution);

            if (markdowns.length > 0) {
                return new vscode.Hover(markdowns, hoverRange);
            }

            return undefined;
        }); // end perfLogger.measure
    }

    /**
     * Resolves hover candidates with confidence scoring.
     * Categorizes symbols into accessible and inaccessible.
     */
    private async resolveWithConfidence(
        document: vscode.TextDocument,
        identifier: Parser.SyntaxNode
    ): Promise<HoverResolution> {
        const name = identifier.text;
        const scopePath = this.indexer.getScopePathForNode(identifier);
        const contextHint = await this.buildContextHint(document, identifier);

        const accessible: SymbolInfo[] = [];
        const inaccessible: SymbolInfo[] = [];
        const seen = new Set<string>();

        const addSymbol = (sym: SymbolInfo, isAccessible: boolean) => {
            const key = `${sym.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}`;
            if (seen.has(key)) return;
            seen.add(key);
            if (isAccessible) {
                accessible.push(sym);
            } else {
                inaccessible.push(sym);
            }
        };

        // Check local symbols first (always accessible)
        const localSymbol = this.indexer.findNearestLocalSymbol(document, identifier);
        if (localSymbol) {
            addSymbol(localSymbol, true);
        }

        // Check member resolution (for obj.method patterns)
        const memberMatches = await this.indexer.resolveMemberSymbol(document, identifier);
        if (memberMatches && memberMatches.length > 0) {
            for (const sym of memberMatches) {
                addSymbol(sym, true);
            }
        }

        // If no member matches, do general symbol resolution
        if (!memberMatches || memberMatches.length === 0) {
            const resolution = this.indexer.resolveWithContext(name, scopePath, {
                uri: document.uri,
                context: contextHint
            });

            // Get resolved imports to determine accessibility
            const resolvedImports = this.indexer.getResolvedImports(document.uri);

            if (resolution.primary) {
                const isAccessible = this.isSymbolAccessible(resolution.primary, resolvedImports);
                addSymbol(resolution.primary, isAccessible);
            }

            for (const alt of resolution.alternatives) {
                const isAccessible = this.isSymbolAccessible(alt, resolvedImports);
                addSymbol(alt, isAccessible);
            }
        }

        // Fallback: document-local symbols
        if (accessible.length === 0 && inaccessible.length === 0) {
            const locals = await this.indexer.findSymbolsInDocument(document, name);
            for (const sym of locals) {
                addSymbol(sym, true);
            }
        }

        return this.computeConfidence(accessible, inaccessible);
    }

    /**
     * Computes confidence level based on resolved symbols.
     */
    private computeConfidence(
        accessible: SymbolInfo[],
        inaccessible: SymbolInfo[]
    ): HoverResolution {
        if (accessible.length === 0 && inaccessible.length === 0) {
            return {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
        }

        // Single accessible match = exact
        if (accessible.length === 1) {
            return {
                primary: accessible[0],
                confidence: 'exact',
                alternatives: [],
                inaccessible
            };
        }

        // Multiple accessible matches
        if (accessible.length > 1) {
            return {
                primary: accessible[0],
                confidence: accessible.length <= 3 ? 'high' : 'medium',
                alternatives: accessible.slice(1),
                inaccessible
            };
        }

        // Only inaccessible matches
        return {
            primary: inaccessible[0],
            confidence: 'low',
            alternatives: inaccessible.slice(1),
            inaccessible
        };
    }

    /**
     * Checks if a symbol is accessible from the current document.
     */
    private isSymbolAccessible(
        symbol: SymbolInfo,
        resolvedImports: ReturnType<typeof this.indexer.getResolvedImports> | undefined
    ): boolean {
        if (!resolvedImports) {
            return true; // No import info, assume accessible
        }

        const modulePath = extractModuleFromQualified(symbol.qualifiedName);

        // No module = global scope, always accessible
        if (!modulePath) {
            return true;
        }

        // Same module
        if (modulePath === resolvedImports.currentModule) {
            return true;
        }

        // Imported module
        if (resolvedImports.importedModules.has(modulePath)) {
            return true;
        }

        return false;
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
     * Resolves identifier node from AST, handling various node types.
     */
    private resolveIdentifierNode(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
        let current = node;
        while (current) {
            if (current.type === 'identifier' || current.type === 'type_identifier') {
                return current;
            }
            if ((current.type === 'qualified_identifier' || current.type === 'template_instantiation') && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            if (current.type === 'module_name' && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            current = current.parent;
        }
        return null;
    }

    /**
     * Finds local type information for a variable or parameter.
     */
    private findLocalTypeInfo(document: vscode.TextDocument, identifier: Parser.SyntaxNode): { signature: string; initializer?: string } | undefined {
        let current: Parser.SyntaxNode | null = identifier.parent;
        while (current) {
            if (current.type === 'variable_decl') {
                const nameNode = current.childForFieldName('name');
                if (nameNode === identifier) {
                    const typeNode = current.childForFieldName('type');
                    const initializerNode = current.childForFieldName('initializer');
                    const typeText = getNodeText(document, typeNode);
                    const initializerText = getNodeText(document, initializerNode)?.trim();
                    const signatureParts = [] as string[];
                    if (typeText) {
                        signatureParts.push(typeText.trim());
                    }
                    signatureParts.push(identifier.text);
                    return {
                        signature: signatureParts.join(' '),
                        initializer: initializerText
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
     * Builds context hint for symbol resolution based on identifier usage.
     */
    private async buildContextHint(document: vscode.TextDocument, identifier: Parser.SyntaxNode): Promise<SymbolContextHint> {
        let current: Parser.SyntaxNode | null = identifier.parent;
        while (current) {
            if (current.type === 'member_expression' && current.namedChildCount >= 2) {
                const propertyNode = current.namedChild(current.namedChildCount - 1);
                if (propertyNode === identifier) {
                    const receiverNode = current.namedChild(0);
                    const receiverType = await this.indexer.inferTypeFromExpression(document, receiverNode ?? undefined);
                    return { kind: 'method', receiverType };
                }
            }
            current = current.parent;
        }
        return { kind: 'free' };
    }
}
