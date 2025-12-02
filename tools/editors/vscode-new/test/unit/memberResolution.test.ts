/**
 * Tests for member resolution on class member fields.
 * 
 * Priority: P0 - Critical bug fix
 * 
 * Issue: When hovering over `_counter.count()` inside UnsafeSemaphore,
 * the hover shows `UnsafeSemaphore::count()` instead of `Counter::count()`.
 * 
 * The bug is that member resolution falls through to scope-based resolution
 * which prioritizes symbols in the enclosing class.
 * 
 * Expected behavior: Member expressions should ALWAYS resolve based on
 * the receiver's type, not the enclosing scope.
 */

import { expect } from 'chai';

describe('MemberResolution', () => {
    
    // Mock types matching the real implementation
    interface MockSymbolInfo {
        name: string;
        qualifiedName: string;
        uri: string;
        category: string;
        scopePath: string[];
        typeHint?: string;
        signature?: string;
    }

    type SymbolContextHint = 
        | { kind: 'method'; receiverType?: string }
        | { kind: 'free' }
        | { kind: 'unknown' };

    /**
     * Simulates normalizeTypeName behavior
     */
    function normalizeTypeName(raw: string): string {
        if (!raw) { return ''; }
        let text = raw.trim();
        text = text.replace(/^const\s+/, '');
        const angleIndex = text.indexOf('<');
        if (angleIndex !== -1) {
            text = text.slice(0, angleIndex);
        }
        const doubleSep = text.lastIndexOf('::');
        if (doubleSep !== -1) {
            text = text.slice(doubleSep + 2);
        }
        const dotSep = text.lastIndexOf('.');
        if (dotSep !== -1) {
            text = text.slice(dotSep + 1);
        }
        return text.replace(/\s+/g, '');
    }

    /**
     * Simulates member lookup by container type
     */
    function getMembersForType(
        containerName: string,
        memberIndex: Map<string, MockSymbolInfo[]>
    ): MockSymbolInfo[] {
        const normalized = normalizeTypeName(containerName);
        return memberIndex.get(normalized) ?? [];
    }

    /**
     * Simulates resolveMemberSymbol logic
     */
    function resolveMemberSymbol(
        receiverType: string | undefined,
        memberName: string,
        memberIndex: Map<string, MockSymbolInfo[]>
    ): MockSymbolInfo[] | undefined {
        if (!receiverType) { return undefined; }
        
        const members = getMembersForType(receiverType, memberIndex);
        const matches = members.filter(sym => sym.name === memberName);
        
        return matches.length > 0 ? matches : undefined;
    }

    /**
     * Simulates scope-based resolution (what happens when member resolution fails)
     */
    function resolveByScope(
        name: string,
        currentScopePath: string[],
        allSymbols: MockSymbolInfo[]
    ): MockSymbolInfo | undefined {
        // Score by scope similarity (higher = better match)
        const scored = allSymbols
            .filter(sym => sym.name === name)
            .map(sym => {
                let score = 0;
                // Exact scope match gets highest score
                if (arraysEqual(sym.scopePath, currentScopePath)) {
                    score += 200;
                }
                // Same file/module bonus
                for (let i = 0; i < Math.min(sym.scopePath.length, currentScopePath.length); i++) {
                    if (sym.scopePath[i] === currentScopePath[i]) {
                        score += 20;
                    }
                }
                return { sym, score };
            })
            .sort((a, b) => b.score - a.score);
        
        return scored[0]?.sym;
    }

    function arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    describe('Type Normalization', () => {
        it('should strip template arguments', () => {
            expect(normalizeTypeName('counter<M, I>')).to.equal('counter');
            expect(normalizeTypeName('FIFO<uint32, 32>')).to.equal('FIFO');
            expect(normalizeTypeName('Vector<T>')).to.equal('Vector');
        });

        it('should strip module prefixes', () => {
            expect(normalizeTypeName('data.counter::counter')).to.equal('counter');
            expect(normalizeTypeName('data.fifo::FIFO')).to.equal('FIFO');
        });

        it('should handle const prefix', () => {
            expect(normalizeTypeName('const counter<M>')).to.equal('counter');
        });

        it('should handle simple names', () => {
            expect(normalizeTypeName('counter')).to.equal('counter');
            expect(normalizeTypeName('UnsafeSemaphore')).to.equal('UnsafeSemaphore');
        });
    });

    describe('Member Resolution vs Scope Resolution', () => {
        // Setup: Both `counter` and `UnsafeSemaphore` have a `count()` method
        const counterCountMethod: MockSymbolInfo = {
            name: 'count',
            qualifiedName: 'data.counter::counter::count',
            uri: 'file:///library/data/counter.k',
            category: 'method',
            scopePath: ['data.counter', 'counter'],
            signature: 'inline ctr_t count()',
            typeHint: 'ctr_t'
        };

        const unsafeSemaphoreCountMethod: MockSymbolInfo = {
            name: 'count',
            qualifiedName: 'unsafe_semaphore::UnsafeSemaphore::count',
            uri: 'file:///unsafe_semaphore_copy.k',
            category: 'method',
            scopePath: ['unsafe_semaphore', 'UnsafeSemaphore'],
            signature: 'inline sem_ctr_t count()',
            typeHint: 'sem_ctr_t'
        };

        const counterMember: MockSymbolInfo = {
            name: '_counter',
            qualifiedName: 'unsafe_semaphore::UnsafeSemaphore::_counter',
            uri: 'file:///unsafe_semaphore_copy.k',
            category: 'member',
            scopePath: ['unsafe_semaphore', 'UnsafeSemaphore'],
            typeHint: 'counter<M, I>'
        };

        // Build member index (type name → members)
        const memberIndex = new Map<string, MockSymbolInfo[]>([
            ['counter', [counterCountMethod]],
            ['UnsafeSemaphore', [unsafeSemaphoreCountMethod, counterMember]]
        ]);

        // All symbols for scope-based resolution
        const allSymbols = [counterCountMethod, unsafeSemaphoreCountMethod, counterMember];

        it('should resolve member based on receiver type, not enclosing scope', () => {
            // Scenario: Inside UnsafeSemaphore::test_and_decrement(), 
            // hovering over `count` in `_counter.count()`
            
            const receiverType = 'counter<M, I>'; // Type of _counter
            const memberName = 'count';
            
            const memberResolution = resolveMemberSymbol(receiverType, memberName, memberIndex);
            
            expect(memberResolution).to.not.be.undefined;
            expect(memberResolution).to.have.lengthOf(1);
            expect(memberResolution![0].qualifiedName).to.equal('data.counter::counter::count');
            expect(memberResolution![0].scopePath).to.deep.equal(['data.counter', 'counter']);
        });

        it('should NOT return UnsafeSemaphore::count when receiver is counter', () => {
            const receiverType = 'counter<M, I>';
            const memberName = 'count';
            
            const memberResolution = resolveMemberSymbol(receiverType, memberName, memberIndex);
            
            // Should NOT find UnsafeSemaphore::count
            const wrongMatch = memberResolution?.find(
                sym => sym.qualifiedName.includes('UnsafeSemaphore')
            );
            expect(wrongMatch).to.be.undefined;
        });

        it('scope-based resolution incorrectly prefers enclosing class (demonstrating the bug)', () => {
            // This test demonstrates what happens when member resolution fails
            // and falls through to scope-based resolution
            
            const currentScopePath = ['unsafe_semaphore', 'UnsafeSemaphore', 'test_and_decrement'];
            const name = 'count';
            
            // Scope-based resolution will prefer UnsafeSemaphore::count because
            // it has a higher scope similarity score
            const scopeResult = resolveByScope(name, currentScopePath, allSymbols);
            
            // This is the BUG - scope resolution finds the wrong method
            expect(scopeResult).to.not.be.undefined;
            expect(scopeResult!.qualifiedName).to.equal('unsafe_semaphore::UnsafeSemaphore::count');
        });

        it('member resolution should take precedence and return correct result', () => {
            // The fix: when in a member expression context, member resolution
            // should ALWAYS be used and should NOT fall through to scope resolution
            
            const receiverType = 'counter<M, I>';
            const memberName = 'count';
            
            // Member resolution returns the correct result
            const memberResult = resolveMemberSymbol(receiverType, memberName, memberIndex);
            
            expect(memberResult).to.not.be.undefined;
            expect(memberResult![0].qualifiedName).to.equal('data.counter::counter::count');
        });
    });

    describe('Edge Cases', () => {
        const memberIndex = new Map<string, MockSymbolInfo[]>();

        it('should return undefined when receiver type is unknown', () => {
            const result = resolveMemberSymbol(undefined, 'foo', memberIndex);
            expect(result).to.be.undefined;
        });

        it('should return undefined when member not found on type', () => {
            const result = resolveMemberSymbol('SomeType', 'nonexistent', memberIndex);
            expect(result).to.be.undefined;
        });

        it('should handle empty receiver type string', () => {
            const result = resolveMemberSymbol('', 'foo', memberIndex);
            expect(result).to.be.undefined;
        });
    });

    describe('Resolution Flow Priority', () => {
        /**
         * The resolution service should follow this priority:
         * 1. Local variables (exact confidence)
         * 2. Member resolution (if in member expression context)
         * 3. Context-aware scope resolution (ONLY if member resolution fails)
         * 
         * The bug: Priority 3 runs even when Priority 2 should handle the case.
         */

        interface ResolutionResult {
            symbol: MockSymbolInfo | undefined;
            source: 'local' | 'member' | 'scope' | 'none';
        }

        function simulateResolution(
            contextHint: SymbolContextHint,
            receiverType: string | undefined,
            memberName: string,
            memberIndex: Map<string, MockSymbolInfo[]>,
            allSymbols: MockSymbolInfo[],
            currentScope: string[]
        ): ResolutionResult {
            // Priority 2: Member resolution (for receiver.member patterns)
            if (contextHint.kind === 'method' && receiverType) {
                const memberMatches = resolveMemberSymbol(receiverType, memberName, memberIndex);
                if (memberMatches && memberMatches.length > 0) {
                    // BUG FIX: Should return here, not fall through!
                    return { symbol: memberMatches[0], source: 'member' };
                }
            }

            // Priority 3: Scope-based resolution (should NOT run for member expressions!)
            const scopeResult = resolveByScope(memberName, currentScope, allSymbols);
            if (scopeResult) {
                return { symbol: scopeResult, source: 'scope' };
            }

            return { symbol: undefined, source: 'none' };
        }

        it('should use member resolution for member expressions', () => {
            const counterCountMethod: MockSymbolInfo = {
                name: 'count',
                qualifiedName: 'data.counter::counter::count',
                uri: 'file:///library/data/counter.k',
                category: 'method',
                scopePath: ['data.counter', 'counter'],
                signature: 'inline ctr_t count()'
            };

            const unsafeSemaphoreCountMethod: MockSymbolInfo = {
                name: 'count',
                qualifiedName: 'unsafe_semaphore::UnsafeSemaphore::count',
                uri: 'file:///unsafe_semaphore_copy.k',
                category: 'method',
                scopePath: ['unsafe_semaphore', 'UnsafeSemaphore'],
                signature: 'inline sem_ctr_t count()'
            };

            const memberIndex = new Map<string, MockSymbolInfo[]>([
                ['counter', [counterCountMethod]],
                ['UnsafeSemaphore', [unsafeSemaphoreCountMethod]]
            ]);

            const allSymbols = [counterCountMethod, unsafeSemaphoreCountMethod];
            
            const result = simulateResolution(
                { kind: 'method', receiverType: 'counter<M, I>' },
                'counter<M, I>',
                'count',
                memberIndex,
                allSymbols,
                ['unsafe_semaphore', 'UnsafeSemaphore', 'test_and_decrement']
            );

            expect(result.source).to.equal('member');
            expect(result.symbol?.qualifiedName).to.equal('data.counter::counter::count');
        });
    });
});
