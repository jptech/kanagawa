/**
 * Tests for WorkspaceIndexer
 * 
 * Tests the core indexing logic, symbol resolution, and caching behavior.
 * These tests focus on the algorithms and data structures that can be tested
 * independently of actual Tree-sitter parsing.
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    SymbolKind,
    MockTextDocument,
    createTestDocument
} from '../mocks/vscode';

// Import utility functions that the indexer uses
import {
    computeQualifiedName,
    computeAccessibilityScore,
    createResolutionResult
} from '../../src/utils/symbolUtils';
import {
    ModuleExports,
    ResolvedImports,
    resolveImports,
    filterByAccessibility,
    extractModuleFromQualified
} from '../../src/utils/importUtils';
import {
    filterDirectMembers,
    filterMembersByOptions,
    sortMembers,
    findBestContainer,
    extractTemplateBaseType
} from '../../src/utils/memberUtils';

// Mock SymbolInfo for testing
interface MockSymbolInfo {
    name: string;
    qualifiedName: string;
    uri: Uri;
    range: Range;
    kind: SymbolKind;
    detail?: string;
    docMarkdown?: string;
    signature?: string;
    scopePath: string[];
    category: 'module' | 'class' | 'struct' | 'union' | 'enum' | 'function' | 'method' | 'variable' | 'member' | 'constant' | 'alias' | 'other';
    typeHint?: string;
}

function createMockSymbol(
    name: string,
    category: MockSymbolInfo['category'],
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

describe('WorkspaceIndexer', () => {
    describe('LRU Cache Pattern', () => {
        // Tests the LRU cache pattern used for resolved imports
        
        class LRUCache<T> {
            private cache: Map<string, T> = new Map();
            
            constructor(private readonly limit: number) {}
            
            get(key: string): T | undefined {
                const value = this.cache.get(key);
                if (value !== undefined) {
                    // Move to end (most recently used)
                    this.cache.delete(key);
                    this.cache.set(key, value);
                }
                return value;
            }
            
            set(key: string, value: T): void {
                // If key exists, delete first (to update position)
                if (this.cache.has(key)) {
                    this.cache.delete(key);
                }
                
                // Evict oldest if at limit
                if (this.cache.size >= this.limit) {
                    const firstKey = this.cache.keys().next().value;
                    if (firstKey) {
                        this.cache.delete(firstKey);
                    }
                }
                
                this.cache.set(key, value);
            }
            
            delete(key: string): boolean {
                return this.cache.delete(key);
            }
            
            get size(): number {
                return this.cache.size;
            }
            
            keys(): IterableIterator<string> {
                return this.cache.keys();
            }
        }
        
        it('should evict oldest entry when limit reached', () => {
            const cache = new LRUCache<string>(3);
            
            cache.set('a', 'value-a');
            cache.set('b', 'value-b');
            cache.set('c', 'value-c');
            expect(cache.size).to.equal(3);
            
            // Add fourth item - should evict 'a'
            cache.set('d', 'value-d');
            expect(cache.size).to.equal(3);
            expect(cache.get('a')).to.be.undefined;
            expect(cache.get('b')).to.equal('value-b');
        });
        
        it('should move accessed items to end', () => {
            const cache = new LRUCache<string>(3);
            
            cache.set('a', 'value-a');
            cache.set('b', 'value-b');
            cache.set('c', 'value-c');
            
            // Access 'a' - moves it to end
            cache.get('a');
            
            // Add 'd' - should evict 'b' (now oldest)
            cache.set('d', 'value-d');
            expect(cache.get('a')).to.equal('value-a');
            expect(cache.get('b')).to.be.undefined;
        });
        
        it('should handle repeated access to same key', () => {
            const cache = new LRUCache<string>(3);
            
            cache.set('a', 'value-a');
            cache.set('b', 'value-b');
            cache.set('c', 'value-c');
            
            // Repeatedly access 'a'
            for (let i = 0; i < 10; i++) {
                cache.get('a');
            }
            
            // Add new items - should evict 'b' and 'c' before 'a'
            cache.set('d', 'value-d');
            cache.set('e', 'value-e');
            
            expect(cache.get('a')).to.equal('value-a');
        });
        
        it('should allow explicit deletion', () => {
            const cache = new LRUCache<string>(3);
            
            cache.set('a', 'value-a');
            cache.set('b', 'value-b');
            
            cache.delete('a');
            expect(cache.get('a')).to.be.undefined;
            expect(cache.size).to.equal(1);
        });
    });

    describe('Symbol Resolution Scoring', () => {
        it('should score same-module symbols highest', () => {
            const score = computeAccessibilityScore(
                'data.fifo',    // symbol module
                [],             // symbol scope
                'data.fifo',    // document module
                [],             // document imports
                []              // reference scope
            );
            expect(score).to.be.greaterThan(80);
        });

        it('should score imported symbols higher than non-imported', () => {
            const importedScore = computeAccessibilityScore(
                'data.fifo',
                [],
                'mymodule',
                [{ path: 'data.fifo' }],
                []
            );
            
            const notImportedScore = computeAccessibilityScore(
                'data.fifo',
                [],
                'mymodule',
                [],
                []
            );
            
            expect(importedScore).to.be.greaterThan(notImportedScore);
        });

        it('should give bonus for exact scope match', () => {
            const exactMatch = computeAccessibilityScore(
                'mod',
                ['Container', 'Inner'],
                'mod',
                [],
                ['Container', 'Inner']
            );
            
            const partialMatch = computeAccessibilityScore(
                'mod',
                ['Container', 'Other'],
                'mod',
                [],
                ['Container', 'Inner']
            );
            
            expect(exactMatch).to.be.greaterThan(partialMatch + 100);
        });

        it('should score global symbols with positive score', () => {
            const globalScore = computeAccessibilityScore(
                undefined,  // no module = global
                [],
                'mymodule',
                [],
                []
            );
            
            // Global symbols are always accessible, so they get a positive score
            expect(globalScore).to.be.greaterThan(0);
        });
    });

    describe('Module Export Building', () => {
        it('should extract module from qualified name', () => {
            expect(extractModuleFromQualified('data.fifo::FIFO::push')).to.equal('data.fifo');
            expect(extractModuleFromQualified('FIFO::push')).to.be.undefined;
            expect(extractModuleFromQualified('push')).to.be.undefined;
        });

        it('should handle deeply nested qualified names', () => {
            expect(extractModuleFromQualified('a.b.c::Class::Inner::method')).to.equal('a.b.c');
        });
    });

    describe('Import Resolution', () => {
        it('should resolve direct imports', () => {
            const moduleExports = new Map<string, ModuleExports>();
            moduleExports.set('data.fifo', {
                modulePath: 'data.fifo',
                exportedSymbols: new Set(['data.fifo::FIFO', 'data.fifo::FIFO::push']),
                exportedNames: new Set(['FIFO', 'push'])
            });

            const resolved = resolveImports(
                'mymodule',
                [{ path: 'data.fifo' }],
                moduleExports
            );

            expect(resolved.currentModule).to.equal('mymodule');
            expect(resolved.importedModules.has('data.fifo')).to.be.true;
            expect(resolved.accessibleQualifiedNames.has('data.fifo::FIFO')).to.be.true;
        });

        it('should handle aliased imports', () => {
            const moduleExports = new Map<string, ModuleExports>();
            moduleExports.set('data.fifo', {
                modulePath: 'data.fifo',
                exportedSymbols: new Set(['data.fifo::FIFO']),
                exportedNames: new Set(['FIFO'])
            });

            const resolved = resolveImports(
                'mymodule',
                [{ path: 'data.fifo', alias: 'df' }],
                moduleExports
            );

            expect(resolved.aliasToModule.get('df')).to.equal('data.fifo');
        });

        it('should filter symbols by accessibility', () => {
            const symbols: MockSymbolInfo[] = [
                createMockSymbol('FIFO', 'class', ['data.fifo']),
                createMockSymbol('Queue', 'class', ['data.queue']),
                createMockSymbol('helper', 'function', [])  // global
            ];

            const resolvedImports: ResolvedImports = {
                currentModule: 'mymodule',
                importedModules: new Set(['data.fifo']),
                aliasToModule: new Map(),
                accessibleQualifiedNames: new Set(['data.fifo::FIFO'])
            };

            const filtered = filterByAccessibility(symbols, resolvedImports, {
                includeInaccessible: false
            });

            // Should include FIFO (imported) and helper (global), but not Queue
            expect(filtered.length).to.equal(2);
            expect(filtered.some(s => s.name === 'FIFO')).to.be.true;
            expect(filtered.some(s => s.name === 'helper')).to.be.true;
            expect(filtered.some(s => s.name === 'Queue')).to.be.false;
        });
    });

    describe('Member Resolution', () => {
        it('should extract template base type', () => {
            expect(extractTemplateBaseType('FIFO<int32, 16>')).to.equal('FIFO');
            expect(extractTemplateBaseType('Vector<T>')).to.equal('Vector');
            expect(extractTemplateBaseType('SimpleType')).to.equal('SimpleType');
        });

        it('should filter members by category', () => {
            const members: MockSymbolInfo[] = [
                createMockSymbol('push', 'method', ['FIFO']),
                createMockSymbol('pop', 'method', ['FIFO']),
                createMockSymbol('size', 'member', ['FIFO']),
                createMockSymbol('MAX_SIZE', 'constant', ['FIFO'])
            ];

            const methods = filterMembersByOptions(members as any, { 
                includeMethods: true, 
                includeFields: false,
                includeConstants: false 
            });
            expect(methods.length).to.equal(2);
            expect(methods.every(m => m.category === 'method')).to.be.true;

            const fields = filterMembersByOptions(members as any, { 
                includeMethods: false, 
                includeFields: true,
                includeConstants: false 
            });
            expect(fields.length).to.equal(1);
            expect(fields[0].name).to.equal('size');
        });

        it('should sort members with methods first', () => {
            const members: MockSymbolInfo[] = [
                createMockSymbol('zfield', 'member', ['C']),
                createMockSymbol('amethod', 'method', ['C']),
                createMockSymbol('bfield', 'member', ['C']),
                createMockSymbol('zmethod', 'method', ['C'])
            ];

            const sorted = sortMembers(members as any);
            
            // Methods should come first
            expect(sorted[0].category).to.equal('method');
            expect(sorted[1].category).to.equal('method');
            // Then fields
            expect(sorted[2].category).to.equal('member');
            expect(sorted[3].category).to.equal('member');
        });
    });

    describe('Resolution Result', () => {
        it('should calculate confidence based on score gap', () => {
            const candidates = [
                { name: 'best', score: 200 },
                { name: 'worse', score: 50 }
            ];
            
            const result = createResolutionResult(
                candidates,
                (c) => c.score
            );
            
            // Large gap + high score = exact
            expect(result.confidence).to.equal('exact');
            expect(result.primary!.name).to.equal('best');
        });

        it('should return low confidence for tied scores', () => {
            const candidates = [
                { name: 'a', score: 50 },
                { name: 'b', score: 50 }
            ];
            
            const result = createResolutionResult(
                candidates,
                (c) => c.score
            );
            
            expect(result.confidence).to.equal('low');
        });

        it('should return none confidence for no candidates', () => {
            const result = createResolutionResult<{ name: string }>(
                [],
                () => 0
            );
            
            expect(result.confidence).to.equal('none');
            expect(result.primary).to.be.undefined;
        });

        it('should populate alternatives correctly', () => {
            const candidates = [
                { name: 'first', score: 100 },
                { name: 'second', score: 80 },
                { name: 'third', score: 60 }
            ];
            
            const result = createResolutionResult(
                candidates,
                (c) => c.score
            );
            
            expect(result.alternatives.length).to.equal(2);
            expect(result.alternatives[0].name).to.equal('second');
            expect(result.alternatives[1].name).to.equal('third');
            expect(result.totalCandidates).to.equal(3);
        });
    });

    describe('Qualified Name Computation', () => {
        it('should build qualified name from scope path', () => {
            expect(computeQualifiedName('push', ['data.fifo', 'FIFO']))
                .to.equal('data.fifo::FIFO::push');
        });

        it('should return just name for empty scope', () => {
            expect(computeQualifiedName('helper', []))
                .to.equal('helper');
        });

        it('should handle deeply nested scopes', () => {
            expect(computeQualifiedName('method', ['mod', 'Outer', 'Inner']))
                .to.equal('mod::Outer::Inner::method');
        });
    });

    describe('Scope Path Matching', () => {
        function scopePathsMatch(a: string[], b: string[]): boolean {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }

        it('should match identical scope paths', () => {
            expect(scopePathsMatch(['A', 'B', 'C'], ['A', 'B', 'C'])).to.be.true;
        });

        it('should not match different length paths', () => {
            expect(scopePathsMatch(['A', 'B'], ['A', 'B', 'C'])).to.be.false;
        });

        it('should not match different content', () => {
            expect(scopePathsMatch(['A', 'B', 'C'], ['A', 'X', 'C'])).to.be.false;
        });

        it('should match empty paths', () => {
            expect(scopePathsMatch([], [])).to.be.true;
        });
    });

    describe('Type Name Normalization', () => {
        function normalizeTypeName(raw: string): string {
            // Strip template arguments: Vector<T, N> → Vector
            const baseMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
            return baseMatch ? baseMatch[1] : raw;
        }

        function sanitizeTypeText(raw: string): string {
            // Collapse whitespace and trim
            return raw.replace(/\s+/g, ' ').trim();
        }

        it('should strip template arguments', () => {
            expect(normalizeTypeName('Vector<T, N>')).to.equal('Vector');
            expect(normalizeTypeName('FIFO<int32>')).to.equal('FIFO');
        });

        it('should handle simple types', () => {
            expect(normalizeTypeName('int32')).to.equal('int32');
            expect(normalizeTypeName('MyClass')).to.equal('MyClass');
        });

        it('should sanitize whitespace in types', () => {
            expect(sanitizeTypeText('  Vector < T ,  N >  ')).to.equal('Vector < T , N >');
            expect(sanitizeTypeText('const   int32')).to.equal('const int32');
        });
    });

    describe('Member Cache Invalidation', () => {
        // Simulate the targeted invalidation pattern
        
        class MemberCacheWithInvalidation {
            private memberCache: Map<string, MockSymbolInfo[]> = new Map();
            private memberCacheByUri: Map<string, Set<string>> = new Map();
            
            setMembers(typeName: string, members: MockSymbolInfo[]): void {
                this.memberCache.set(typeName, members);
                
                // Build reverse mapping
                for (const member of members) {
                    const uriStr = member.uri.toString();
                    let cacheKeys = this.memberCacheByUri.get(uriStr);
                    if (!cacheKeys) {
                        cacheKeys = new Set();
                        this.memberCacheByUri.set(uriStr, cacheKeys);
                    }
                    cacheKeys.add(typeName);
                }
            }
            
            getMembers(typeName: string): MockSymbolInfo[] | undefined {
                return this.memberCache.get(typeName);
            }
            
            invalidateForUri(uri: Uri): void {
                const uriStr = uri.toString();
                const affectedKeys = this.memberCacheByUri.get(uriStr);
                
                if (affectedKeys) {
                    for (const key of affectedKeys) {
                        this.memberCache.delete(key);
                    }
                    this.memberCacheByUri.delete(uriStr);
                }
            }
            
            get cacheSize(): number {
                return this.memberCache.size;
            }
        }
        
        it('should invalidate only affected entries', () => {
            const cache = new MemberCacheWithInvalidation();
            const uri1 = Uri.file('/file1.k');
            const uri2 = Uri.file('/file2.k');
            
            cache.setMembers('TypeA', [
                createMockSymbol('method1', 'method', ['TypeA'], { uri: uri1 })
            ]);
            cache.setMembers('TypeB', [
                createMockSymbol('method2', 'method', ['TypeB'], { uri: uri2 })
            ]);
            
            expect(cache.cacheSize).to.equal(2);
            
            // Invalidate uri1 - should only remove TypeA
            cache.invalidateForUri(uri1);
            
            expect(cache.cacheSize).to.equal(1);
            expect(cache.getMembers('TypeA')).to.be.undefined;
            expect(cache.getMembers('TypeB')).to.not.be.undefined;
        });
        
        it('should handle types with members from multiple files', () => {
            const cache = new MemberCacheWithInvalidation();
            const uri1 = Uri.file('/file1.k');
            const uri2 = Uri.file('/file2.k');
            
            // TypeA has members from both files
            cache.setMembers('TypeA', [
                createMockSymbol('method1', 'method', ['TypeA'], { uri: uri1 }),
                createMockSymbol('method2', 'method', ['TypeA'], { uri: uri2 })
            ]);
            
            // Invalidating either file should clear TypeA
            cache.invalidateForUri(uri1);
            expect(cache.getMembers('TypeA')).to.be.undefined;
        });
    });

    describe('Alias Chain Resolution', () => {
        function resolveAliasChain(
            name: string, 
            aliasMap: Map<string, string>,
            maxDepth: number = 50
        ): string {
            let current = name;
            let depth = 0;
            
            while (aliasMap.has(current) && depth < maxDepth) {
                current = aliasMap.get(current)!;
                depth++;
            }
            
            return current;
        }

        it('should resolve simple alias', () => {
            const aliases = new Map([['MyAlias', 'RealType']]);
            expect(resolveAliasChain('MyAlias', aliases)).to.equal('RealType');
        });

        it('should resolve chain of aliases', () => {
            const aliases = new Map([
                ['A', 'B'],
                ['B', 'C'],
                ['C', 'RealType']
            ]);
            expect(resolveAliasChain('A', aliases)).to.equal('RealType');
        });

        it('should return input if not an alias', () => {
            const aliases = new Map([['MyAlias', 'RealType']]);
            expect(resolveAliasChain('NotAnAlias', aliases)).to.equal('NotAnAlias');
        });

        it('should limit chain depth to prevent infinite loops', () => {
            // Create a cycle
            const aliases = new Map([
                ['A', 'B'],
                ['B', 'A']
            ]);
            const result = resolveAliasChain('A', aliases, 50);
            // Should stop after max depth
            expect(['A', 'B']).to.include(result);
        });
    });
});
