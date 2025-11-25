import { expect } from 'chai';
import {
    computeQualifiedName,
    parseQualifiedName,
    moduleMatchesImport,
    getModuleTail,
    isSymbolAccessible,
    computeAccessibilityScore,
    countCommonPrefix,
    arraysEqual,
    createResolutionResult
} from '../../src/utils/symbolUtils';

describe('Symbol Utilities', () => {
    describe('computeQualifiedName', () => {
        it('returns just the name when scope path is empty', () => {
            expect(computeQualifiedName('helper', [])).to.equal('helper');
        });

        it('joins scope path with :: separator', () => {
            expect(computeQualifiedName('push', ['FIFO'])).to.equal('FIFO::push');
        });

        it('handles module path with dots in first scope component', () => {
            expect(computeQualifiedName('push', ['data.fifo', 'FIFO'])).to.equal('data.fifo::FIFO::push');
        });

        it('handles deeply nested scopes', () => {
            expect(computeQualifiedName('method', ['a', 'b', 'c', 'd'])).to.equal('a::b::c::d::method');
        });

        it('handles type names', () => {
            expect(computeQualifiedName('FIFO', ['data.fifo'])).to.equal('data.fifo::FIFO');
        });
    });

    describe('parseQualifiedName', () => {
        it('returns simple name with no module or path', () => {
            const result = parseQualifiedName('FIFO');
            expect(result).to.deep.equal({
                module: undefined,
                path: [],
                name: 'FIFO'
            });
        });

        it('parses single nesting level', () => {
            const result = parseQualifiedName('FIFO::push');
            expect(result).to.deep.equal({
                module: undefined,
                path: ['FIFO'],
                name: 'push'
            });
        });

        it('identifies module path with dots', () => {
            const result = parseQualifiedName('data.fifo::FIFO::push');
            expect(result).to.deep.equal({
                module: 'data.fifo',
                path: ['FIFO'],
                name: 'push'
            });
        });

        it('handles module with no additional path', () => {
            const result = parseQualifiedName('data.fifo::FIFO');
            expect(result).to.deep.equal({
                module: 'data.fifo',
                path: [],
                name: 'FIFO'
            });
        });

        it('handles multiple nesting levels without module', () => {
            const result = parseQualifiedName('Outer::Inner::method');
            expect(result).to.deep.equal({
                module: undefined,
                path: ['Outer', 'Inner'],
                name: 'method'
            });
        });
    });

    describe('moduleMatchesImport', () => {
        it('matches exact path', () => {
            expect(moduleMatchesImport('data.fifo', { path: 'data.fifo' })).to.be.true;
        });

        it('matches suffix import', () => {
            // If user writes `import fifo;` and module is `data.fifo`
            expect(moduleMatchesImport('data.fifo', { path: 'fifo' })).to.be.true;
        });

        it('does not match unrelated modules', () => {
            expect(moduleMatchesImport('data.fifo', { path: 'control.flow' })).to.be.false;
        });

        it('handles aliased imports', () => {
            expect(moduleMatchesImport('data.fifo', { path: 'data.fifo', alias: 'df' })).to.be.true;
        });

        it('matches when import is more specific', () => {
            // import data.fifo.FIFO should provide access to data.fifo module
            expect(moduleMatchesImport('data.fifo', { path: 'data.fifo.FIFO' })).to.be.true;
        });

        it('does not match partial names', () => {
            expect(moduleMatchesImport('data.fifos', { path: 'fifo' })).to.be.false;
        });
    });

    describe('getModuleTail', () => {
        it('returns last segment of dotted path', () => {
            expect(getModuleTail('data.fifo')).to.equal('fifo');
        });

        it('returns full name for single segment', () => {
            expect(getModuleTail('control')).to.equal('control');
        });

        it('handles deeply nested modules', () => {
            expect(getModuleTail('a.b.c.d')).to.equal('d');
        });
    });

    describe('isSymbolAccessible', () => {
        it('global symbols are always accessible', () => {
            expect(isSymbolAccessible(undefined, 'mymodule', [])).to.be.true;
        });

        it('same module is accessible', () => {
            expect(isSymbolAccessible('data.fifo', 'data.fifo', [])).to.be.true;
        });

        it('imported modules are accessible', () => {
            expect(isSymbolAccessible(
                'data.fifo',
                'mymodule',
                [{ path: 'data.fifo' }]
            )).to.be.true;
        });

        it('non-imported modules are not accessible', () => {
            expect(isSymbolAccessible(
                'data.fifo',
                'mymodule',
                [{ path: 'control.flow' }]
            )).to.be.false;
        });

        it('suffix imports make symbols accessible', () => {
            expect(isSymbolAccessible(
                'data.fifo',
                'mymodule',
                [{ path: 'fifo' }]
            )).to.be.true;
        });
    });

    describe('computeAccessibilityScore', () => {
        it('same module gets highest score', () => {
            const score = computeAccessibilityScore(
                'data.fifo',
                [],
                'data.fifo',
                [],
                []
            );
            expect(score).to.be.greaterThan(80);
        });

        it('global symbols get moderate score', () => {
            const score = computeAccessibilityScore(
                undefined,
                [],
                'mymodule',
                [],
                []
            );
            expect(score).to.be.greaterThan(0);
        });

        it('imported modules get bonus', () => {
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

        it('exact scope match gets very high score', () => {
            const exactMatch = computeAccessibilityScore(
                'mod',
                ['FIFO'],
                'mod',
                [],
                ['FIFO']
            );
            const noMatch = computeAccessibilityScore(
                'mod',
                ['Queue'],
                'mod',
                [],
                ['FIFO']
            );
            expect(exactMatch).to.be.greaterThan(noMatch + 100);
        });

        it('common prefix adds incremental score', () => {
            const twoCommon = computeAccessibilityScore(
                undefined,
                ['A', 'B', 'C'],
                undefined,
                [],
                ['A', 'B', 'X']
            );
            const oneCommon = computeAccessibilityScore(
                undefined,
                ['A', 'Y', 'Z'],
                undefined,
                [],
                ['A', 'B', 'X']
            );
            expect(twoCommon).to.be.greaterThan(oneCommon);
        });
    });

    describe('countCommonPrefix', () => {
        it('returns 0 for completely different arrays', () => {
            expect(countCommonPrefix(['a', 'b'], ['x', 'y'])).to.equal(0);
        });

        it('counts matching prefix elements', () => {
            expect(countCommonPrefix(['a', 'b', 'c'], ['a', 'b', 'x'])).to.equal(2);
        });

        it('handles empty arrays', () => {
            expect(countCommonPrefix([], ['a'])).to.equal(0);
            expect(countCommonPrefix(['a'], [])).to.equal(0);
        });

        it('counts full match', () => {
            expect(countCommonPrefix(['a', 'b'], ['a', 'b'])).to.equal(2);
        });
    });

    describe('arraysEqual', () => {
        it('returns true for identical arrays', () => {
            expect(arraysEqual(['a', 'b'], ['a', 'b'])).to.be.true;
        });

        it('returns false for different lengths', () => {
            expect(arraysEqual(['a'], ['a', 'b'])).to.be.false;
        });

        it('returns false for different contents', () => {
            expect(arraysEqual(['a', 'b'], ['a', 'x'])).to.be.false;
        });

        it('returns true for empty arrays', () => {
            expect(arraysEqual([], [])).to.be.true;
        });
    });

    describe('createResolutionResult', () => {
        interface TestItem { name: string; score: number; }
        const scoreGetter = (item: TestItem) => item.score;

        it('returns none confidence for empty candidates', () => {
            const result = createResolutionResult<TestItem>([], scoreGetter);
            expect(result.confidence).to.equal('none');
            expect(result.primary).to.be.undefined;
            expect(result.alternatives).to.have.lengthOf(0);
        });

        it('returns exact/high for single candidate', () => {
            const candidates = [{ name: 'a', score: 200 }];
            const result = createResolutionResult(candidates, scoreGetter);
            expect(result.confidence).to.be.oneOf(['exact', 'high']);
            expect(result.primary!.name).to.equal('a');
            expect(result.totalCandidates).to.equal(1);
        });

        it('returns exact for large score gap with high primary', () => {
            const candidates = [
                { name: 'best', score: 200 },
                { name: 'worse', score: 100 }
            ];
            const result = createResolutionResult(candidates, scoreGetter);
            expect(result.confidence).to.equal('exact');
            expect(result.primary!.name).to.equal('best');
            expect(result.alternatives).to.have.lengthOf(1);
        });

        it('returns low for tied candidates', () => {
            const candidates = [
                { name: 'a', score: 50 },
                { name: 'b', score: 50 }
            ];
            const result = createResolutionResult(candidates, scoreGetter);
            expect(result.confidence).to.equal('low');
        });

        it('lists all alternatives after primary', () => {
            const candidates = [
                { name: 'first', score: 100 },
                { name: 'second', score: 90 },
                { name: 'third', score: 80 }
            ];
            const result = createResolutionResult(candidates, scoreGetter);
            expect(result.alternatives).to.have.lengthOf(2);
            expect(result.alternatives[0].name).to.equal('second');
            expect(result.alternatives[1].name).to.equal('third');
        });
    });
});
