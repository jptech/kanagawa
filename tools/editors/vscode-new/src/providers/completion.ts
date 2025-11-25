import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { TreeSitterService } from '../service/treeSitter';
import { extractModuleFromQualified } from '../utils/importUtils';

// Kanagawa language keywords (from overview.md and grammar.js)
const KEYWORDS = [
    // Module system
    'module', 'import', 'export', 'extern', 'as',
    // Type declarations
    'class', 'struct', 'union', 'enum', 'using', 'template', 'typename', 'decltype',
    // Modifiers
    'static', 'const', 'inline', 'noinline', 'auto', 'void',
    // Primitive types
    'bool', 'int', 'uint', 'float32', 'string',
    // Control flow
    'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do', 'break', 'continue', 'return',
    // Concurrency primitives
    'atomic', 'barrier', 'reorder',
    // Visibility
    'public', 'private',
    // Literals
    'true', 'false',
    // Built-in operators
    'bitsizeof', 'bytesizeof', 'clog2',
    // Cast operators
    'cast', 'static_cast', 'reinterpret_cast', 'checked_cast',
];

/**
 * Sort text prefixes for completion tiers.
 * Lower prefix = higher priority in the completion list.
 */
const SORT_PREFIX = {
    LOCAL: '0_',          // Tier 1: Local variables/parameters
    SAME_MODULE: '1_',    // Tier 2: Same-module symbols
    IMPORTED: '2_',       // Tier 3: Imported symbols
    KEYWORD: '3_',        // Tier 4: Language keywords
    GLOBAL: '4_',         // Tier 5: Global symbols (no module)
    INACCESSIBLE: '9_'    // Not shown by default, lowest priority
} as const;

export class KanagawaCompletionItemProvider implements vscode.CompletionItemProvider {
    constructor(
        private indexer: WorkspaceIndexer,
        private treeService: TreeSitterService
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        void _context;
        const tree = this.treeService.getTree(document) ?? await this.treeService.parse(document);
        if (!tree) { return undefined; }

        const lineText = document.lineAt(position.line).text;
        const prefix = lineText.slice(0, position.character);

        // Member completions (after '.')
        if (prefix.endsWith('.')) {
            const memberItems = await this.provideMemberCompletions(document, position, tree, token);
            if (memberItems.length > 0) {
                return new vscode.CompletionList(memberItems, true);
            }
        }

        // Static member completions (after '::')
        if (prefix.endsWith('::')) {
            const staticItems = await this.provideStaticMemberCompletions(document, position, tree, token, prefix);
            if (staticItems.length > 0) {
                return new vscode.CompletionList(staticItems, true);
            }
        }

        // General completions with tiered sorting
        const currentPrefix = this.extractWordPrefix(lineText, position.character);
        const items = await this.provideGeneralCompletions(document, position, tree, currentPrefix);

        return new vscode.CompletionList(items, false);
    }

    /**
     * Provides general completions with tiered sorting:
     * Tier 1: Locals → Tier 2: Same-module → Tier 3: Imported → Tier 4: Keywords
     */
    private async provideGeneralCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree,
        currentPrefix: string
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        const seenNames = new Set<string>();

        const resolvedImports = this.indexer.getResolvedImports(document.uri);

        // Tier 1: Local variables and parameters (highest priority)
        const locals = this.indexer.collectVisibleLocals(document, position, tree);
        for (const local of locals) {
            if (currentPrefix && !local.name.startsWith(currentPrefix)) continue;
            if (seenNames.has(local.name)) continue;
            seenNames.add(local.name);

            const item = new vscode.CompletionItem(local.name, vscode.CompletionItemKind.Variable);
            item.sortText = SORT_PREFIX.LOCAL + local.name;
            item.detail = local.typeHint ?? '(local)';
            items.push(item);
        }

        // Tiers 2-5: Workspace symbols (filtered and tiered)
        const symbols = this.indexer.getAllSymbols();
        for (const sym of symbols) {
            if (currentPrefix && !sym.name.startsWith(currentPrefix)) continue;
            if (seenNames.has(sym.name)) continue;
            seenNames.add(sym.name);

            const tier = this.computeSymbolTier(sym, resolvedImports);

            // Skip inaccessible symbols (unless typing qualified name)
            if (tier === 'inaccessible' && !currentPrefix.includes('.')) {
                continue;
            }

            const item = this.createSymbolCompletionItem(sym, tier);
            items.push(item);
        }

        // Tier 4: Keywords
        for (const kw of KEYWORDS) {
            if (currentPrefix && !kw.startsWith(currentPrefix)) continue;
            if (seenNames.has(kw)) continue;
            seenNames.add(kw);

            const keywordItem = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            keywordItem.sortText = SORT_PREFIX.KEYWORD + kw;
            items.push(keywordItem);
        }

        return items;
    }

    /**
     * Determines the completion tier for a symbol based on accessibility.
     */
    private computeSymbolTier(
        sym: SymbolInfo,
        resolvedImports: ReturnType<typeof this.indexer.getResolvedImports> | undefined
    ): 'same_module' | 'imported' | 'global' | 'inaccessible' {
        const modulePath = extractModuleFromQualified(sym.qualifiedName);

        // No module = global scope
        if (!modulePath) {
            return 'global';
        }

        if (!resolvedImports) {
            return 'global'; // No import info, treat as accessible
        }

        // Same module = highest priority
        if (modulePath === resolvedImports.currentModule) {
            return 'same_module';
        }

        // Imported module
        if (resolvedImports.importedModules.has(modulePath)) {
            return 'imported';
        }

        // Not accessible
        return 'inaccessible';
    }

    /**
     * Creates a completion item for a workspace symbol with appropriate tier sorting.
     */
    private createSymbolCompletionItem(
        sym: SymbolInfo,
        tier: 'same_module' | 'imported' | 'global' | 'inaccessible'
    ): vscode.CompletionItem {
        const item = new vscode.CompletionItem(sym.name, this.mapSymbolKindToCompletionKind(sym.kind));
        item.detail = sym.detail;

        if (sym.docMarkdown) {
            item.documentation = new vscode.MarkdownString(sym.docMarkdown);
        }

        // Set sort text based on tier
        switch (tier) {
            case 'same_module':
                item.sortText = SORT_PREFIX.SAME_MODULE + sym.name;
                break;
            case 'imported':
                item.sortText = SORT_PREFIX.IMPORTED + sym.name;
                break;
            case 'global':
                item.sortText = SORT_PREFIX.GLOBAL + sym.name;
                break;
            case 'inaccessible':
                item.sortText = SORT_PREFIX.INACCESSIBLE + sym.name;
                // Add note that import is required
                if (!item.detail) {
                    item.detail = '(requires import)';
                } else {
                    item.detail = `${item.detail} (requires import)`;
                }
                break;
        }

        return item;
    }

    private mapSymbolKindToCompletionKind(kind: vscode.SymbolKind): vscode.CompletionItemKind {
        switch (kind) {
            case vscode.SymbolKind.Class: return vscode.CompletionItemKind.Class;
            case vscode.SymbolKind.Method: return vscode.CompletionItemKind.Method;
            case vscode.SymbolKind.Function: return vscode.CompletionItemKind.Function;
            case vscode.SymbolKind.Variable: return vscode.CompletionItemKind.Variable;
            case vscode.SymbolKind.Module: return vscode.CompletionItemKind.Module;
            case vscode.SymbolKind.Interface: return vscode.CompletionItemKind.Interface;
            case vscode.SymbolKind.Struct: return vscode.CompletionItemKind.Struct;
            case vscode.SymbolKind.Enum: return vscode.CompletionItemKind.Enum;
            default: return vscode.CompletionItemKind.Text;
        }
    }

    private async provideMemberCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        const targetPos = {
            row: position.line,
            column: Math.max(0, position.character - 1)
        };

        let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(targetPos);
        while (node && node.type !== 'member_expression') {
            node = node.parent;
        }

        if (!node || node.type !== 'member_expression') {
            return [];
        }

        const objectNode = node.namedChild(0);
        if (!objectNode) {
            return [];
        }

        const receiverType = await this.indexer.inferTypeFromExpression(document, objectNode);
        if (!receiverType) {
            return [];
        }

        const members = this.indexer.getMembersForType(receiverType, {
            includeMethods: true,
            includeFields: true
        });

        if (!members.length) {
            return [];
        }

        const items: vscode.CompletionItem[] = [];
        const used = new Set<string>();

        for (const sym of members) {
            if (token.isCancellationRequested) { break; }
            const key = `${sym.name}|${sym.category}|${sym.uri.toString()}|${sym.range.start.line}`;
            if (used.has(key)) { continue; }
            used.add(key);

            const kind = sym.category === 'method'
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Field;

            const item = new vscode.CompletionItem(sym.name, kind);
            if (sym.signature) {
                item.detail = sym.signature;
            } else if (sym.typeHint) {
                item.detail = sym.typeHint;
            }

            if (sym.docMarkdown) {
                item.documentation = new vscode.MarkdownString(sym.docMarkdown);
            }

            if (sym.category === 'method') {
                item.insertText = new vscode.SnippetString(`${sym.name}($0)`);
                item.commitCharacters = ['('];
            } else {
                item.commitCharacters = ['.', ';'];
            }

            // Methods before fields in member completions
            item.sortText = sym.category === 'method' ? `0_${sym.name}` : `1_${sym.name}`;

            items.push(item);
        }

        return items;
    }

    private async provideStaticMemberCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree,
        token: vscode.CancellationToken,
        prefix: string
    ): Promise<vscode.CompletionItem[]> {
        const match = prefix.match(/([A-Za-z_][\w.]*)::$/);
        if (!match) { return []; }
        const typeName = match[1];
        if (!typeName) { return []; }

        const members = this.indexer.getMembersForType(typeName, {
            includeMethods: true,
            includeFields: true
        });

        if (!members.length) { return []; }

        const items: vscode.CompletionItem[] = [];
        const used = new Set<string>();

        for (const sym of members) {
            if (token.isCancellationRequested) { break; }
            const key = `${sym.name}|${sym.category}|${sym.uri.toString()}|${sym.range.start.line}`;
            if (used.has(key)) { continue; }
            used.add(key);

            const kind = sym.category === 'method'
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Field;

            const item = new vscode.CompletionItem(sym.name, kind);
            if (sym.signature) {
                item.detail = sym.signature;
            } else if (sym.typeHint) {
                item.detail = sym.typeHint;
            }

            if (sym.docMarkdown) {
                item.documentation = new vscode.MarkdownString(sym.docMarkdown);
            }

            if (sym.category === 'method') {
                item.insertText = new vscode.SnippetString(`${sym.name}($0)`);
            }

            item.sortText = sym.category === 'method' ? `0_${sym.name}` : `1_${sym.name}`;
            items.push(item);
        }

        return items;
    }

    private extractWordPrefix(line: string, column: number): string {
        let idx = column - 1;
        while (idx >= 0) {
            const ch = line[idx];
            if (!/[A-Za-z0-9_]/.test(ch)) {
                break;
            }
            idx--;
        }
        const prefix = line.slice(idx + 1, column);
        return prefix;
    }
}
