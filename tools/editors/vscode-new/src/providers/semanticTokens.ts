import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { TreeSitterService } from '../service/treeSitter';
import { QueryManager } from '../service/query';
import { perfLogger, PerfOps } from '../utils/perfLogger';
import { healthMonitor } from '../service/healthMonitor';

const TOKEN_TYPES = [
    'namespace',
    'class',
    'enum',
    'interface',
    'struct',
    'typeParameter',
    'type',
    'parameter',
    'variable',
    'property',
    'enumMember',
    'function',
    'method',
    'macro',
    'keyword',
    'modifier',
    'comment',
    'string',
    'number',
    'regexp',
    'operator',
];

const TOKEN_MODIFIERS = [
    'declaration',
    'definition',
    'readonly',
    'static',
    'deprecated',
    'abstract',
    'async',
    'modification',
    'documentation',
    'defaultLibrary',
];

export const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

export class KanagawaSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    /**
     * Event emitter to signal VS Code that semantic tokens have changed.
     * This allows us to trigger a refresh after parsing completes.
     */
    private readonly _onDidChangeSemanticTokens = new vscode.EventEmitter<void>();
    public readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager
    ) {}

    /**
     * Call this after parsing completes to trigger a semantic token refresh.
     * This ensures VS Code re-requests tokens with the latest parse tree.
     */
    public notifyTokensChanged(): void {
        this._onDidChangeSemanticTokens.fire();
    }

    /**
     * Dispose of resources.
     */
    public dispose(): void {
        this._onDidChangeSemanticTokens.dispose();
    }

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens | undefined> {
        const endTiming = perfLogger.start(PerfOps.SEMANTIC_TOKENS, document.uri.toString());
        try {
            // Check if service is ready before proceeding
            if (!this.service.isReady()) {
                console.warn('Kanagawa: Semantic tokens requested but parser not ready');
                return undefined;
            }

            // Get existing tree or parse the document (parse is now async)
            const tree = this.service.getTree(document) ?? await this.service.parse(document);
            if (!tree) { return undefined; }

            if (token.isCancellationRequested) { return undefined; }

            const builder = new vscode.SemanticTokensBuilder(legend);
        
            let queryString = this.queryManager.getQuery('highlights');
            if (!queryString) {
                queryString = await this.queryManager.loadQuery('highlights');
            }

            if (token.isCancellationRequested) { return undefined; }

            // If no query string available, return empty tokens rather than crashing
            if (!queryString) {
                console.warn('Kanagawa: No highlights query available');
                return builder.build();
            }

            const captures = this.service.query(tree.rootNode, queryString);

            for (const capture of captures) {
                if (token.isCancellationRequested) { return undefined; }
            
                const node = capture.node;
                let type: string | undefined;
                let modifiers: string[] = [];
            
                switch (capture.name) {
                    case 'keyword':
                        type = 'keyword';
                        break;
                    
                    case 'function.definition':
                        type = 'function';
                        modifiers = ['definition'];
                        break;
                    
                    case 'function.call':
                        type = 'function';
                        break;
                    
                    case 'function.builtin':
                        type = 'function';
                        modifiers = ['defaultLibrary'];
                        break;
                    
                    case 'type.definition':
                        type = 'class';
                        modifiers = ['definition'];
                        break;
                    
                    case 'type':
                        type = 'type';
                        break;
                    
                    case 'type.parameter':
                        type = 'typeParameter';
                        break;
                    
                    case 'variable.definition':
                        type = 'variable';
                        modifiers = ['definition'];
                        break;
                    
                    case 'variable':
                        type = 'variable';
                        break;
                    
                    case 'parameter':
                        type = 'parameter';
                        break;
                    
                    case 'property':
                        type = 'property';
                        break;
                    
                    case 'constant':
                        type = 'enumMember';
                        modifiers = ['readonly'];
                        break;
                    
                    case 'namespace':
                        type = 'namespace';
                        break;
                    
                    case 'attribute':
                        type = 'macro';
                        break;
                    
                    case 'comment':
                        type = 'comment';
                        break;
                    
                    case 'string':
                    case 'string.escape':
                        type = 'string';
                        break;
                    
                    case 'number':
                        type = 'number';
                        break;
                    
                    case 'boolean':
                        type = 'keyword';
                        break;
                    
                    case 'operator':
                        type = 'operator';
                        break;
                    
                    default:
                        // Skip unknown captures
                        continue;
                }

                if (type) {
                    // VS Code requires semantic tokens to be single-line.
                    // Split multi-line tokens into per-line tokens.
                    try {
                        this.pushToken(builder, document, node, type, modifiers);
                    } catch (pushError) {
                        // Log but don't fail the entire provider on individual token errors
                        console.warn('Kanagawa: Failed to push semantic token:', pushError);
                    }
                }
            }

            // Record success for health monitoring
            healthMonitor.recordSuccess('semantic_tokens');
            return builder.build();
        } catch (error) {
            // Comprehensive error handling to prevent provider crashes
            console.error('Kanagawa: Semantic tokens provider error:', error);
            healthMonitor.recordFailure('semantic_tokens', 
                error instanceof Error ? error.message : String(error));
            return undefined;
        } finally {
            endTiming();
        }
    }

    /**
     * Pushes a semantic token, handling multi-line nodes by splitting them
     * into individual single-line tokens (VS Code API requirement).
     */
    private pushToken(
        builder: vscode.SemanticTokensBuilder,
        document: vscode.TextDocument,
        node: Parser.SyntaxNode,
        type: string,
        modifiers: string[]
    ): void {
        const startLine = node.startPosition.row;
        const endLine = node.endPosition.row;

        if (startLine === endLine) {
            // Single-line token - push directly
            builder.push(
                startLine,
                node.startPosition.column,
                node.endPosition.column - node.startPosition.column,
                TOKEN_TYPES.indexOf(type),
                this.encodeModifiers(modifiers)
            );
        } else {
            // Multi-line token - split into per-line tokens
            for (let line = startLine; line <= endLine; line++) {
                const lineText = document.lineAt(line).text;
                let startCol: number;
                let length: number;

                if (line === startLine) {
                    // First line: from start column to end of line
                    startCol = node.startPosition.column;
                    length = lineText.length - startCol;
                } else if (line === endLine) {
                    // Last line: from start of line to end column
                    startCol = 0;
                    length = node.endPosition.column;
                } else {
                    // Middle lines: entire line
                    startCol = 0;
                    length = lineText.length;
                }

                // Skip empty tokens
                if (length > 0) {
                    builder.push(
                        line,
                        startCol,
                        length,
                        TOKEN_TYPES.indexOf(type),
                        this.encodeModifiers(modifiers)
                    );
                }
            }
        }
    }

    /**
     * Encodes modifier strings into a bitmask.
     */
    private encodeModifiers(modifiers: string[]): number {
        let result = 0;
        for (const modifier of modifiers) {
            const index = TOKEN_MODIFIERS.indexOf(modifier);
            if (index >= 0) {
                result |= (1 << index);
            }
        }
        return result;
    }
}
