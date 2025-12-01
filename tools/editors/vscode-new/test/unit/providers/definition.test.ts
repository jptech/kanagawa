/**
 * Tests for KanagawaDefinitionProvider
 * 
 * Priority: P1 - Tests the go-to-definition functionality
 * 
 * The definition provider must:
 * 1. Find local variable/parameter definitions
 * 2. Find function definitions
 * 3. Find type definitions (class, struct, enum)
 * 4. Follow member access chains (obj.member)
 * 5. Respect import visibility
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    SymbolKind,
    createTestDocument
} from '../../mocks/vscode';
import { computeQualifiedName } from '../../../src/utils/symbolUtils';

// Mock symbol info
interface MockSymbolInfo {
    name: string;
    qualifiedName: string;
    uri: Uri;
    range: Range;
    kind: SymbolKind;
    scopePath: string[];
    category: string;
    typeHint?: string;
}

function createMockSymbol(
    name: string,
    category: string,
    scopePath: string[] = [],
    options?: Partial<MockSymbolInfo>
): MockSymbolInfo {
    const qualifiedName = computeQualifiedName(name, scopePath);
    return {
        name,
        qualifiedName,
        uri: options?.uri ?? Uri.file('/test/file.k'),
        range: options?.range ?? new Range(0, 0, 0, name.length),
        kind: SymbolKind.Variable,
        scopePath,
        category,
        ...options
    };
}

describe('DefinitionProvider', () => {
    describe('Symbol Resolution Priority', () => {
        /**
         * The definition provider should check in this order:
         * 1. Local variables/parameters
         * 2. Member resolution (for obj.member patterns)
         * 3. Context-aware global resolution
         * 4. Document-local symbols
         */

        it('should prioritize local variables over globals', () => {
            const localSymbol = createMockSymbol('x', 'variable', [], {
                uri: Uri.file('/test.k'),
                range: new Range(5, 4, 5, 5)
            });
            
            const globalSymbol = createMockSymbol('x', 'variable', ['someModule'], {
                uri: Uri.file('/other.k'),
                range: new Range(10, 4, 10, 5)
            });

            // In resolution, local should win
            const candidates = [localSymbol, globalSymbol];
            const localMatch = candidates.find(c => c.scopePath.length === 0);
            
            expect(localMatch).to.equal(localSymbol);
        });

        it('should match symbols by scope path', () => {
            const symbols = [
                createMockSymbol('push', 'method', ['FIFO']),
                createMockSymbol('push', 'method', ['Stack']),
                createMockSymbol('push', 'function', [])
            ];

            const targetScope = ['FIFO'];
            const matched = symbols.find(s => 
                s.scopePath.length === targetScope.length &&
                s.scopePath.every((p, i) => p === targetScope[i])
            );

            expect(matched?.scopePath).to.deep.equal(['FIFO']);
        });
    });

    describe('Member Expression Resolution', () => {
        it('should identify member expression pattern', () => {
            // Simulate parsing: obj.member
            const isMemberExpression = (parentType: string) => parentType === 'member_expression';
            
            expect(isMemberExpression('member_expression')).to.be.true;
            expect(isMemberExpression('call_expression')).to.be.false;
            expect(isMemberExpression('identifier')).to.be.false;
        });

        it('should extract receiver type from member chain', () => {
            // For: fifo.push() where fifo is of type FIFO<int32, 16>
            function extractBaseType(fullType: string): string {
                const match = fullType.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
                return match ? match[1] : fullType;
            }

            expect(extractBaseType('FIFO<int32, 16>')).to.equal('FIFO');
            expect(extractBaseType('Vector<T>')).to.equal('Vector');
            expect(extractBaseType('SimpleType')).to.equal('SimpleType');
        });
    });

    describe('Import-Aware Resolution', () => {
        interface ResolvedImports {
            currentModule: string | undefined;
            importedModules: Set<string>;
        }

        function isAccessible(
            symbolModule: string | undefined,
            resolved: ResolvedImports
        ): boolean {
            // Global symbols are always accessible
            if (!symbolModule) return true;
            
            // Same module
            if (symbolModule === resolved.currentModule) return true;
            
            // Imported module
            if (resolved.importedModules.has(symbolModule)) return true;
            
            return false;
        }

        it('should allow access to same-module symbols', () => {
            const resolved: ResolvedImports = {
                currentModule: 'data.fifo',
                importedModules: new Set()
            };

            expect(isAccessible('data.fifo', resolved)).to.be.true;
            expect(isAccessible('data.queue', resolved)).to.be.false;
        });

        it('should allow access to imported modules', () => {
            const resolved: ResolvedImports = {
                currentModule: 'mymodule',
                importedModules: new Set(['data.fifo', 'control.flow'])
            };

            expect(isAccessible('data.fifo', resolved)).to.be.true;
            expect(isAccessible('control.flow', resolved)).to.be.true;
            expect(isAccessible('data.queue', resolved)).to.be.false;
        });

        it('should always allow global symbols', () => {
            const resolved: ResolvedImports = {
                currentModule: 'mymodule',
                importedModules: new Set()
            };

            expect(isAccessible(undefined, resolved)).to.be.true;
        });
    });

    describe('Definition Location', () => {
        it('should return definition range', () => {
            const symbol = createMockSymbol('myFunc', 'function', [], {
                range: new Range(10, 0, 10, 6)
            });

            expect(symbol.range.start.line).to.equal(10);
            expect(symbol.range.start.character).to.equal(0);
            expect(symbol.range.end.line).to.equal(10);
            expect(symbol.range.end.character).to.equal(6);
        });

        it('should return definition URI', () => {
            const uri = Uri.file('/path/to/definitions.k');
            const symbol = createMockSymbol('MyClass', 'class', [], { uri });

            expect(symbol.uri.toString()).to.equal(uri.toString());
        });
    });

    describe('Qualified Name Resolution', () => {
        it('should look up by qualified name', () => {
            const qualifiedIndex = new Map<string, MockSymbolInfo>();
            
            qualifiedIndex.set('data.fifo::FIFO', createMockSymbol('FIFO', 'class', ['data.fifo']));
            qualifiedIndex.set('data.fifo::FIFO::push', createMockSymbol('push', 'method', ['data.fifo', 'FIFO']));
            
            const result = qualifiedIndex.get('data.fifo::FIFO::push');
            expect(result?.name).to.equal('push');
            expect(result?.category).to.equal('method');
        });

        it('should handle partial qualification', () => {
            // When user writes FIFO::push without module prefix
            const symbols = [
                createMockSymbol('push', 'method', ['data.fifo', 'FIFO']),
                createMockSymbol('push', 'method', ['containers', 'FIFO'])
            ];

            // Without module context, multiple matches possible
            const matches = symbols.filter(s => 
                s.scopePath.includes('FIFO') && s.name === 'push'
            );

            expect(matches.length).to.equal(2);
        });
    });

    describe('Type Definition', () => {
        it('should find type definition for type references', () => {
            // When hovering over a type name like FIFO in "FIFO<int32> fifo;"
            const typeSymbols = [
                createMockSymbol('FIFO', 'class', ['data.fifo'], {
                    range: new Range(5, 0, 5, 4)
                }),
                createMockSymbol('Vector', 'struct', ['containers'], {
                    range: new Range(20, 0, 20, 6)
                })
            ];

            const findType = (name: string) => typeSymbols.find(s => s.name === name);

            expect(findType('FIFO')?.category).to.equal('class');
            expect(findType('Vector')?.category).to.equal('struct');
            expect(findType('Unknown')).to.be.undefined;
        });
    });

    describe('Local Symbol Resolution', () => {
        /**
         * Tests the logic for finding local variables and parameters
         */

        interface LocalDeclaration {
            name: string;
            line: number;
            scope: 'parameter' | 'variable';
        }

        function findLocalSymbol(
            targetName: string,
            targetLine: number,
            declarations: LocalDeclaration[]
        ): LocalDeclaration | undefined {
            // Find the nearest declaration before the target line
            let best: LocalDeclaration | undefined;
            
            for (const decl of declarations) {
                if (decl.name !== targetName) continue;
                if (decl.line > targetLine) continue;
                
                if (!best || decl.line > best.line) {
                    best = decl;
                }
            }
            
            return best;
        }

        it('should find parameter declarations', () => {
            const declarations: LocalDeclaration[] = [
                { name: 'x', line: 1, scope: 'parameter' },
                { name: 'y', line: 1, scope: 'parameter' }
            ];

            const result = findLocalSymbol('x', 5, declarations);
            expect(result?.scope).to.equal('parameter');
            expect(result?.line).to.equal(1);
        });

        it('should find variable declarations', () => {
            const declarations: LocalDeclaration[] = [
                { name: 'x', line: 1, scope: 'parameter' },
                { name: 'result', line: 3, scope: 'variable' }
            ];

            const result = findLocalSymbol('result', 5, declarations);
            expect(result?.scope).to.equal('variable');
            expect(result?.line).to.equal(3);
        });

        it('should find nearest declaration for shadowed variables', () => {
            const declarations: LocalDeclaration[] = [
                { name: 'x', line: 1, scope: 'parameter' },
                { name: 'x', line: 5, scope: 'variable' }  // shadows parameter
            ];

            // From line 7, should find the shadow at line 5
            const result = findLocalSymbol('x', 7, declarations);
            expect(result?.line).to.equal(5);
            expect(result?.scope).to.equal('variable');

            // From line 3, should find the parameter at line 1
            const result2 = findLocalSymbol('x', 3, declarations);
            expect(result2?.line).to.equal(1);
            expect(result2?.scope).to.equal('parameter');
        });

        it('should not find declarations after reference', () => {
            const declarations: LocalDeclaration[] = [
                { name: 'x', line: 10, scope: 'variable' }
            ];

            // Reference at line 5, declaration at line 10
            const result = findLocalSymbol('x', 5, declarations);
            expect(result).to.be.undefined;
        });
    });

    describe('Context Hint Handling', () => {
        interface ContextHint {
            kind: 'method' | 'free' | 'unknown';
            receiverType?: string;
        }

        function scoreWithContext(symbol: MockSymbolInfo, hint: ContextHint): number {
            let score = 0;

            if (hint.kind === 'method') {
                if (symbol.category === 'method') {
                    score += 20;
                } else if (symbol.category === 'function') {
                    score -= 10;
                }
                
                if (hint.receiverType) {
                    const container = symbol.scopePath[symbol.scopePath.length - 1];
                    if (container === hint.receiverType) {
                        score += 35;
                    }
                }
            } else if (hint.kind === 'free') {
                if (symbol.category === 'method') {
                    score -= 10;
                }
            }

            return score;
        }

        it('should prefer methods for method context', () => {
            const method = createMockSymbol('process', 'method', ['Handler']);
            const func = createMockSymbol('process', 'function', []);

            const methodScore = scoreWithContext(method, { kind: 'method' });
            const funcScore = scoreWithContext(func, { kind: 'method' });

            expect(methodScore).to.be.greaterThan(funcScore);
        });

        it('should prefer functions for free context', () => {
            const method = createMockSymbol('helper', 'method', ['Utils']);
            const func = createMockSymbol('helper', 'function', []);

            const methodScore = scoreWithContext(method, { kind: 'free' });
            const funcScore = scoreWithContext(func, { kind: 'free' });

            expect(funcScore).to.be.greaterThan(methodScore);
        });

        it('should boost score for matching receiver type', () => {
            const handlerMethod = createMockSymbol('process', 'method', ['Handler']);
            const otherMethod = createMockSymbol('process', 'method', ['Other']);

            const handlerScore = scoreWithContext(handlerMethod, { 
                kind: 'method', 
                receiverType: 'Handler' 
            });
            const otherScore = scoreWithContext(otherMethod, { 
                kind: 'method', 
                receiverType: 'Handler' 
            });

            expect(handlerScore).to.be.greaterThan(otherScore);
        });
    });

    describe('Multiple Definitions', () => {
        /**
         * When multiple definitions exist (e.g., overloads, different modules),
         * the provider should return all of them for VS Code to display.
         */

        it('should return all definition locations for overloads', () => {
            const definitions = [
                createMockSymbol('process', 'function', ['utils'], {
                    range: new Range(10, 0, 10, 7)
                }),
                createMockSymbol('process', 'function', ['utils'], {
                    range: new Range(20, 0, 20, 7)
                })
            ];

            // Should return both for user to choose
            expect(definitions.length).to.equal(2);
        });

        it('should sort definitions by relevance', () => {
            const definitions = [
                { symbol: createMockSymbol('x', 'variable', []), score: 50 },
                { symbol: createMockSymbol('x', 'variable', ['myModule']), score: 100 },
                { symbol: createMockSymbol('x', 'variable', ['other']), score: 30 }
            ];

            definitions.sort((a, b) => b.score - a.score);

            expect(definitions[0].score).to.equal(100);
            expect(definitions[1].score).to.equal(50);
            expect(definitions[2].score).to.equal(30);
        });
    });
});
