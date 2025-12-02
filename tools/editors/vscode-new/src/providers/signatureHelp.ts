import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { WorkspaceIndexer, SymbolInfo, SymbolContextHint } from '../service/indexer';
import { getNodeText } from '../utils/nodeUtils';
import { OPERATION_TIMEOUTS, withTimeout } from '../utils/timeout';

interface CallContext {
    callExpression: Parser.SyntaxNode;
    argumentList: Parser.SyntaxNode;
    callee: Parser.SyntaxNode;
}

/** Context for template argument signature help */
interface TemplateContext {
    /** The template instantiation node (e.g., `FIFO<...>`) */
    templateNode: Parser.SyntaxNode;
    /** The template arguments node (e.g., `<uint32, 32>`) */
    templateArgs: Parser.SyntaxNode;
    /** The base name of the template (e.g., `FIFO`) */
    baseName: string;
}

/** Parsed parameter information */
interface ParsedParameter {
    label: string;         // Full parameter text: "uint32 size"
    name: string;          // Just the name: "size"
    type?: string;         // Just the type: "uint32"
    defaultValue?: string; // Default value if any: "0"
    documentation?: string; // Doc comment for this param
}

export class KanagawaSignatureHelpProvider implements vscode.SignatureHelpProvider {
    constructor(
        private readonly service: TreeSitterService,
        private readonly indexer: WorkspaceIndexer
    ) {}

    async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.SignatureHelpContext
    ): Promise<vscode.SignatureHelp | undefined> {
        try {
            return await this.provideSignatureHelpImpl(document, position, token, context);
        } catch (error) {
            console.error('[SignatureHelp] Error:', error);
            return undefined;
        }
    }

    private async provideSignatureHelpImpl(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.SignatureHelpContext
    ): Promise<vscode.SignatureHelp | undefined> {
        const tree = this.service.getTree(document) ?? await this.service.parse(document);
        if (!tree) { 
            // If we have previous signature help and this is a retrigger, preserve it
            if (context.isRetrigger && context.activeSignatureHelp) {
                return this.updateActiveParameterOnly(document, position, context.activeSignatureHelp);
            }
            return undefined; 
        }

        const node = tree.rootNode.descendantForPosition({
            row: position.line,
            column: position.character
        });

        // FIRST: Check for template context (triggered by '<')
        // Template signature help takes priority over function call help
        const templateHelpEnabled = vscode.workspace.getConfiguration('kanagawa.signatureHelp.templateParameters').get<boolean>('enabled', true);
        if (templateHelpEnabled) {
            const templateContext = this.findTemplateContext(node, document, position, tree);
            if (templateContext) {
                const templateHelp = await this.provideTemplateSignatureHelp(document, position, templateContext);
                if (templateHelp) {
                    return templateHelp;
                }
            }
        }

        // Try multiple strategies to find the call context
        let callContext = this.findCallContext(node);
        
        // If not found, try searching from a slightly earlier position
        // This helps when cursor is right after '(' or ','
        if (!callContext && position.character > 0) {
            const prevNode = tree.rootNode.descendantForPosition({
                row: position.line,
                column: position.character - 1
            });
            callContext = this.findCallContext(prevNode);
        }
        
        // Try text-based fallback for incomplete parses
        if (!callContext) {
            callContext = this.findCallContextFromText(document, position, tree);
        }
        
        // If still no call context but we have active signature help, preserve it with updated parameter
        // This handles cases where AST is temporarily broken while typing
        if (!callContext) { 
            if (context.isRetrigger && context.activeSignatureHelp) {
                return this.updateActiveParameterOnly(document, position, context.activeSignatureHelp);
            }
            return undefined; 
        }

        const offset = document.offsetAt(position);
        
        // Compute active parameter - prefer text-based counting for robustness
        const activeParameter = this.computeActiveParameterFromText(document, position) 
            ?? this.computeActiveParameter(document, callContext.argumentList, offset);

        const candidates = await this.resolveSignatures(document, callContext);
        if (!candidates.length) { return undefined; }

        const signatureHelp = new vscode.SignatureHelp();
        signatureHelp.signatures = candidates.map(entry => entry.signature);
        signatureHelp.activeSignature = 0;
        if (candidates.length > 0) {
            const paramCount = signatureHelp.signatures[0].parameters.length;
            signatureHelp.activeParameter = paramCount === 0
                ? 0
                : Math.min(activeParameter, Math.max(0, paramCount - 1));
        }

        const primarySymbol = candidates[0]?.symbol;
        const templateHint = primarySymbol ? await this.buildTemplateHint(document, callContext, primarySymbol) : undefined;
        if (templateHint) {
            signatureHelp.signatures.unshift(templateHint);
            signatureHelp.activeSignature = 0;
        }

        return signatureHelp;
    }

    /**
     * Compute active parameter by counting commas in the text from the opening paren to cursor.
     * This is more robust than AST-based counting when the tree is incomplete.
     */
    private computeActiveParameterFromText(
        document: vscode.TextDocument,
        position: vscode.Position
    ): number | undefined {
        // Get text from start of document to cursor (or a reasonable chunk)
        const startLine = Math.max(0, position.line - 20); // Look back up to 20 lines
        const textRange = new vscode.Range(startLine, 0, position.line, position.character);
        const text = document.getText(textRange);
        
        // Find the matching opening parenthesis by scanning backwards
        let parenDepth = 0;
        let angleDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let openParenIndex = -1;
        
        for (let i = text.length - 1; i >= 0; i--) {
            const ch = text[i];
            switch (ch) {
                case ')': parenDepth++; break;
                case '(':
                    if (parenDepth === 0) {
                        openParenIndex = i;
                    } else {
                        parenDepth--;
                    }
                    break;
                case '>': angleDepth++; break;
                case '<': angleDepth = Math.max(0, angleDepth - 1); break;
                case ']': bracketDepth++; break;
                case '[': bracketDepth = Math.max(0, bracketDepth - 1); break;
                case '}': braceDepth++; break;
                case '{': braceDepth = Math.max(0, braceDepth - 1); break;
            }
            if (openParenIndex >= 0) { break; }
        }
        
        if (openParenIndex < 0) { return undefined; }
        
        // Count commas from opening paren to cursor, respecting nesting
        const argsText = text.substring(openParenIndex + 1); // Text after '('
        let commaCount = 0;
        parenDepth = 0;
        angleDepth = 0;
        bracketDepth = 0;
        braceDepth = 0;
        let inString = false;
        let stringChar = '';
        
        for (let i = 0; i < argsText.length; i++) {
            const ch = argsText[i];
            const prevCh = i > 0 ? argsText[i - 1] : '';
            
            // Handle string literals
            if ((ch === '"' || ch === "'") && prevCh !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = ch;
                } else if (ch === stringChar) {
                    inString = false;
                }
                continue;
            }
            
            if (inString) { continue; }
            
            switch (ch) {
                case '(': parenDepth++; break;
                case ')': parenDepth--; break;
                case '<': angleDepth++; break;
                case '>': angleDepth--; break;
                case '[': bracketDepth++; break;
                case ']': bracketDepth--; break;
                case '{': braceDepth++; break;
                case '}': braceDepth--; break;
                case ',':
                    // Only count commas at the top level (not nested in parens, angles, etc.)
                    if (parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                        commaCount++;
                    }
                    break;
            }
        }
        
        return commaCount;
    }

    /**
     * Preserves existing signature help but updates the active parameter.
     * Used when AST is temporarily broken but we want to keep showing signature help.
     */
    private updateActiveParameterOnly(
        document: vscode.TextDocument,
        position: vscode.Position,
        existingHelp: vscode.SignatureHelp
    ): vscode.SignatureHelp | undefined {
        // First, check if we're still inside a function call
        // by verifying there's an unclosed parenthesis before the cursor
        if (!this.isInsideFunctionCall(document, position)) {
            return undefined; // Dismiss signature help
        }
        
        const activeParameter = this.computeActiveParameterFromText(document, position) ?? 0;
        
        const updatedHelp = new vscode.SignatureHelp();
        updatedHelp.signatures = existingHelp.signatures;
        updatedHelp.activeSignature = existingHelp.activeSignature;
        
        // Update active parameter within bounds
        const activeSignature = existingHelp.signatures[existingHelp.activeSignature];
        if (activeSignature) {
            const paramCount = activeSignature.parameters.length;
            updatedHelp.activeParameter = paramCount === 0
                ? 0
                : Math.min(activeParameter, Math.max(0, paramCount - 1));
        } else {
            updatedHelp.activeParameter = activeParameter;
        }
        
        return updatedHelp;
    }

    /**
     * Checks if the cursor is inside a function call (has unclosed opening parenthesis).
     */
    private isInsideFunctionCall(
        document: vscode.TextDocument,
        position: vscode.Position
    ): boolean {
        const startLine = Math.max(0, position.line - 20);
        const textRange = new vscode.Range(startLine, 0, position.line, position.character);
        const text = document.getText(textRange);
        
        let parenDepth = 0;
        let inString = false;
        let stringChar = '';
        
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const prevCh = i > 0 ? text[i - 1] : '';
            
            // Handle string literals
            if ((ch === '"' || ch === "'") && prevCh !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = ch;
                } else if (ch === stringChar) {
                    inString = false;
                }
                continue;
            }
            
            if (inString) { continue; }
            
            if (ch === '(') { parenDepth++; }
            else if (ch === ')') { parenDepth--; }
        }
        
        // If parenDepth > 0, we have unclosed parentheses (inside a call)
        return parenDepth > 0;
    }

    private findCallContext(node: Parser.SyntaxNode | null): CallContext | undefined {
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            // Direct argument_list match
            if (current.type === 'argument_list') {
                const callExpression = current.parent;
                if (callExpression && callExpression.type === 'call_expression') {
                    const callee = this.getCalleeNode(callExpression);
                    if (callee) {
                        return { callExpression, argumentList: current, callee };
                    }
                }
            }
            
            // Check if we're in a call_expression (handles incomplete parses)
            if (current.type === 'call_expression') {
                const callee = this.getCalleeNode(current);
                const argList = current.children.find(c => c.type === 'argument_list');
                if (callee && argList) {
                    return { callExpression: current, argumentList: argList, callee };
                }
                // Even without argument_list, we might be right after the opening paren
                if (callee) {
                    // Create a synthetic range for the "argument list" from callee end to current end
                    return { 
                        callExpression: current, 
                        argumentList: current, // Use call_expression as fallback
                        callee 
                    };
                }
            }
            
            current = current.parent;
        }
        return undefined;
    }

    /**
     * Text-based fallback to find call context when AST is incomplete.
     * Scans backwards from cursor to find opening parenthesis and function name.
     */
    private findCallContextFromText(
        document: vscode.TextDocument, 
        position: vscode.Position,
        tree: Parser.Tree
    ): CallContext | undefined {
        const lineText = document.lineAt(position.line).text;
        const textBeforeCursor = lineText.substring(0, position.character);
        
        // Find the matching opening parenthesis
        let parenDepth = 0;
        let openParenIndex = -1;
        
        for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
            const ch = textBeforeCursor[i];
            if (ch === ')') {
                parenDepth++;
            } else if (ch === '(') {
                if (parenDepth === 0) {
                    openParenIndex = i;
                    break;
                }
                parenDepth--;
            }
        }
        
        if (openParenIndex < 0) { return undefined; }
        
        // Find the identifier/expression before the opening paren
        // Skip whitespace
        let identEnd = openParenIndex;
        while (identEnd > 0 && /\s/.test(textBeforeCursor[identEnd - 1])) {
            identEnd--;
        }
        
        if (identEnd <= 0) { return undefined; }
        
        // Now find the AST node at the position just before the '('
        const nodeBeforeParen = tree.rootNode.descendantForPosition({
            row: position.line,
            column: identEnd - 1
        });
        
        if (!nodeBeforeParen) { return undefined; }
        
        // Walk up to find a call_expression or the callee itself
        let callee: Parser.SyntaxNode | undefined;
        let callExpr: Parser.SyntaxNode | undefined;
        let argList: Parser.SyntaxNode | undefined;
        
        let current: Parser.SyntaxNode | null = nodeBeforeParen;
        while (current) {
            if (current.type === 'call_expression') {
                callExpr = current;
                callee = this.getCalleeNode(current);
                argList = current.children.find(c => c.type === 'argument_list');
                break;
            }
            // If we find an identifier or member_expression, it might be our callee
            if (!callee && (current.type === 'identifier' || current.type === 'member_expression')) {
                callee = current;
            }
            current = current.parent;
        }
        
        if (!callee) { return undefined; }
        
        // If we found a callee but no call_expression, construct one
        if (!callExpr) {
            // Use the callee's parent as a best-effort call expression
            callExpr = callee.parent ?? callee;
        }
        
        return {
            callExpression: callExpr,
            argumentList: argList ?? callExpr,
            callee
        };
    }

    private getCalleeNode(callExpression: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        for (const child of callExpression.namedChildren) {
            if (child.type === 'argument_list') { continue; }
            if (child.type === 'call_attributes') { continue; }
            return child;
        }
        return undefined;
    }

    private computeActiveParameter(
        document: vscode.TextDocument,
        argumentList: Parser.SyntaxNode,
        offset: number
    ): number {
        const args = argumentList.namedChildren.filter(child => child.type !== ',');
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (offset <= arg.startIndex) {
                return i;
            }
            if (offset <= arg.endIndex) {
                return i;
            }
        }

        const text = getNodeText(document, argumentList);
        if (!text) { return args.length; }

        const relative = Math.min(Math.max(0, offset - argumentList.startIndex), text.length);
        let commas = 0;
        let parenDepth = 0;
        let angleDepth = 0;
        let bracketDepth = 0;
        for (let i = 0; i < relative; i++) {
            const ch = text[i];
            switch (ch) {
                case '(': parenDepth++; break;
                case ')': parenDepth = Math.max(0, parenDepth - 1); break;
                case '<': angleDepth++; break;
                case '>': angleDepth = Math.max(0, angleDepth - 1); break;
                case '[': bracketDepth++; break;
                case ']': bracketDepth = Math.max(0, bracketDepth - 1); break;
                case ',':
                    if (parenDepth <= 1 && angleDepth === 0 && bracketDepth === 0) {
                        commas++;
                    }
                    break;
                default:
                    break;
            }
        }
        return Math.min(commas, args.length);
    }

    /**
     * Resolves function signatures for a call expression.
     * Uses the same resolution logic as hover for consistency.
     */
    private async resolveSignatures(
        document: vscode.TextDocument,
        callContext: CallContext
    ): Promise<Array<{ symbol: SymbolInfo; signature: vscode.SignatureInformation }>> {
        const { callee } = callContext;
        let symbols: SymbolInfo[] = [];

        // Try member expression first (obj.method())
        if (callee.type === 'member_expression') {
            const propertyNode = callee.namedChild(callee.namedChildCount - 1);
            if (propertyNode) {
                const matches = await withTimeout(
                    'signature help member resolution',
                    this.indexer.resolveMemberSymbol(document, propertyNode),
                    OPERATION_TIMEOUTS.SYMBOL_RESOLUTION
                );
                if (matches && matches.length > 0) {
                    // Filter to callable symbols
                    symbols = matches.filter(sym => 
                        sym.category === 'function' || 
                        sym.category === 'method' ||
                        sym.signature?.includes('(')
                    );
                }
            }
        }

        // Try as free function or constructor using resolveWithContext (same as hover)
        if (!symbols.length) {
            const identifier = this.extractIdentifierNode(callee);
            if (identifier) {
                const scopePath = this.indexer.getScopePathForNode(identifier);
                
                // Use resolveWithContext for consistent resolution with hover
                const contextHint: SymbolContextHint = { kind: 'free' };
                const resolution = this.indexer.resolveWithContext(identifier.text, scopePath, {
                    uri: document.uri,
                    context: contextHint
                });
                
                // Collect primary and alternatives
                const allCandidates: SymbolInfo[] = [];
                if (resolution.primary) {
                    allCandidates.push(resolution.primary);
                }
                allCandidates.push(...resolution.alternatives);
                
                // Filter to functions/methods that have signatures
                symbols = allCandidates.filter(sym => 
                    sym.category === 'function' || 
                    sym.category === 'method' ||
                    sym.signature?.includes('(')
                );
                
                // If no functions found, it might be a constructor call (ClassName())
                if (symbols.length === 0) {
                    const typeSymbols = allCandidates.filter(sym => 
                        sym.category === 'class' || 
                        sym.category === 'struct'
                    );
                    
                    if (typeSymbols.length > 0) {
                        // Look for constructor methods in the class
                        for (const typeSym of typeSymbols) {
                            const members = this.indexer.getMembersForType(typeSym.name, {
                                includeMethods: true,
                                includeFields: false
                            });
                            const constructors = members.filter(m => 
                                m.name === typeSym.name || 
                                m.name === 'constructor' ||
                                m.name === 'new'
                            );
                            if (constructors.length > 0) {
                                symbols.push(...constructors);
                            } else {
                                // No explicit constructor, use the class itself with generic signature
                                symbols.push(typeSym);
                            }
                        }
                    }
                }
            }
        }

        if (!symbols.length) {
            return [];
        }

        // Convert symbols to signature information
        return symbols
            .filter(symbol => symbol.signature || symbol.name) // Must have something to show
            .map(symbol => ({
                symbol,
                signature: this.convertToSignatureInformation(symbol)
            }));
    }

    private extractIdentifierNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        let current: Parser.SyntaxNode | null = node;
        while (current) {
            if (current.type === 'identifier' || current.type === 'type_identifier') {
                return current;
            }
            if ((current.type === 'qualified_identifier' || current.type === 'template_instantiation') && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1);
                continue;
            }
            current = current.parent;
        }
        return undefined;
    }

    private convertToSignatureInformation(symbol: SymbolInfo): vscode.SignatureInformation {
        const fallback = `${symbol.detail ?? ''} ${symbol.name}`.trim();
        const label = (symbol.signature ?? fallback) || symbol.name;
        
        // Build documentation with return type
        const docParts: string[] = [];
        if (symbol.docMarkdown) {
            docParts.push(symbol.docMarkdown);
        }
        if (symbol.typeHint && symbol.typeHint !== 'void') {
            docParts.push(`\n\n**Returns:** \`${symbol.typeHint}\``);
        }
        
        const signatureInfo = new vscode.SignatureInformation(
            label, 
            docParts.length > 0 ? new vscode.MarkdownString(docParts.join('')) : undefined
        );
        
        // Parse parameters with enhanced info
        const parameters = this.parseParametersWithDetails(label, symbol.docMarkdown);
        signatureInfo.parameters = parameters.map(param => {
            const paramInfo = new vscode.ParameterInformation(param.label);
            
            // Build parameter documentation
            const paramDocParts: string[] = [];
            if (param.type) {
                paramDocParts.push(`**Type:** \`${param.type}\``);
            }
            if (param.defaultValue) {
                paramDocParts.push(`**Default:** \`${param.defaultValue}\``);
            }
            if (param.documentation) {
                paramDocParts.push(param.documentation);
            }
            
            if (paramDocParts.length > 0) {
                paramInfo.documentation = new vscode.MarkdownString(paramDocParts.join('\n\n'));
            }
            
            return paramInfo;
        });
        
        return signatureInfo;
    }

    /**
     * Parses parameters from signature with enhanced detail extraction.
     */
    private parseParametersWithDetails(signature: string, docMarkdown?: string): ParsedParameter[] {
        const rawParams = this.parseParametersFromSignature(signature);
        const paramDocs = this.extractParamDocs(docMarkdown);
        
        return rawParams.map(paramText => {
            const parsed = this.parseParameterDetails(paramText);
            
            // Try to find documentation for this parameter
            if (parsed.name && paramDocs.has(parsed.name)) {
                parsed.documentation = paramDocs.get(parsed.name);
            }
            
            return parsed;
        });
    }

    /**
     * Parses a single parameter string into its components.
     */
    private parseParameterDetails(paramText: string): ParsedParameter {
        const trimmed = paramText.trim();
        
        // Check for default value
        let defaultValue: string | undefined;
        let mainPart = trimmed;
        const defaultMatch = trimmed.match(/^(.+?)\s*=\s*(.+)$/);
        if (defaultMatch) {
            mainPart = defaultMatch[1].trim();
            defaultValue = defaultMatch[2].trim();
        }
        
        // Extract type and name
        // Patterns: "Type name", "Type& name", "Type* name", "const Type& name"
        const parts = mainPart.split(/\s+/);
        let name = parts[parts.length - 1] || '';
        let type: string | undefined;
        
        // Remove ref/ptr markers from name
        name = name.replace(/^[&*]+|[&*]+$/g, '');
        
        if (parts.length > 1) {
            // Everything except the last part is the type
            type = parts.slice(0, -1).join(' ');
            // Also include any ref/ptr markers that were on the name
            const markers = (parts[parts.length - 1] || '').match(/^[&*]+/)?.[0] ?? '';
            if (markers) {
                type += markers;
            }
        }
        
        return {
            label: trimmed,
            name,
            type,
            defaultValue
        };
    }

    /**
     * Extracts @param documentation from markdown doc comments.
     */
    private extractParamDocs(docMarkdown?: string): Map<string, string> {
        const result = new Map<string, string>();
        if (!docMarkdown) { return result; }
        
        // Match @param patterns: @param name description
        // Also handles: @param {type} name description
        const paramRegex = /@param\s+(?:\{[^}]+\}\s+)?(\w+)\s+([^\n@]+)/g;
        let match;
        
        while ((match = paramRegex.exec(docMarkdown)) !== null) {
            const name = match[1];
            const description = match[2].trim();
            result.set(name, description);
        }
        
        // Also try to match "param_name: description" format from line doc comments
        const lineParamRegex = /^\s*(\w+):\s+(.+)$/gm;
        while ((match = lineParamRegex.exec(docMarkdown)) !== null) {
            const name = match[1];
            // Only set if not already captured by @param
            if (!result.has(name)) {
                result.set(name, match[2].trim());
            }
        }
        
        return result;
    }

    private parseParametersFromSignature(signature: string): string[] {
        const openIndex = signature.indexOf('(');
        const closeIndex = signature.lastIndexOf(')');
        if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
            return [];
        }
        const body = signature.slice(openIndex + 1, closeIndex).trim();
        if (!body.length) { return []; }

        const parts: string[] = [];
        let current = '';
        let parenDepth = 0;
        let angleDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;

        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            switch (ch) {
                case '(': parenDepth++; current += ch; break;
                case ')': parenDepth = Math.max(0, parenDepth - 1); current += ch; break;
                case '<': angleDepth++; current += ch; break;
                case '>': angleDepth = Math.max(0, angleDepth - 1); current += ch; break;
                case '[': bracketDepth++; current += ch; break;
                case ']': bracketDepth = Math.max(0, bracketDepth - 1); current += ch; break;
                case '{': braceDepth++; current += ch; break;
                case '}': braceDepth = Math.max(0, braceDepth - 1); current += ch; break;
                case ',':
                    if (parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                        parts.push(current.trim());
                        current = '';
                    } else {
                        current += ch;
                    }
                    break;
                default:
                    current += ch;
                    break;
            }
        }
        if (current.trim().length > 0) {
            parts.push(current.trim());
        }
        return parts;
    }

    private async buildTemplateHint(
        document: vscode.TextDocument,
        context: CallContext,
        symbol: SymbolInfo
    ): Promise<vscode.SignatureInformation | undefined> {
        const templateParams: SymbolInfo[] = await this.indexer.getTemplateParametersForSymbol(symbol);
        if (!templateParams.length) { return undefined; }

        const argumentTexts = this.collectTemplateArgumentTexts(document, context.callExpression);
        const labelParts = templateParams.map((param: SymbolInfo) => param.signature ?? param.name);
        const label = `template< ${labelParts.join(', ')} >`;

        const signature = new vscode.SignatureInformation(label, symbol.docMarkdown);
        signature.parameters = templateParams.map((param: SymbolInfo, index: number) => {
            const actual = argumentTexts[index];
            const baseLabel = param.signature ?? param.name;
            const composedLabel = actual ? `${baseLabel} = ${actual}` : baseLabel;
            const info = new vscode.ParameterInformation(composedLabel.trim());
            if (param.docMarkdown || actual) {
                const md = new vscode.MarkdownString();
                if (param.docMarkdown) {
                    md.appendMarkdown(param.docMarkdown);
                }
                if (actual) {
                    if (param.docMarkdown) { md.appendMarkdown('\n\n'); }
                    md.appendMarkdown(`**Argument:** \`${actual}\``);
                }
                info.documentation = md;
            }
            return info;
        });

        return signature;
    }

    private collectTemplateArgumentTexts(document: vscode.TextDocument, callExpression: Parser.SyntaxNode): string[] {
        const callee = this.getCalleeNode(callExpression);
        if (!callee) { return []; }
        const argsNode = this.findTemplateArgsRecursive(callee);
        if (!argsNode) { return []; }
        return argsNode.namedChildren
            .filter(child => child.type !== ',')
            .map(child => getNodeText(document, child)?.trim() ?? '');
    }

    private findTemplateArgsRecursive(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
        if (node.type === 'template_args') { return node; }
        for (const child of node.namedChildren) {
            const found = this.findTemplateArgsRecursive(child);
            if (found) { return found; }
        }
        return undefined;
    }

    // ============================================================================
    // TEMPLATE SIGNATURE HELP
    // ============================================================================

    /**
     * Finds template context when cursor is inside template arguments.
     * Detects patterns like: `FIFO<|`, `Map<string, |>`, `Array<T, |>`
     */
    private findTemplateContext(
        node: Parser.SyntaxNode | null,
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree
    ): TemplateContext | undefined {
        // First try AST-based detection
        const astContext = this.findTemplateContextFromAST(node);
        if (astContext) { return astContext; }

        // Fallback to text-based detection for incomplete parses
        return this.findTemplateContextFromText(document, position, tree);
    }

    /**
     * AST-based template context detection.
     * Walks up from current node looking for template_args or template_type.
     */
    private findTemplateContextFromAST(node: Parser.SyntaxNode | null): TemplateContext | undefined {
        let current = node;
        while (current) {
            // Check for template_args (we're inside <...>)
            if (current.type === 'template_args') {
                const parent = current.parent;
                if (parent) {
                    const baseName = this.extractTemplateBaseName(parent);
                    if (baseName) {
                        return {
                            templateNode: parent,
                            templateArgs: current,
                            baseName
                        };
                    }
                }
            }

            // Check for template_type, template_call, or template_instantiation
            if (current.type === 'template_type' || current.type === 'template_call' || current.type === 'template_instantiation') {
                const templateArgs = current.children.find(c => c.type === 'template_args');
                const baseName = this.extractTemplateBaseName(current);
                if (templateArgs && baseName) {
                    return {
                        templateNode: current,
                        templateArgs,
                        baseName
                    };
                }
            }

            current = current.parent;
        }
        return undefined;
    }

    /**
     * Text-based fallback for template context detection.
     * Scans backwards from cursor to find `identifier<` pattern.
     */
    private findTemplateContextFromText(
        document: vscode.TextDocument,
        position: vscode.Position,
        tree: Parser.Tree
    ): TemplateContext | undefined {
        const startLine = Math.max(0, position.line - 5);
        const textRange = new vscode.Range(startLine, 0, position.line, position.character);
        const text = document.getText(textRange);

        // Count angle brackets to determine if we're inside template args
        let angleDepth = 0;
        let parenDepth = 0;
        let openAngleIndex = -1;

        for (let i = text.length - 1; i >= 0; i--) {
            const ch = text[i];
            switch (ch) {
                case '>':
                    // Be careful with >> operator and comparisons
                    if (i > 0 && text[i - 1] === '>') {
                        i--; // Skip >>
                    } else if (i > 0 && text[i - 1] === '-') {
                        // Skip -> operator
                    } else {
                        angleDepth++;
                    }
                    break;
                case '<':
                    if (angleDepth === 0) {
                        openAngleIndex = i;
                    } else {
                        angleDepth--;
                    }
                    break;
                case ')': parenDepth++; break;
                case '(':
                    if (parenDepth > 0) {
                        parenDepth--;
                    } else {
                        // Hit an unmatched '(' - we're probably in function args, not template
                        return undefined;
                    }
                    break;
                case ';': case '{': case '}':
                    // Statement boundary - stop searching
                    return undefined;
            }
            if (openAngleIndex >= 0) { break; }
        }

        if (openAngleIndex < 0) { return undefined; }

        // Extract the identifier before '<'
        let identEnd = openAngleIndex;
        while (identEnd > 0 && /\s/.test(text[identEnd - 1])) {
            identEnd--;
        }

        let identStart = identEnd;
        while (identStart > 0 && /[a-zA-Z0-9_]/.test(text[identStart - 1])) {
            identStart--;
        }

        if (identStart >= identEnd) { return undefined; }

        const baseName = text.substring(identStart, identEnd);
        if (!baseName || /^\d/.test(baseName)) { return undefined; } // Skip if starts with digit

        // Calculate the position of the identifier in the document
        const identLine = startLine + text.substring(0, identStart).split('\n').length - 1;
        const lastNewline = text.lastIndexOf('\n', identStart);
        const identCol = lastNewline >= 0 ? identStart - lastNewline - 1 : identStart;

        // Find the AST node at this position
        const nodeAtIdent = tree.rootNode.descendantForPosition({
            row: identLine,
            column: identCol
        });

        // Create a synthetic context
        return {
            templateNode: nodeAtIdent ?? tree.rootNode,
            templateArgs: nodeAtIdent ?? tree.rootNode,
            baseName
        };
    }

    /**
     * Extracts the base template name from a template node.
     */
    private extractTemplateBaseName(node: Parser.SyntaxNode): string | undefined {
        // For template_type: look for identifier or type_identifier
        if (node.type === 'template_type') {
            const ident = node.children.find(c =>
                c.type === 'identifier' || c.type === 'type_identifier'
            );
            return ident?.text;
        }

        // For template_call: look for identifier
        if (node.type === 'template_call') {
            const ident = node.children.find(c => c.type === 'identifier');
            return ident?.text;
        }

        // For template_instantiation: first child is usually the identifier
        if (node.type === 'template_instantiation') {
            const ident = node.children.find(c =>
                c.type === 'identifier' || c.type === 'type_identifier'
            );
            return ident?.text;
        }

        // For member expressions with template: check the member part
        if (node.type === 'member_expression') {
            const member = node.namedChild(node.namedChildCount - 1);
            if (member) {
                return this.extractTemplateBaseName(member);
            }
        }

        // Generic: look for first identifier child
        const ident = node.children.find(c =>
            c.type === 'identifier' || c.type === 'type_identifier'
        );
        return ident?.text;
    }

    /**
     * Provides signature help specifically for template arguments.
     */
    private async provideTemplateSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        templateContext: TemplateContext
    ): Promise<vscode.SignatureHelp | undefined> {
        try {
            const { baseName } = templateContext;

            // Look up the template definition
            const symbols = this.indexer.getSymbols(baseName);
            if (!symbols || symbols.length === 0) { return undefined; }

            // Find template symbols (class, struct, function, alias with template params)
            const templateSymbols = symbols.filter(s =>
                (s.detail && s.detail.includes('template')) ||
                (s.signature && s.signature.includes('template'))
            );

            if (templateSymbols.length === 0) {
                // Try getting template parameters directly
                for (const sym of symbols) {
                    if (sym.category === 'class' || sym.category === 'struct' || sym.category === 'alias' || sym.category === 'function') {
                        const params = await this.indexer.getTemplateParametersForSymbol(sym);
                        if (params.length > 0) {
                            templateSymbols.push(sym);
                        }
                    }
                }
            }

            if (templateSymbols.length === 0) { return undefined; }

            // Use the first (best) match
            const templateSymbol = templateSymbols[0];
            const templateParams = await this.indexer.getTemplateParametersForSymbol(templateSymbol);

            if (templateParams.length === 0) { return undefined; }

            // Compute active template parameter
            const activeParam = this.computeActiveTemplateParameter(document, position);

            // Build the signature
            const signature = this.buildTemplateSignature(templateSymbol, templateParams, document, position);

            const help = new vscode.SignatureHelp();
            help.signatures = [signature];
            help.activeSignature = 0;
            help.activeParameter = Math.min(activeParam, Math.max(0, templateParams.length - 1));

            return help;
        } catch (error) {
            console.error('[SignatureHelp] Template signature error:', error);
            return undefined;
        }
    }

    /**
     * Computes which template parameter is currently being typed.
     * Counts commas from the opening '<' to the cursor position.
     */
    private computeActiveTemplateParameter(
        document: vscode.TextDocument,
        position: vscode.Position
    ): number {
        const startLine = Math.max(0, position.line - 5);
        const textRange = new vscode.Range(startLine, 0, position.line, position.character);
        const text = document.getText(textRange);

        // Find the opening '<' by scanning backwards
        let angleDepth = 0;
        let openAngleIndex = -1;

        for (let i = text.length - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '>') { angleDepth++; }
            else if (ch === '<') {
                if (angleDepth === 0) {
                    openAngleIndex = i;
                    break;
                }
                angleDepth--;
            }
        }

        if (openAngleIndex < 0) { return 0; }

        // Count commas from opening '<' to cursor, respecting nesting
        const argsText = text.substring(openAngleIndex + 1);
        let commaCount = 0;
        let parenDepth = 0;
        angleDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < argsText.length; i++) {
            const ch = argsText[i];
            const prevCh = i > 0 ? argsText[i - 1] : '';

            // Handle string literals
            if ((ch === '"' || ch === "'") && prevCh !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = ch;
                } else if (ch === stringChar) {
                    inString = false;
                }
                continue;
            }

            if (inString) { continue; }

            switch (ch) {
                case '(': parenDepth++; break;
                case ')': parenDepth--; break;
                case '<': angleDepth++; break;
                case '>': angleDepth--; break;
                case '[': bracketDepth++; break;
                case ']': bracketDepth--; break;
                case '{': braceDepth++; break;
                case '}': braceDepth--; break;
                case ',':
                    // Only count commas at the top level
                    if (parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                        commaCount++;
                    }
                    break;
            }
        }

        return commaCount;
    }

    /**
     * Builds a SignatureInformation for template parameters.
     */
    private buildTemplateSignature(
        symbol: SymbolInfo,
        templateParams: SymbolInfo[],
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.SignatureInformation {
        // Collect current argument texts for display
        const argumentTexts = this.collectCurrentTemplateArguments(document, position);

        // Build the label: "template<typename T, auto N = 32>"
        const paramLabels = templateParams.map(param => param.signature ?? param.name);
        const label = `${symbol.name}<${paramLabels.join(', ')}>`;

        // Create documentation
        let documentation: vscode.MarkdownString | undefined;
        if (symbol.docMarkdown) {
            documentation = new vscode.MarkdownString(symbol.docMarkdown);
        } else if (symbol.signature) {
            documentation = new vscode.MarkdownString();
            documentation.appendCodeblock(symbol.signature, 'kanagawa');
        }

        const signature = new vscode.SignatureInformation(label, documentation);

        // Build parameter information
        signature.parameters = templateParams.map((param, index) => {
            const paramLabel = param.signature ?? param.name;
            const actual = argumentTexts[index];

            // Create rich documentation for the parameter
            const paramDoc = new vscode.MarkdownString();

            // Show the parameter kind (type vs value)
            const kind = param.category === 'alias' || param.typeHint === 'type' ? 'type' : 'value';
            paramDoc.appendMarkdown(`**${kind}** parameter`);

            // Show constraint if any
            if (param.typeHint && param.typeHint !== 'type') {
                paramDoc.appendMarkdown(` of type \`${param.typeHint}\``);
            }

            // Show default value if any
            if (param.signature && param.signature.includes('=')) {
                const defaultMatch = param.signature.match(/=\s*(.+)$/);
                if (defaultMatch) {
                    paramDoc.appendMarkdown(`\n\nDefault: \`${defaultMatch[1].trim()}\``);
                }
            }

            // Show current argument value
            if (actual) {
                paramDoc.appendMarkdown(`\n\n**Current:** \`${actual}\``);
            }

            // Add any doc comments
            if (param.docMarkdown) {
                paramDoc.appendMarkdown('\n\n---\n\n');
                paramDoc.appendMarkdown(param.docMarkdown);
            }

            const info = new vscode.ParameterInformation(paramLabel, paramDoc);
            return info;
        });

        return signature;
    }

    /**
     * Collects current template argument texts from the document.
     */
    private collectCurrentTemplateArguments(
        document: vscode.TextDocument,
        position: vscode.Position
    ): string[] {
        const startLine = Math.max(0, position.line - 5);
        const textRange = new vscode.Range(startLine, 0, position.line, position.character);
        const text = document.getText(textRange);

        // Find the opening '<'
        let angleDepth = 0;
        let openAngleIndex = -1;

        for (let i = text.length - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '>') { angleDepth++; }
            else if (ch === '<') {
                if (angleDepth === 0) {
                    openAngleIndex = i;
                    break;
                }
                angleDepth--;
            }
        }

        if (openAngleIndex < 0) { return []; }

        // Parse arguments from '<' to cursor
        const argsText = text.substring(openAngleIndex + 1);
        return this.splitTemplateArguments(argsText);
    }

    /**
     * Splits template arguments by comma, respecting nesting.
     */
    private splitTemplateArguments(argsText: string): string[] {
        const args: string[] = [];
        let current = '';
        let parenDepth = 0;
        let angleDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < argsText.length; i++) {
            const ch = argsText[i];
            const prevCh = i > 0 ? argsText[i - 1] : '';

            // Handle string literals
            if ((ch === '"' || ch === "'") && prevCh !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = ch;
                } else if (ch === stringChar) {
                    inString = false;
                }
                current += ch;
                continue;
            }

            if (inString) {
                current += ch;
                continue;
            }

            switch (ch) {
                case '(':
                    parenDepth++;
                    current += ch;
                    break;
                case ')':
                    parenDepth--;
                    current += ch;
                    break;
                case '<':
                    angleDepth++;
                    current += ch;
                    break;
                case '>':
                    if (angleDepth > 0) {
                        angleDepth--;
                        current += ch;
                    }
                    // Don't add closing '>' at depth 0 - it ends the template args
                    break;
                case '[':
                    bracketDepth++;
                    current += ch;
                    break;
                case ']':
                    bracketDepth--;
                    current += ch;
                    break;
                case '{':
                    braceDepth++;
                    current += ch;
                    break;
                case '}':
                    braceDepth--;
                    current += ch;
                    break;
                case ',':
                    if (parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                        args.push(current.trim());
                        current = '';
                    } else {
                        current += ch;
                    }
                    break;
                default:
                    current += ch;
                    break;
            }
        }

        // Add the last argument (what user is currently typing)
        if (current.trim()) {
            args.push(current.trim());
        }

        return args;
    }
}
