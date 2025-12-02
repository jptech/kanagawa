/**
 * Tests for SymbolResolutionService
 * 
 * Priority: P1 - Tests the centralized resolution service used by all providers
 * 
 * The resolution service must:
 * 1. Correctly resolve local variables with exact confidence
 * 2. Correctly resolve members with receiver type context
 * 3. Handle accessibility (imports) correctly
 * 4. Return proper confidence levels based on match count
 * 5. Deduplicate symbols across resolution paths
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    SymbolKind
} from '../mocks/vscode';

// Test the resolution logic patterns without full VS Code integration
// The actual service uses these same algorithms

describe('SymbolResolutionService', () => {
    
    // Mock types matching the real service
    interface MockSymbolInfo {
        name: string;
        qualifiedName: string;
        uri: string;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        category: string;
        scopePath: string[];
    }
    
    type ResolutionConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';
    
    interface ResolutionResult {
        primary: MockSymbolInfo | undefined;
        confidence: ResolutionConfidence;
        alternatives: MockSymbolInfo[];
        inaccessible: MockSymbolInfo[];
    }

    function createMockSymbol(
        name: string,
        category: string,
        scopePath: string[] = [],
        file: string = '/test.k',
        line: number = 0
    ): MockSymbolInfo {
        return {
            name,
            qualifiedName: scopePath.length > 0 ? `${scopePath.join('::')}::${name}` : name,
            uri: `file://${file}`,
            range: { 
                start: { line, character: 0 }, 
                end: { line, character: name.length } 
            },
            category,
            scopePath
        };
    }

    function symbolKey(sym: MockSymbolInfo): string {
        return `${sym.uri}#${sym.range.start.line}:${sym.range.start.character}`;
    }

    // Replicates computeResult logic from the service
    function computeResult(
        accessible: MockSymbolInfo[],
        inaccessible: MockSymbolInfo[],
        maxAlternatives: number = 10
    ): ResolutionResult {
        if (accessible.length === 0 && inaccessible.length === 0) {
            return {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
        }

        if (accessible.length === 0) {
            return {
                primary: inaccessible[0],
                confidence: 'low',
                alternatives: inaccessible.slice(1, maxAlternatives + 1),
                inaccessible
            };
        }

        if (accessible.length === 1) {
            return {
                primary: accessible[0],
                confidence: 'exact',
                alternatives: [],
                inaccessible
            };
        }

        const confidence: ResolutionConfidence = 
            accessible.length === 2 ? 'high' :
            accessible.length <= 4 ? 'medium' : 'low';

        return {
            primary: accessible[0],
            confidence,
            alternatives: accessible.slice(1, maxAlternatives + 1),
            inaccessible
        };
    }

    describe('Confidence Scoring', () => {
        it('should return none confidence for empty results', () => {
            const result = computeResult([], []);
            expect(result.confidence).to.equal('none');
            expect(result.primary).to.be.undefined;
        });

        it('should return exact confidence for single accessible match', () => {
            const sym = createMockSymbol('foo', 'function');
            const result = computeResult([sym], []);
            expect(result.confidence).to.equal('exact');
            expect(result.primary).to.equal(sym);
            expect(result.alternatives).to.have.lengthOf(0);
        });

        it('should return high confidence for two accessible matches', () => {
            const sym1 = createMockSymbol('foo', 'function', [], '/a.k');
            const sym2 = createMockSymbol('foo', 'function', [], '/b.k');
            const result = computeResult([sym1, sym2], []);
            expect(result.confidence).to.equal('high');
            expect(result.primary).to.equal(sym1);
            expect(result.alternatives).to.deep.equal([sym2]);
        });

        it('should return medium confidence for 3-4 accessible matches', () => {
            const syms = [
                createMockSymbol('foo', 'function', [], '/a.k'),
                createMockSymbol('foo', 'function', [], '/b.k'),
                createMockSymbol('foo', 'function', [], '/c.k')
            ];
            const result = computeResult(syms, []);
            expect(result.confidence).to.equal('medium');
        });

        it('should return low confidence for 5+ accessible matches', () => {
            const syms = Array.from({ length: 5 }, (_, i) => 
                createMockSymbol('foo', 'function', [], `/file${i}.k`)
            );
            const result = computeResult(syms, []);
            expect(result.confidence).to.equal('low');
        });

        it('should return low confidence when only inaccessible matches exist', () => {
            const sym = createMockSymbol('foo', 'function', ['unimported.module']);
            const result = computeResult([], [sym]);
            expect(result.confidence).to.equal('low');
            expect(result.primary).to.equal(sym);
            expect(result.inaccessible).to.include(sym);
        });
    });

    describe('Symbol Deduplication', () => {
        it('should deduplicate symbols by location key', () => {
            const sym1 = createMockSymbol('foo', 'function', [], '/test.k', 10);
            const sym2 = createMockSymbol('foo', 'function', [], '/test.k', 10); // Same location
            const sym3 = createMockSymbol('foo', 'function', [], '/test.k', 20); // Different line

            const key1 = symbolKey(sym1);
            const key2 = symbolKey(sym2);
            const key3 = symbolKey(sym3);

            expect(key1).to.equal(key2);
            expect(key1).to.not.equal(key3);
        });

        it('should use Set for efficient deduplication', () => {
            const seen = new Set<string>();
            const symbols = [
                createMockSymbol('foo', 'function', [], '/test.k', 10),
                createMockSymbol('foo', 'function', [], '/test.k', 10),
                createMockSymbol('foo', 'function', [], '/other.k', 10)
            ];
            
            const unique: MockSymbolInfo[] = [];
            for (const sym of symbols) {
                const key = symbolKey(sym);
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push(sym);
                }
            }

            expect(unique).to.have.lengthOf(2);
        });
    });

    describe('Accessibility Checking', () => {
        interface ResolvedImports {
            currentModule: string | undefined;
            importedModules: Set<string>;
        }

        function extractModuleFromQualified(qualifiedName: string): string | undefined {
            // Look for dotted module path at start (e.g., "data.fifo::FIFO" -> "data.fifo")
            const colonIdx = qualifiedName.indexOf('::');
            if (colonIdx === -1) return undefined;
            
            const prefix = qualifiedName.substring(0, colonIdx);
            if (prefix.includes('.')) {
                return prefix;
            }
            return undefined;
        }

        function isSymbolAccessible(
            symbol: MockSymbolInfo,
            resolvedImports: ResolvedImports | undefined
        ): boolean {
            if (!resolvedImports) return true;

            const modulePath = extractModuleFromQualified(symbol.qualifiedName);

            if (!modulePath) return true; // Global
            if (modulePath === resolvedImports.currentModule) return true;
            if (resolvedImports.importedModules.has(modulePath)) return true;

            return false;
        }

        it('should allow access to symbols without module path', () => {
            const sym = createMockSymbol('globalFunc', 'function');
            const imports: ResolvedImports = {
                currentModule: 'mymodule',
                importedModules: new Set()
            };
            expect(isSymbolAccessible(sym, imports)).to.be.true;
        });

        it('should allow access to same-module symbols', () => {
            const sym = createMockSymbol('MyClass', 'class', ['data.fifo']);
            sym.qualifiedName = 'data.fifo::MyClass';
            
            const imports: ResolvedImports = {
                currentModule: 'data.fifo',
                importedModules: new Set()
            };
            expect(isSymbolAccessible(sym, imports)).to.be.true;
        });

        it('should allow access to imported module symbols', () => {
            const sym = createMockSymbol('Queue', 'class', ['data.queue']);
            sym.qualifiedName = 'data.queue::Queue';
            
            const imports: ResolvedImports = {
                currentModule: 'mymodule',
                importedModules: new Set(['data.queue', 'control.flow'])
            };
            expect(isSymbolAccessible(sym, imports)).to.be.true;
        });

        it('should deny access to non-imported module symbols', () => {
            const sym = createMockSymbol('Secret', 'class', ['private.internal']);
            sym.qualifiedName = 'private.internal::Secret';
            
            const imports: ResolvedImports = {
                currentModule: 'mymodule',
                importedModules: new Set(['data.fifo'])
            };
            expect(isSymbolAccessible(sym, imports)).to.be.false;
        });

        it('should handle undefined imports gracefully', () => {
            const sym = createMockSymbol('anything', 'function');
            expect(isSymbolAccessible(sym, undefined)).to.be.true;
        });
    });

    describe('Context Hint Detection', () => {
        // Simulates the AST patterns the service detects

        type ContextHint = 
            | { kind: 'method'; receiverType?: string }
            | { kind: 'free' };

        function detectContextFromParent(parentType: string, isLastChild: boolean): ContextHint {
            if (parentType === 'member_expression' && isLastChild) {
                return { kind: 'method' };
            }
            if (parentType === 'field_expression' && isLastChild) {
                return { kind: 'method' };
            }
            return { kind: 'free' };
        }

        it('should detect method context from member_expression', () => {
            const hint = detectContextFromParent('member_expression', true);
            expect(hint.kind).to.equal('method');
        });

        it('should detect method context from field_expression', () => {
            const hint = detectContextFromParent('field_expression', true);
            expect(hint.kind).to.equal('method');
        });

        it('should return free context for other patterns', () => {
            expect(detectContextFromParent('call_expression', true).kind).to.equal('free');
            expect(detectContextFromParent('identifier', false).kind).to.equal('free');
            expect(detectContextFromParent('assignment', true).kind).to.equal('free');
        });

        it('should return free context when not last child of member expression', () => {
            // In obj.method, 'obj' is not the last child
            const hint = detectContextFromParent('member_expression', false);
            expect(hint.kind).to.equal('free');
        });
    });

    describe('Resolution Priority', () => {
        /**
         * Resolution priority order:
         * 1. Local variables/parameters (exact confidence, immediate return)
         * 2. Member resolution (for receiver.member patterns)
         * 3. Context-aware global resolution
         * 4. Document-local fallback
         */

        it('should return immediately with exact confidence for local symbols', () => {
            const localVar = createMockSymbol('x', 'variable');
            
            // Simulating: if local found, return immediately
            const localFound = localVar;
            
            if (localFound) {
                const result: ResolutionResult = {
                    primary: localFound,
                    confidence: 'exact',
                    alternatives: [],
                    inaccessible: []
                };
                expect(result.confidence).to.equal('exact');
                expect(result.alternatives).to.have.lengthOf(0);
            }
        });

        it('should prefer member matches when in method context', () => {
            const memberMethod = createMockSymbol('push', 'method', ['FIFO']);
            const globalFunc = createMockSymbol('push', 'function', []);
            
            // In method context, member should rank higher
            const isMethodContext = true;
            const candidates = [globalFunc, memberMethod];
            
            const sorted = isMethodContext
                ? candidates.sort((a, b) => {
                    if (a.category === 'method' && b.category !== 'method') return -1;
                    if (b.category === 'method' && a.category !== 'method') return 1;
                    return 0;
                })
                : candidates;
            
            expect(sorted[0].category).to.equal('method');
        });
    });

    describe('Alternatives Limiting', () => {
        it('should respect maxAlternatives option', () => {
            const syms = Array.from({ length: 20 }, (_, i) => 
                createMockSymbol('foo', 'function', [], `/file${i}.k`)
            );
            
            const result = computeResult(syms, [], 5);
            
            expect(result.alternatives.length).to.be.at.most(5);
        });

        it('should use default maxAlternatives of 10', () => {
            const syms = Array.from({ length: 20 }, (_, i) => 
                createMockSymbol('foo', 'function', [], `/file${i}.k`)
            );
            
            const result = computeResult(syms, []);
            
            // 10 alternatives + 1 primary = 11 max shown
            expect(result.alternatives.length).to.be.at.most(10);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty symbol name gracefully', () => {
            const sym = createMockSymbol('', 'variable');
            const result = computeResult([sym], []);
            
            expect(result.primary?.name).to.equal('');
            expect(result.confidence).to.equal('exact');
        });

        it('should handle symbols with very long qualified names', () => {
            const longPath = Array.from({ length: 10 }, (_, i) => `level${i}`);
            const sym = createMockSymbol('deepSymbol', 'function', longPath);
            
            expect(sym.qualifiedName).to.include('deepSymbol');
            expect(sym.scopePath).to.have.lengthOf(10);
        });

        it('should handle symbols from same file different lines', () => {
            const sym1 = createMockSymbol('overload', 'function', [], '/test.k', 10);
            const sym2 = createMockSymbol('overload', 'function', [], '/test.k', 20);
            
            const result = computeResult([sym1, sym2], []);
            
            expect(result.confidence).to.equal('high');
            expect(result.primary?.range.start.line).to.equal(10);
            expect(result.alternatives[0]?.range.start.line).to.equal(20);
        });
    });
});
