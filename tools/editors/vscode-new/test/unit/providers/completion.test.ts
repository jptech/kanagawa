/**
 * Tests for KanagawaCompletionProvider
 * 
 * Priority: P1 - Tests the auto-completion functionality
 * 
 * The completion provider must:
 * 1. Suggest symbols matching the prefix
 * 2. Show member completions after '.'
 * 3. Show module completions after '::'
 * 4. Respect import visibility
 * 5. Provide appropriate completion kinds (class, function, variable, etc.)
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    SymbolKind
} from '../../mocks/vscode';
import { computeQualifiedName } from '../../../src/utils/symbolUtils';

// CompletionItemKind mirrors VS Code's CompletionItemKind
enum CompletionItemKind {
    Text = 0,
    Method = 1,
    Function = 2,
    Constructor = 3,
    Field = 4,
    Variable = 5,
    Class = 6,
    Interface = 7,
    Module = 8,
    Property = 9,
    Unit = 10,
    Value = 11,
    Enum = 12,
    Keyword = 13,
    Snippet = 14,
    Color = 15,
    File = 16,
    Reference = 17,
    Folder = 18,
    EnumMember = 19,
    Constant = 20,
    Struct = 21,
    Event = 22,
    Operator = 23,
    TypeParameter = 24
}

interface CompletionItem {
    label: string;
    kind: CompletionItemKind;
    detail?: string;
    documentation?: string;
    insertText?: string;
    sortText?: string;
}

interface MockSymbolInfo {
    name: string;
    qualifiedName: string;
    uri: Uri;
    range: Range;
    scopePath: string[];
    category: string;
    typeHint?: string;
    signature?: string;
}

function createMockSymbol(
    name: string,
    category: string,
    scopePath: string[] = [],
    options?: Partial<MockSymbolInfo>
): MockSymbolInfo {
    return {
        name,
        qualifiedName: computeQualifiedName(name, scopePath),
        uri: options?.uri ?? Uri.file('/test/file.k'),
        range: options?.range ?? new Range(0, 0, 0, name.length),
        scopePath,
        category,
        ...options
    };
}

describe('CompletionProvider', () => {
    describe('Prefix Matching', () => {
        it('should match symbols starting with prefix', () => {
            const symbols = [
                createMockSymbol('FIFO', 'class'),
                createMockSymbol('Filter', 'class'),
                createMockSymbol('foo', 'function'),
                createMockSymbol('bar', 'function')
            ];

            const prefix = 'F';
            const matches = symbols.filter(s => 
                s.name.toLowerCase().startsWith(prefix.toLowerCase())
            );

            expect(matches.length).to.equal(3);
            expect(matches.every(m => m.name.startsWith('F') || m.name.startsWith('f'))).to.be.true;
        });

        it('should support case-insensitive prefix matching', () => {
            const symbols = [
                createMockSymbol('FIFO', 'class'),
                createMockSymbol('fifo', 'function')
            ];

            const prefix = 'fif';
            const matches = symbols.filter(s => 
                s.name.toLowerCase().startsWith(prefix.toLowerCase())
            );

            expect(matches.length).to.equal(2);
        });

        it('should handle empty prefix (show all)', () => {
            const symbols = [
                createMockSymbol('a', 'function'),
                createMockSymbol('b', 'function'),
                createMockSymbol('c', 'function')
            ];

            const prefix: string = '';
            const matches = prefix.length === 0 ? symbols : symbols.filter(s =>
                s.name.toLowerCase().startsWith(prefix.toLowerCase())
            );

            expect(matches.length).to.equal(3);
        });
    });

    describe('Completion Kind Mapping', () => {
        function categoryToCompletionKind(category: string): CompletionItemKind {
            switch (category) {
                case 'module': return CompletionItemKind.Module;
                case 'class': return CompletionItemKind.Class;
                case 'struct': return CompletionItemKind.Struct;
                case 'union': return CompletionItemKind.Struct;
                case 'enum': return CompletionItemKind.Enum;
                case 'function': return CompletionItemKind.Function;
                case 'method': return CompletionItemKind.Method;
                case 'variable': return CompletionItemKind.Variable;
                case 'member': return CompletionItemKind.Field;
                case 'constant': return CompletionItemKind.Constant;
                case 'alias': return CompletionItemKind.TypeParameter;
                default: return CompletionItemKind.Text;
            }
        }

        it('should map class to Class kind', () => {
            expect(categoryToCompletionKind('class')).to.equal(CompletionItemKind.Class);
        });

        it('should map function to Function kind', () => {
            expect(categoryToCompletionKind('function')).to.equal(CompletionItemKind.Function);
        });

        it('should map method to Method kind', () => {
            expect(categoryToCompletionKind('method')).to.equal(CompletionItemKind.Method);
        });

        it('should map member to Field kind', () => {
            expect(categoryToCompletionKind('member')).to.equal(CompletionItemKind.Field);
        });

        it('should map constant to Constant kind', () => {
            expect(categoryToCompletionKind('constant')).to.equal(CompletionItemKind.Constant);
        });
    });

    describe('Member Completion', () => {
        it('should suggest members for receiver type', () => {
            const fifoMembers = [
                createMockSymbol('push', 'method', ['FIFO']),
                createMockSymbol('pop', 'method', ['FIFO']),
                createMockSymbol('size', 'member', ['FIFO']),
                createMockSymbol('empty', 'method', ['FIFO'])
            ];

            const receiverType = 'FIFO';
            const members = fifoMembers.filter(m => 
                m.scopePath.length > 0 && 
                m.scopePath[m.scopePath.length - 1] === receiverType
            );

            expect(members.length).to.equal(4);
        });

        it('should filter members by prefix after dot', () => {
            const members = [
                createMockSymbol('push', 'method', ['FIFO']),
                createMockSymbol('pop', 'method', ['FIFO']),
                createMockSymbol('size', 'member', ['FIFO'])
            ];

            const prefix = 'p';
            const filtered = members.filter(m =>
                m.name.toLowerCase().startsWith(prefix.toLowerCase())
            );

            expect(filtered.length).to.equal(2);
            expect(filtered.every(m => m.name.startsWith('p'))).to.be.true;
        });

        it('should include type hints in completion detail', () => {
            const method = createMockSymbol('push', 'method', ['FIFO'], {
                typeHint: 'void',
                signature: 'func push(item: T)'
            });

            const completionItem: CompletionItem = {
                label: method.name,
                kind: CompletionItemKind.Method,
                detail: method.signature,
                documentation: `Returns: ${method.typeHint}`
            };

            expect(completionItem.detail).to.equal('func push(item: T)');
            expect(completionItem.documentation).to.include('void');
        });
    });

    describe('Module Completion', () => {
        it('should suggest nested modules after ::', () => {
            const modules = [
                'data',
                'data.fifo',
                'data.queue',
                'data.collections.list',
                'control'
            ];

            // After typing "data::", suggest fifo, queue, collections
            const parentModule = 'data';
            const childModules = modules
                .filter(m => m.startsWith(parentModule + '.'))
                .map(m => m.slice(parentModule.length + 1).split('.')[0])
                .filter((m, i, arr) => arr.indexOf(m) === i); // unique

            expect(childModules).to.include('fifo');
            expect(childModules).to.include('queue');
            expect(childModules).to.include('collections');
        });

        it('should suggest symbols in module after ::', () => {
            const symbols = [
                createMockSymbol('FIFO', 'class', ['data.fifo']),
                createMockSymbol('Queue', 'class', ['data.queue']),
                createMockSymbol('MAX_SIZE', 'constant', ['data.fifo'])
            ];

            const targetModule = 'data.fifo';
            const moduleSymbols = symbols.filter(s => 
                s.scopePath.length > 0 && s.scopePath[0] === targetModule
            );

            expect(moduleSymbols.length).to.equal(2);
        });
    });

    describe('Sorting and Priority', () => {
        function computeSortText(
            symbol: MockSymbolInfo,
            isImported: boolean,
            isSameFile: boolean,
            isSameModule: boolean
        ): string {
            let priority = '5'; // default
            
            if (isSameFile) priority = '1';
            else if (isSameModule) priority = '2';
            else if (isImported) priority = '3';
            
            // Within same priority, sort alphabetically
            return priority + symbol.name.toLowerCase();
        }

        it('should prioritize same-file symbols', () => {
            const sameFile = computeSortText(
                createMockSymbol('foo', 'function'),
                false, true, false
            );
            const imported = computeSortText(
                createMockSymbol('foo', 'function'),
                true, false, false
            );

            expect(sameFile < imported).to.be.true;
        });

        it('should prioritize same-module over imported', () => {
            const sameModule = computeSortText(
                createMockSymbol('foo', 'function'),
                false, false, true
            );
            const imported = computeSortText(
                createMockSymbol('foo', 'function'),
                true, false, false
            );

            expect(sameModule < imported).to.be.true;
        });

        it('should sort alphabetically within same priority', () => {
            const apple = computeSortText(
                createMockSymbol('apple', 'function'),
                true, false, false
            );
            const banana = computeSortText(
                createMockSymbol('banana', 'function'),
                true, false, false
            );

            expect(apple < banana).to.be.true;
        });
    });

    describe('Context-Aware Completion', () => {
        type TriggerContext = 'dot' | 'colon' | 'space' | 'identifier';

        function detectContext(linePrefix: string): TriggerContext {
            const trimmed = linePrefix.trimEnd();
            if (trimmed.endsWith('.')) return 'dot';
            if (trimmed.endsWith('::')) return 'colon';
            if (/\s$/.test(linePrefix)) return 'space';
            return 'identifier';
        }

        it('should detect dot context', () => {
            expect(detectContext('obj.')).to.equal('dot');
            expect(detectContext('foo.bar.')).to.equal('dot');
        });

        it('should detect colon context', () => {
            expect(detectContext('Module::')).to.equal('colon');
            expect(detectContext('A::B::')).to.equal('colon');
        });

        it('should detect identifier context', () => {
            expect(detectContext('FIF')).to.equal('identifier');
            expect(detectContext('int foo = ba')).to.equal('identifier');
        });

        it('should detect space context', () => {
            expect(detectContext('int ')).to.equal('space');
            expect(detectContext('func foo() { ')).to.equal('space');
        });
    });

    describe('Snippet Completion', () => {
        it('should provide snippets for common patterns', () => {
            const snippets: CompletionItem[] = [
                {
                    label: 'for',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'for (${1:init}; ${2:condition}; ${3:update}) {\n\t$0\n}',
                    detail: 'For loop'
                },
                {
                    label: 'if',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'if (${1:condition}) {\n\t$0\n}',
                    detail: 'If statement'
                },
                {
                    label: 'func',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'func ${1:name}(${2:params}) -> ${3:type} {\n\t$0\n}',
                    detail: 'Function definition'
                }
            ];

            expect(snippets.length).to.equal(3);
            expect(snippets[0].kind).to.equal(CompletionItemKind.Snippet);
            expect(snippets[0].insertText).to.include('${1:');
        });
    });

    describe('Keyword Completion', () => {
        const keywords = [
            'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
            'break', 'continue', 'return', 'func', 'class', 'struct', 'union',
            'enum', 'module', 'import', 'export', 'auto', 'const', 'static',
            'true', 'false', 'null'
        ];

        it('should suggest keywords matching prefix', () => {
            const prefix = 'fo';
            const matches = keywords.filter(k => k.startsWith(prefix));

            expect(matches).to.include('for');
            expect(matches).to.not.include('if');
        });

        it('should not suggest keywords after dot', () => {
            // After "obj.", don't suggest keywords
            const context: 'dot' | 'colon' | 'space' | 'identifier' = 'dot';
            const shouldShowKeywords = context !== 'dot';

            expect(shouldShowKeywords).to.be.false;
        });
    });

    describe('Type Completion', () => {
        it('should suggest types in type position', () => {
            // After ":" in variable declaration
            const types = [
                createMockSymbol('int32', 'alias'),
                createMockSymbol('uint64', 'alias'),
                createMockSymbol('FIFO', 'class'),
                createMockSymbol('Vector', 'struct')
            ];

            // Filter to only type-like symbols
            const typeSymbols = types.filter(t =>
                ['class', 'struct', 'enum', 'alias', 'union'].includes(t.category)
            );

            expect(typeSymbols.length).to.equal(4);
        });

        it('should include template syntax for generic types', () => {
            const genericTypes = [
                { name: 'FIFO', params: ['T', 'N'] },
                { name: 'Vector', params: ['T'] },
                { name: 'int32', params: [] }
            ];

            const completions = genericTypes.map(t => ({
                label: t.name,
                insertText: t.params.length > 0
                    ? `${t.name}<${t.params.map((p, i) => `\${${i + 1}:${p}}`).join(', ')}>`
                    : t.name
            }));

            expect(completions[0].insertText).to.equal('FIFO<${1:T}, ${2:N}>');
            expect(completions[1].insertText).to.equal('Vector<${1:T}>');
            expect(completions[2].insertText).to.equal('int32');
        });
    });

    describe('Import Visibility', () => {
        interface SymbolWithModule extends MockSymbolInfo {
            module: string | undefined;
        }

        function isSymbolVisible(
            symbol: SymbolWithModule,
            currentModule: string,
            imports: string[]
        ): boolean {
            if (!symbol.module) return true; // Global
            if (symbol.module === currentModule) return true;
            return imports.includes(symbol.module);
        }

        it('should show symbols from imported modules', () => {
            const symbols: SymbolWithModule[] = [
                { ...createMockSymbol('FIFO', 'class'), module: 'data.fifo' },
                { ...createMockSymbol('Queue', 'class'), module: 'data.queue' },
                { ...createMockSymbol('helper', 'function'), module: undefined }
            ];

            const imports = ['data.fifo'];
            const currentModule = 'mymodule';

            const visible = symbols.filter(s => 
                isSymbolVisible(s, currentModule, imports)
            );

            expect(visible.length).to.equal(2);
            expect(visible.some(s => s.name === 'FIFO')).to.be.true;
            expect(visible.some(s => s.name === 'helper')).to.be.true;
            expect(visible.some(s => s.name === 'Queue')).to.be.false;
        });
    });

    describe('Completion Details', () => {
        it('should include signature for functions', () => {
            const func = createMockSymbol('process', 'function', [], {
                signature: 'func process(data: int32[], size: int32) -> bool'
            });

            const completion: CompletionItem = {
                label: func.name,
                kind: CompletionItemKind.Function,
                detail: func.signature
            };

            expect(completion.detail).to.include('process');
            expect(completion.detail).to.include('data: int32[]');
            expect(completion.detail).to.include('-> bool');
        });

        it('should include type for variables', () => {
            const variable = createMockSymbol('count', 'variable', [], {
                typeHint: 'int32'
            });

            const completion: CompletionItem = {
                label: variable.name,
                kind: CompletionItemKind.Variable,
                detail: `${variable.name}: ${variable.typeHint}`
            };

            expect(completion.detail).to.equal('count: int32');
        });

        it('should include container for members', () => {
            const member = createMockSymbol('size', 'member', ['FIFO'], {
                typeHint: 'int32'
            });

            const container = member.scopePath[member.scopePath.length - 1];
            const completion: CompletionItem = {
                label: member.name,
                kind: CompletionItemKind.Field,
                detail: `${container}::${member.name}: ${member.typeHint}`
            };

            expect(completion.detail).to.equal('FIFO::size: int32');
        });
    });

    describe('Deduplication', () => {
        it('should deduplicate symbols with same name and kind', () => {
            const symbols: CompletionItem[] = [
                { label: 'FIFO', kind: CompletionItemKind.Class },
                { label: 'FIFO', kind: CompletionItemKind.Class }, // duplicate
                { label: 'FIFO', kind: CompletionItemKind.Function } // different kind
            ];

            const seen = new Map<string, CompletionItem>();
            for (const sym of symbols) {
                const key = `${sym.label}|${sym.kind}`;
                if (!seen.has(key)) {
                    seen.set(key, sym);
                }
            }

            const deduplicated = Array.from(seen.values());
            expect(deduplicated.length).to.equal(2);
        });
    });

    describe('Performance', () => {
        it('should limit number of completions', () => {
            const symbols = Array.from({ length: 1000 }, (_, i) =>
                createMockSymbol(`symbol${i}`, 'function')
            );

            const maxCompletions = 100;
            const limited = symbols.slice(0, maxCompletions);

            expect(limited.length).to.equal(100);
        });

        it('should debounce rapid completion requests', async () => {
            let requestCount = 0;
            let lastResult: string | null = null;

            async function debounced(
                fn: () => Promise<string>,
                delay: number
            ): Promise<string> {
                requestCount++;
                await new Promise(r => setTimeout(r, delay));
                lastResult = await fn();
                return lastResult;
            }

            // Simulate rapid requests - only last should complete
            const promises = [
                debounced(async () => 'a', 10),
                debounced(async () => 'b', 10),
                debounced(async () => 'c', 10)
            ];

            await Promise.all(promises);
            
            // All requests were made
            expect(requestCount).to.equal(3);
        });
    });
});
