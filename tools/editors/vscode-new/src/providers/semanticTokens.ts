import * as vscode from 'vscode';
import { TreeSitterService } from '../service/treeSitter';
import { QueryManager } from '../service/query';

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
    constructor(
        private service: TreeSitterService,
        private queryManager: QueryManager
    ) {}

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens | undefined> {
        const tree = this.service.getTree(document);
        if (!tree) { return undefined; }

        const builder = new vscode.SemanticTokensBuilder(legend);
        
        let queryString = this.queryManager.getQuery('highlights');
        if (!queryString) {
            queryString = await this.queryManager.loadQuery('highlights');
        }

        const captures = this.service.query(tree.rootNode, queryString);

        for (const capture of captures) {
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
                builder.push(
                    new vscode.Range(
                        new vscode.Position(node.startPosition.row, node.startPosition.column),
                        new vscode.Position(node.endPosition.row, node.endPosition.column)
                    ),
                    type,
                    modifiers
                );
            }
        }

        return builder.build();
    }
}
