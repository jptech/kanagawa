import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo } from '../service/indexer';
import { 
    stripAttributes, 
    extractFunctionParameters, 
    splitParameters, 
    isTypeName,
    parseParameterNames 
} from '../utils/signatureUtils';

/**
 * Document-local cache for inlay hints to avoid repeated indexer lookups.
 * Cleared when the document changes.
 */
interface InlayHintCache {
    /** Cache function signatures by function name */
    signatures: Map<string, string | undefined>;
    /** Cache template parameters by type name */
    templateParams: Map<string, string[]>;
    /** Cache resolved symbols by name */
    symbols: Map<string, SymbolInfo | undefined>;
}

/**
 * Inlay Hints Provider for Kanagawa.
 * 
 * Provides visual hints for:
 * - Type annotations for `auto` variables
 * - Parameter names at call sites
 * - Template parameter names
 * 
 * Uses document-local caching to minimize indexer queries.
 */
export class KanagawaInlayHintsProvider implements vscode.InlayHintsProvider {
    /** Document-local cache for symbol lookups */
    private cacheByDocument: Map<string, InlayHintCache> = new Map();
    
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}
    
    /**
     * Clears the cache for a specific document.
     * Call this when the document content changes.
     */
    public invalidateCache(uri: vscode.Uri): void {
        this.cacheByDocument.delete(uri.toString());
    }
    
    /**
     * Clears all cached data.
     */
    public clearAllCaches(): void {
        this.cacheByDocument.clear();
    }
    
    private getOrCreateCache(uri: vscode.Uri): InlayHintCache {
        const key = uri.toString();
        let cache = this.cacheByDocument.get(key);
        if (!cache) {
            cache = {
                signatures: new Map(),
                templateParams: new Map(),
                symbols: new Map()
            };
            this.cacheByDocument.set(key, cache);
        }
        return cache;
    }

    private getConfig() {
        const config = vscode.workspace.getConfiguration('kanagawa.inlayHints');
        return {
            typeHintsEnabled: config.get<boolean>('typeHints.enabled', true),
            parameterNamesEnabled: config.get<boolean>('parameterNames.enabled', true),
            templateParameterNamesEnabled: config.get<boolean>('templateParameterNames.enabled', true)
        };
    }

    async provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): Promise<vscode.InlayHint[]> {
        try {
            const config = this.getConfig();
            
            // Early exit if all hints are disabled
            if (!config.typeHintsEnabled && !config.parameterNamesEnabled && !config.templateParameterNamesEnabled) {
                return [];
            }

            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) { return []; }
            
            // Get or create document-local cache
            const cache = this.getOrCreateCache(document.uri);

            const hints: vscode.InlayHint[] = [];

            // Find nodes in the visible range
            const startPoint = { row: range.start.line, column: range.start.character };
            const endPoint = { row: range.end.line, column: range.end.character };

            // Collect hints - now async to use indexer's type inference
            await this.collectHints(document, tree.rootNode, startPoint, endPoint, hints, token, config, cache);

            return hints;
        } catch (error) {
            console.error('[InlayHints] Error providing hints:', error);
            return [];
        }
    }

    private async collectHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        startPoint: Parser.Point,
        endPoint: Parser.Point,
        hints: vscode.InlayHint[],
        token: vscode.CancellationToken,
        config: { typeHintsEnabled: boolean; parameterNamesEnabled: boolean; templateParameterNamesEnabled: boolean },
        cache: InlayHintCache
    ): Promise<void> {
        if (token.isCancellationRequested) { return; }

        // Skip nodes outside the visible range
        if (node.endPosition.row < startPoint.row || node.startPosition.row > endPoint.row) {
            return;
        }

        // Check for auto variable declarations - need type inference
        if (config.typeHintsEnabled && node.type === 'variable_decl') {
            const hint = await this.createTypeHintForAutoVariable(document, node);
            if (hint) { hints.push(hint); }
        }

        // Check for call expressions (parameter name hints and template parameter hints)
        if (node.type === 'call_expression') {
            if (config.parameterNamesEnabled) {
                const paramHints = await this.createParameterHints(document, node, cache);
                hints.push(...paramHints);
            }
            if (config.templateParameterNamesEnabled) {
                const templateHints = await this.createTemplateParameterHints(document, node, cache);
                hints.push(...templateHints);
            }
        }

        // Check for template instantiations in type context (e.g., `FIFO<uint32, 32> x;`)
        // The grammar uses 'template_instantiation' for templated type specifiers
        if (config.templateParameterNamesEnabled && 
            (node.type === 'template_instantiation' || node.type === 'template_type')) {
            const templateTypeHints = await this.createTemplateTypeHints(document, node, cache);
            hints.push(...templateTypeHints);
        }

        // Also check for type specifiers that contain template arguments
        // The grammar may parse `Example<uint8>` as: identifier, <, identifier, > (without template_args node)
        if (config.templateParameterNamesEnabled && node.type === 'type_specifier') {
            const templateArgs = node.children.find(c => c.type === 'template_args');
            if (templateArgs) {
                const templateTypeHints = await this.createTemplateTypeHints(document, node, cache);
                hints.push(...templateTypeHints);
            } else {
                // Check for raw angle bracket tokens (identifier, <, args..., >)
                const hasAngleBrackets = node.children.some(c => c.text === '<') && 
                                         node.children.some(c => c.text === '>');
                if (hasAngleBrackets) {
                    const templateTypeHints = await this.createTemplateTypeHintsFromRawTokens(document, node, cache);
                    hints.push(...templateTypeHints);
                }
            }
        }

        // Recurse into children
        for (const child of node.children) {
            await this.collectHints(document, child, startPoint, endPoint, hints, token, config, cache);
        }
    }

    /**
     * Creates type hint for `auto` variable declarations.
     * Shows the inferred type after the variable name.
     * Uses the indexer's authoritative type inference for consistency.
     */
    private async createTypeHintForAutoVariable(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
    ): Promise<vscode.InlayHint | undefined> {
        // Look for 'auto' type specifier
        const typeNode = node.childForFieldName('type') ?? 
                         node.children.find(c => c.type === 'type_specifier' || c.type === 'auto');
        
        if (!typeNode) { return undefined; }
        
        // Check if type contains 'auto' (e.g., 'auto', 'const auto')
        const typeText = typeNode.text.trim();
        if (!typeText.includes('auto')) {
            return undefined;
        }

        // Find the variable name
        const nameNode = node.childForFieldName('name') ??
                         node.children.find(c => c.type === 'identifier');
        
        if (!nameNode) { return undefined; }

        // Find the initializer to infer type
        const initNode = node.childForFieldName('value') ??
                         node.childForFieldName('initializer') ??
                         this.findInitializerValue(node);

        if (!initNode) { return undefined; }

        // Use the indexer's authoritative type inference
        const inferredType = await this.indexer.inferTypeFromExpression(document, initNode);

        if (!inferredType || inferredType === 'auto' || inferredType === 'unknown') {
            return undefined;
        }

        const position = new vscode.Position(
            nameNode.endPosition.row,
            nameNode.endPosition.column
        );

        const hint = new vscode.InlayHint(
            position,
            `: ${inferredType}`,
            vscode.InlayHintKind.Type
        );
        hint.paddingLeft = false;
        hint.paddingRight = true;

        return hint;
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

    /**
     * Creates parameter name hints at call sites.
     * Uses the same resolution logic as hover/signature help for consistency.
     * Results are cached per-document to avoid repeated indexer lookups.
     */
    private async createParameterHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        cache: InlayHintCache
    ): Promise<vscode.InlayHint[]> {
        const results: vscode.InlayHint[] = [];
        
        // Get the function being called
        const funcNode = node.childForFieldName('function') ??
                         node.namedChild(0);
        
        if (!funcNode) { return results; }

        // Get the argument list
        const argsNode = node.childForFieldName('arguments') ??
                         node.children.find(c => c.type === 'argument_list');
        
        if (!argsNode) { return results; }

        // Get the arguments (skip parentheses and commas)
        const args = argsNode.children.filter(c => 
            c.type !== '(' && c.type !== ')' && c.type !== ',' && c.isNamed
        );

        if (args.length === 0) { return results; }

        // Resolve the function using the same logic as signature help
        // Check cache first for function signature
        const funcName = this.getFunctionName(funcNode);
        const cacheKey = funcName ? `${funcName}:${funcNode.type}` : undefined;
        
        let funcSignature: string | undefined;
        
        if (cacheKey && cache.signatures.has(cacheKey)) {
            funcSignature = cache.signatures.get(cacheKey);
        } else {
            let funcSymbol: { signature?: string } | undefined;

            // Try member expression first (obj.method())
            if (funcNode.type === 'member_expression') {
                const propertyNode = funcNode.namedChild(funcNode.namedChildCount - 1);
                if (propertyNode) {
                    const matches = await this.indexer.resolveMemberSymbol(document, propertyNode);
                    funcSymbol = matches?.find(s => 
                        (s.category === 'function' || s.category === 'method') && !!s.signature
                    );
                }
            }

            // Try as free function using resolveWithContext
            if (!funcSymbol && funcName) {
                const scopePath = this.indexer.getScopePathForNode(funcNode);
                const resolution = this.indexer.resolveWithContext(funcName, scopePath, {
                    uri: document.uri,
                    context: { kind: 'free' }
                });
                
                const candidates = resolution.primary 
                    ? [resolution.primary, ...resolution.alternatives]
                    : resolution.alternatives;
                
                funcSymbol = candidates.find(s => 
                    (s.category === 'function' || s.category === 'method') && !!s.signature
                );
            }

            funcSignature = funcSymbol?.signature;
            
            // Cache the result (even if undefined to avoid repeated lookups)
            if (cacheKey) {
                cache.signatures.set(cacheKey, funcSignature);
            }
        }

        if (!funcSignature) { return results; }

        // Parse parameter names from signature using shared utility
        const paramNames = parseParameterNames(funcSignature);

        // Create hints for each argument
        for (let i = 0; i < args.length && i < paramNames.length; i++) {
            const arg = args[i];
            const paramName = paramNames[i];

            // Skip if argument is already a named argument (name: value)
            if (this.isNamedArgument(arg)) { continue; }

            // Skip if the argument text matches the parameter name
            if (arg.text === paramName) { continue; }

            // Skip for simple literals that are self-explanatory
            if (this.isSelfExplanatoryArgument(arg, paramName)) { continue; }

            // Create the hint
            const position = new vscode.Position(
                arg.startPosition.row,
                arg.startPosition.column
            );

            const hint = new vscode.InlayHint(
                position,
                `${paramName}:`,
                vscode.InlayHintKind.Parameter
            );
            hint.paddingLeft = false;
            hint.paddingRight = true;

            results.push(hint);
        }
        
        return results;
    }

    /**
     * Creates template parameter name hints for template instantiations in call expressions.
     * Example: `foo<T, N>(...)` → shows `T:` and `N:` before template arguments
     * 
     * Uses the indexer's getTemplateParametersForSymbol for accurate parameter names.
     * Results are cached per-document to avoid repeated lookups.
     */
    private async createTemplateParameterHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        cache: InlayHintCache
    ): Promise<vscode.InlayHint[]> {
        const results: vscode.InlayHint[] = [];
        
        try {
            // Get the function being called
            const funcNode = node.childForFieldName('function') ?? node.namedChild(0);
            if (!funcNode) { return results; }

            // Look for template_args within the callee
            const templateArgs = this.findTemplateArgs(funcNode);
            if (!templateArgs) { return results; }

            // Get the base function name (without template args)
            const baseName = this.getBaseFunctionName(funcNode);
            if (!baseName) { return results; }

            // Check cache for template parameters
            if (cache.templateParams.has(baseName)) {
                const cachedParams = cache.templateParams.get(baseName)!;
                if (cachedParams.length === 0) { return results; }
                return this.createHintsForTemplateArgs(templateArgs, cachedParams);
            }

            // Look up the template definition to get parameter names
            const symbols = this.indexer.getSymbols(baseName);
            if (!symbols || symbols.length === 0) {
                cache.templateParams.set(baseName, []);
                return results;
            }

            // Find a template symbol
            let templateSymbol = symbols.find(s => s.detail && s.detail.includes('template'));
            
            // If not found by detail, try to get template parameters directly
            if (!templateSymbol) {
                for (const sym of symbols) {
                    const params = await this.indexer.getTemplateParametersForSymbol(sym);
                    if (params.length > 0) {
                        templateSymbol = sym;
                        break;
                    }
                }
            }

            if (!templateSymbol) {
                cache.templateParams.set(baseName, []);
                return results;
            }

            // Get template parameters using the indexer's accurate AST-based method
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);
            if (templateParams.length === 0) {
                // Fallback to parsing from detail string
                const paramNames = this.parseTemplateParameterNames(templateSymbol.detail ?? templateSymbol.signature ?? '');
                cache.templateParams.set(baseName, paramNames);
                if (paramNames.length === 0) { return results; }
                return this.createHintsForTemplateArgs(templateArgs, paramNames);
            }

            // Extract parameter names from the SymbolInfo objects
            const paramNames = templateParams.map(p => p.name);
            cache.templateParams.set(baseName, paramNames);
            return this.createHintsForTemplateArgs(templateArgs, paramNames);
        } catch (error) {
            console.error('[InlayHints] Error creating template parameter hints:', error);
            return results;
        }
    }

    /**
     * Creates template parameter name hints for template types.
     * Example: `Foo<int32, 10>` → shows `T:` and `N:` before arguments
     * 
     * Uses the indexer's getTemplateParametersForSymbol for accurate parameter names.
     * Results are cached per-document to avoid repeated lookups.
     */
    private async createTemplateTypeHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        cache: InlayHintCache
    ): Promise<vscode.InlayHint[]> {
        const results: vscode.InlayHint[] = [];
        
        try {
            // Handle both 'template_type' and 'template_instantiation' node types
            // template_instantiation: identifier followed by template_args
            // template_type: type_identifier followed by template_args
            let nameNode = node.children.find(c => 
                c.type === 'identifier' || c.type === 'type_identifier'
            );
            let templateArgs = node.children.find(c => c.type === 'template_args');
            
            // For template_instantiation, the first child might be the identifier directly
            if (!nameNode && node.namedChildCount > 0) {
                const firstChild = node.namedChild(0);
                if (firstChild && (firstChild.type === 'identifier' || firstChild.type === 'type_identifier')) {
                    nameNode = firstChild;
                }
            }
            
            if (!nameNode || !templateArgs) { return results; }

            const typeName = nameNode.text;

            // Check cache for template parameters
            if (cache.templateParams.has(typeName)) {
                const cachedParams = cache.templateParams.get(typeName)!;
                if (cachedParams.length === 0) { return results; }
                return this.createHintsForTemplateArgs(templateArgs, cachedParams);
            }

            // Look up the template definition
            const symbols = this.indexer.getSymbols(typeName);
            if (!symbols || symbols.length === 0) {
                cache.templateParams.set(typeName, []);
                return results;
            }

            // Find a template symbol (class, struct, or alias)
            let templateSymbol = symbols.find(s => 
                (s.category === 'class' || s.category === 'struct' || s.category === 'alias') && 
                s.detail && s.detail.includes('template')
            );
            
            // If not found by detail, try to get template parameters directly
            if (!templateSymbol) {
                for (const sym of symbols) {
                    if (sym.category === 'class' || sym.category === 'struct' || sym.category === 'alias') {
                        const params = await this.indexer.getTemplateParametersForSymbol(sym);
                        if (params.length > 0) {
                            templateSymbol = sym;
                            break;
                        }
                    }
                }
            }

            if (!templateSymbol) {
                cache.templateParams.set(typeName, []);
                return results;
            }

            // Get template parameters using the indexer's accurate AST-based method
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);
            if (templateParams.length === 0) {
                // Fallback to parsing from detail string
                const paramNames = this.parseTemplateParameterNames(templateSymbol.detail ?? templateSymbol.signature ?? '');
                cache.templateParams.set(typeName, paramNames);
                if (paramNames.length === 0) { return results; }
                return this.createHintsForTemplateArgs(templateArgs, paramNames);
            }

            // Extract parameter names from the SymbolInfo objects
            const paramNames = templateParams.map(p => p.name);
            cache.templateParams.set(typeName, paramNames);
            return this.createHintsForTemplateArgs(templateArgs, paramNames);
        } catch (error) {
            console.error('[InlayHints] Error creating template type hints:', error);
            return results;
        }
    }

    /**
     * Creates template parameter hints when the grammar parses as raw tokens.
     * Handles: `Example<uint8>` parsed as children: [identifier, <, identifier, >]
     * instead of [identifier, template_args]
     * Results are cached per-document.
     */
    private async createTemplateTypeHintsFromRawTokens(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        cache: InlayHintCache
    ): Promise<vscode.InlayHint[]> {
        const results: vscode.InlayHint[] = [];

        try {
            // Find the type name (first identifier before '<')
            const children = node.children;
            let typeNameNode: Parser.SyntaxNode | undefined;
            let openBracketIndex = -1;
            let closeBracketIndex = -1;

            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.text === '<') {
                    openBracketIndex = i;
                    // Type name should be the identifier just before '<'
                    if (i > 0 && (children[i - 1].type === 'identifier' || children[i - 1].type === 'type_identifier')) {
                        typeNameNode = children[i - 1];
                    }
                } else if (child.text === '>') {
                    closeBracketIndex = i;
                    break;
                }
            }

            if (!typeNameNode || openBracketIndex < 0 || closeBracketIndex < 0) {
                return results;
            }

            const typeName = typeNameNode.text;

            // Extract argument nodes between < and >, grouped by comma separators
            // This handles expressions like `Width * 8` correctly
            const argSlice = children.slice(openBracketIndex + 1, closeBracketIndex);
            const argNodes = this.groupTemplateArguments(argSlice);

            if (argNodes.length === 0) { return results; }

            // Check cache for template parameters
            if (cache.templateParams.has(typeName)) {
                const cachedParams = cache.templateParams.get(typeName)!;
                if (cachedParams.length === 0) { return results; }
                return this.createHintsForRawTemplateArgs(argNodes, cachedParams);
            }

            // Look up the template definition
            const symbols = this.indexer.getSymbols(typeName);
            if (!symbols || symbols.length === 0) {
                cache.templateParams.set(typeName, []);
                return results;
            }

            // Find a template symbol
            let templateSymbol = symbols.find(s =>
                (s.category === 'class' || s.category === 'struct' || s.category === 'alias') &&
                s.detail && s.detail.includes('template')
            );

            if (!templateSymbol) {
                for (const sym of symbols) {
                    if (sym.category === 'class' || sym.category === 'struct' || sym.category === 'alias') {
                        const params = await this.indexer.getTemplateParametersForSymbol(sym);
                        if (params.length > 0) {
                            templateSymbol = sym;
                            break;
                        }
                    }
                }
            }

            if (!templateSymbol) {
                cache.templateParams.set(typeName, []);
                return results;
            }

            // Get template parameters
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);
            let paramNames: string[];

            if (templateParams.length > 0) {
                paramNames = templateParams.map(p => p.name);
            } else {
                paramNames = this.parseTemplateParameterNames(templateSymbol.detail ?? templateSymbol.signature ?? '');
            }

            // Cache the result
            cache.templateParams.set(typeName, paramNames);
            
            if (paramNames.length === 0) { return results; }

            // Create hints for each argument using extracted helper
            return this.createHintsForRawTemplateArgs(argNodes, paramNames);
        } catch (error) {
            console.error('[InlayHints] Error creating template hints from raw tokens:', error);
            return results;
        }
    }
    
    /**
     * Helper to create hints for raw template argument nodes.
     */
    private createHintsForRawTemplateArgs(
        argNodes: Parser.SyntaxNode[],
        paramNames: string[]
    ): vscode.InlayHint[] {
        const results: vscode.InlayHint[] = [];
        
        for (let i = 0; i < argNodes.length && i < paramNames.length; i++) {
            const arg = argNodes[i];
            const paramName = paramNames[i];

            // Skip if argument text matches parameter name
            if (arg.text.trim() === paramName) { continue; }

            // Skip single-letter params for numeric literals
            const argText = arg.text.trim();
            if (/^\d+$/.test(argText) && paramName.length <= 1) { continue; }

            const position = new vscode.Position(
                arg.startPosition.row,
                arg.startPosition.column
            );

            const hint = new vscode.InlayHint(
                position,
                `${paramName}:`,
                vscode.InlayHintKind.Parameter
            );
            hint.paddingLeft = false;
            hint.paddingRight = true;

            results.push(hint);
        }

        return results;
    }

    /**
     * Creates inlay hints for template arguments given parameter names.
     * Shared helper used by both createTemplateParameterHints and createTemplateTypeHints.
     * 
     * Handles expressions in template arguments (e.g., `Width * 8`) by grouping tokens
     * between commas rather than treating each token as a separate argument.
     */
    private createHintsForTemplateArgs(
        templateArgs: Parser.SyntaxNode,
        paramNames: string[]
    ): vscode.InlayHint[] {
        const results: vscode.InlayHint[] = [];

        // Group children by comma separators to handle expressions like `Width * 8`
        // The grammar may parse these as multiple tokens rather than a single expression node
        const args = this.groupTemplateArguments(templateArgs.children);

        // Create hints for each template argument
        for (let i = 0; i < args.length && i < paramNames.length; i++) {
            const arg = args[i];
            const paramName = paramNames[i];

            // Skip if argument text already matches parameter name
            if (arg.text.trim() === paramName) { continue; }

            // Skip numeric literals that match common pattern names like "N", "Size", etc.
            // (they're self-explanatory for value parameters)
            const argText = arg.text.trim();
            if (/^\d+$/.test(argText) && paramName.length <= 1) { continue; }

            const position = new vscode.Position(
                arg.startPosition.row,
                arg.startPosition.column
            );

            const hint = new vscode.InlayHint(
                position,
                `${paramName}:`,
                vscode.InlayHintKind.Parameter
            );
            hint.paddingLeft = false;
            hint.paddingRight = true;

            results.push(hint);
        }

        return results;
    }

    /**
     * Groups template argument children by comma separators.
     * Returns the first significant token of each argument group.
     * Skips comments and other non-significant tokens.
     * 
     * For example, given children: [<, identifier, *, number, ,, comment, identifier, >]
     * Returns: [identifier (first arg), identifier (second arg)]
     */
    private groupTemplateArguments(children: Parser.SyntaxNode[]): Parser.SyntaxNode[] {
        const args: Parser.SyntaxNode[] = [];
        let currentArgStart: Parser.SyntaxNode | undefined;

        for (const child of children) {
            // Skip opening/closing angle brackets
            if (child.text === '<' || child.text === '>') {
                continue;
            }

            // Comma marks the end of current argument and start of next
            if (child.text === ',') {
                currentArgStart = undefined;
                continue;
            }

            // Skip comments - they should not be treated as arguments
            if (child.type === 'comment') {
                continue;
            }

            // Skip whitespace-only or empty tokens
            if (!child.text.trim()) {
                continue;
            }

            // First non-trivial token after comma or start is the argument's start
            if (!currentArgStart) {
                currentArgStart = child;
                args.push(child);
            }
            // Otherwise, this token is part of the current argument (e.g., `*`, `8` in `Width * 8`)
            // We don't add it to args since we only want the first token for positioning
        }

        return args;
    }

    /**
     * Parses template parameter names from a template declaration.
     * Example: "template <typename T, auto N>" → ["T", "N"]
     */
    private parseTemplateParameterNames(detail: string): string[] {
        const names: string[] = [];
        
        // Match template parameters: template <...>
        const match = detail.match(/template\s*<([^>]+)>/);
        if (!match) { return names; }

        const params = match[1];
        const paramList = splitParameters(params);

        for (const param of paramList) {
            const trimmed = param.trim();
            // Handle: "typename T", "auto N", "int32 Size"
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
                // Last part before '=' is the name
                const withoutDefault = parts.join(' ').split('=')[0].trim();
                const nameParts = withoutDefault.split(/\s+/);
                const name = nameParts[nameParts.length - 1];
                if (name) {
                    names.push(name);
                }
            } else if (parts.length === 1) {
                // Just a name
                names.push(parts[0]);
            }
        }

        return names;
    }

    /**
     * Finds template_args node within a function node.
     */
    private findTemplateArgs(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        // Direct child
        const direct = node.children.find(c => c.type === 'template_args');
        if (direct) { return direct; }

        // For member_expression, check the member part
        if (node.type === 'member_expression') {
            const member = node.childForFieldName('member') ?? node.namedChild(node.namedChildCount - 1);
            if (member) {
                return this.findTemplateArgs(member);
            }
        }

        // Check if it's a template_call node
        if (node.type === 'template_call') {
            return node.children.find(c => c.type === 'template_args');
        }

        return undefined;
    }

    /**
     * Gets the base function name (without template args).
     */
    private getBaseFunctionName(node: Parser.SyntaxNode): string | undefined {
        if (node.type === 'identifier') {
            return node.text;
        }
        
        if (node.type === 'template_call') {
            const ident = node.children.find(c => c.type === 'identifier');
            return ident?.text;
        }
        
        if (node.type === 'member_expression') {
            const member = node.childForFieldName('member') ?? node.namedChild(node.namedChildCount - 1);
            if (member) {
                return this.getBaseFunctionName(member);
            }
        }
        
        return undefined;
    }

    /**
     * Gets the function name from a call expression's function node.
     */
    private getFunctionName(node: Parser.SyntaxNode): string | undefined {
        if (node.type === 'identifier') {
            return node.text;
        }
        if (node.type === 'template_call') {
            const ident = node.children.find(c => c.type === 'identifier');
            return ident?.text;
        }
        if (node.type === 'member_expression') {
            // Get the member name (last part)
            const member = node.childForFieldName('member') ??
                          node.namedChild(node.namedChildCount - 1);
            if (member) {
                return this.getFunctionName(member);
            }
        }
        return undefined;
    }

    /**
     * Checks if an argument is already named (name: value syntax).
     */
    private isNamedArgument(node: Parser.SyntaxNode): boolean {
        // Check if this is a named argument pattern
        return node.type === 'named_argument' || 
               (node.children.length >= 2 && node.children[1]?.text === ':');
    }

    /**
     * Checks if an argument is self-explanatory (e.g., `true` for `enabled`).
     */
    private isSelfExplanatoryArgument(node: Parser.SyntaxNode, paramName: string): boolean {
        const text = node.text.toLowerCase();
        const param = paramName.toLowerCase();

        // Boolean literals with obvious names
        if ((text === 'true' || text === 'false') && 
            (param.startsWith('is') || param.startsWith('has') || param.startsWith('enable') || 
             param.startsWith('disable') || param === 'flag' || param === 'condition')) {
            return true;
        }

        // Single-character parameter with matching variable name
        if (node.type === 'identifier' && text === param) {
            return true;
        }

        return false;
    }
}
