import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer } from '../service/indexer';

/**
 * Inlay Hints Provider for Kanagawa.
 * 
 * Provides visual hints for:
 * - Type annotations for `auto` variables
 * - Parameter names at call sites
 * - Template parameter names
 */
export class KanagawaInlayHintsProvider implements vscode.InlayHintsProvider {
    constructor(
        private service: TreeSitterService,
        private indexer: WorkspaceIndexer
    ) {}

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

            const hints: vscode.InlayHint[] = [];

            // Find nodes in the visible range
            const startPoint = { row: range.start.line, column: range.start.character };
            const endPoint = { row: range.end.line, column: range.end.character };

            // Collect hints - now async to use indexer's type inference
            await this.collectHints(document, tree.rootNode, startPoint, endPoint, hints, token, config);

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
        config: { typeHintsEnabled: boolean; parameterNamesEnabled: boolean; templateParameterNamesEnabled: boolean }
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
                const paramHints = await this.createParameterHints(document, node);
                hints.push(...paramHints);
            }
            if (config.templateParameterNamesEnabled) {
                const templateHints = await this.createTemplateParameterHints(document, node);
                hints.push(...templateHints);
            }
        }

        // Check for template instantiations in type context (e.g., `FIFO<uint32, 32> x;`)
        // The grammar uses 'template_instantiation' for templated type specifiers
        if (config.templateParameterNamesEnabled && 
            (node.type === 'template_instantiation' || node.type === 'template_type')) {
            const templateTypeHints = await this.createTemplateTypeHints(document, node);
            hints.push(...templateTypeHints);
        }

        // Also check for type specifiers that contain template arguments
        // The grammar may parse `Example<uint8>` as: identifier, <, identifier, > (without template_args node)
        if (config.templateParameterNamesEnabled && node.type === 'type_specifier') {
            const templateArgs = node.children.find(c => c.type === 'template_args');
            if (templateArgs) {
                const templateTypeHints = await this.createTemplateTypeHints(document, node);
                hints.push(...templateTypeHints);
            } else {
                // Check for raw angle bracket tokens (identifier, <, args..., >)
                const hasAngleBrackets = node.children.some(c => c.text === '<') && 
                                         node.children.some(c => c.text === '>');
                if (hasAngleBrackets) {
                    const templateTypeHints = await this.createTemplateTypeHintsFromRawTokens(document, node);
                    hints.push(...templateTypeHints);
                }
            }
        }

        // Recurse into children
        for (const child of node.children) {
            await this.collectHints(document, child, startPoint, endPoint, hints, token, config);
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
     */
    private async createParameterHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
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
        if (!funcSymbol) {
            const funcName = this.getFunctionName(funcNode);
            if (funcName) {
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
        }

        if (!funcSymbol?.signature) { return results; }

        // Parse parameter names from signature
        const paramNames = this.parseParameterNames(funcSymbol.signature);

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
     */
    private async createTemplateParameterHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
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

            // Look up the template definition to get parameter names
            const symbols = this.indexer.getSymbols(baseName);
            if (!symbols || symbols.length === 0) { return results; }

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

            if (!templateSymbol) { return results; }

            // Get template parameters using the indexer's accurate AST-based method
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);
            if (templateParams.length === 0) {
                // Fallback to parsing from detail string
                const paramNames = this.parseTemplateParameterNames(templateSymbol.detail ?? templateSymbol.signature ?? '');
                if (paramNames.length === 0) { return results; }
                return this.createHintsForTemplateArgs(templateArgs, paramNames);
            }

            // Extract parameter names from the SymbolInfo objects
            const paramNames = templateParams.map(p => p.name);
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
     */
    private async createTemplateTypeHints(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
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

            // Look up the template definition
            const symbols = this.indexer.getSymbols(typeName);
            if (!symbols || symbols.length === 0) { return results; }

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

            if (!templateSymbol) { return results; }

            // Get template parameters using the indexer's accurate AST-based method
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);
            if (templateParams.length === 0) {
                // Fallback to parsing from detail string
                const paramNames = this.parseTemplateParameterNames(templateSymbol.detail ?? templateSymbol.signature ?? '');
                if (paramNames.length === 0) { return results; }
                return this.createHintsForTemplateArgs(templateArgs, paramNames);
            }

            // Extract parameter names from the SymbolInfo objects
            const paramNames = templateParams.map(p => p.name);
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
     */
    private async createTemplateTypeHintsFromRawTokens(
        document: vscode.TextDocument,
        node: Parser.SyntaxNode
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

            // Extract argument nodes (everything between < and >)
            const argNodes: Parser.SyntaxNode[] = [];
            for (let i = openBracketIndex + 1; i < closeBracketIndex; i++) {
                const child = children[i];
                // Skip commas
                if (child.type !== ',' && child.text !== ',') {
                    argNodes.push(child);
                }
            }

            if (argNodes.length === 0) { return results; }

            // Look up the template definition
            const symbols = this.indexer.getSymbols(typeName);
            if (!symbols || symbols.length === 0) { return results; }

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

            if (!templateSymbol) { return results; }

            // Get template parameters
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);
            let paramNames: string[];

            if (templateParams.length > 0) {
                paramNames = templateParams.map(p => p.name);
            } else {
                paramNames = this.parseTemplateParameterNames(templateSymbol.detail ?? templateSymbol.signature ?? '');
            }

            if (paramNames.length === 0) { return results; }

            // Create hints for each argument
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
        } catch (error) {
            console.error('[InlayHints] Error creating template hints from raw tokens:', error);
            return results;
        }
    }

    /**
     * Creates inlay hints for template arguments given parameter names.
     * Shared helper used by both createTemplateParameterHints and createTemplateTypeHints.
     */
    private createHintsForTemplateArgs(
        templateArgs: Parser.SyntaxNode,
        paramNames: string[]
    ): vscode.InlayHint[] {
        const results: vscode.InlayHint[] = [];

        // Get template arguments (skip < > and commas)
        const args = templateArgs.children.filter(c => 
            c.type !== '<' && c.type !== '>' && c.type !== ',' && c.text !== '<' && c.text !== '>'
        );

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
     * Parses template parameter names from a template declaration.
     * Example: "template <typename T, auto N>" → ["T", "N"]
     */
    private parseTemplateParameterNames(detail: string): string[] {
        const names: string[] = [];
        
        // Match template parameters: template <...>
        const match = detail.match(/template\s*<([^>]+)>/);
        if (!match) { return names; }

        const params = match[1];
        const paramList = this.splitParameters(params);

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
     * Parses parameter names from a function signature.
     * Example: "void push(T value, bool block)" → ["value", "block"]
     */
    private parseParameterNames(signature: string): string[] {
        const names: string[] = [];
        
        // Find the parameter list (between parentheses)
        const match = signature.match(/\(([^)]*)\)/);
        if (!match) { return names; }

        const params = match[1];
        if (!params.trim()) { return names; }

        // Split by comma, handling nested templates
        const paramList = this.splitParameters(params);

        for (const param of paramList) {
            // Extract the parameter name (last identifier before any default value)
            const trimmed = param.trim();
            
            // Remove default value
            const withoutDefault = trimmed.split('=')[0].trim();
            
            // Find the last word (parameter name)
            const parts = withoutDefault.split(/\s+/);
            if (parts.length > 0) {
                const name = parts[parts.length - 1]
                    .replace(/[&*\[\]]/g, '') // Remove pointer/reference/array markers
                    .trim();
                if (name && !this.isTypeName(name)) {
                    names.push(name);
                }
            }
        }

        return names;
    }

    /**
     * Splits parameters handling nested templates.
     */
    private splitParameters(params: string): string[] {
        const result: string[] = [];
        let current = '';
        let depth = 0;

        for (const char of params) {
            if (char === '<' || char === '(') {
                depth++;
                current += char;
            } else if (char === '>' || char === ')') {
                depth--;
                current += char;
            } else if (char === ',' && depth === 0) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }

        if (current.trim()) {
            result.push(current);
        }

        return result;
    }

    /**
     * Checks if a name looks like a type name.
     */
    private isTypeName(name: string): boolean {
        const types = ['void', 'bool', 'int', 'uint', 'auto', 'char', 'float', 'double'];
        return types.includes(name) || 
               /^(u?int\d+|uint\d+_t|float\d+)$/.test(name) ||
               /^[A-Z]/.test(name); // PascalCase is likely a type
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
