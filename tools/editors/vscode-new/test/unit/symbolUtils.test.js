"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const symbolUtils_1 = require("../../src/utils/symbolUtils");
describe('Symbol Utilities', () => {
    describe('computeQualifiedName', () => {
        it('returns just the name when scope path is empty', () => {
            (0, chai_1.expect)((0, symbolUtils_1.computeQualifiedName)('helper', [])).to.equal('helper');
        });
        it('joins scope path with :: separator', () => {
            (0, chai_1.expect)((0, symbolUtils_1.computeQualifiedName)('push', ['FIFO'])).to.equal('FIFO::push');
        });
        it('handles module path with dots in first scope component', () => {
            (0, chai_1.expect)((0, symbolUtils_1.computeQualifiedName)('push', ['data.fifo', 'FIFO'])).to.equal('data.fifo::FIFO::push');
        });
        it('handles deeply nested scopes', () => {
            (0, chai_1.expect)((0, symbolUtils_1.computeQualifiedName)('method', ['a', 'b', 'c', 'd'])).to.equal('a::b::c::d::method');
        });
        it('handles type names', () => {
            (0, chai_1.expect)((0, symbolUtils_1.computeQualifiedName)('FIFO', ['data.fifo'])).to.equal('data.fifo::FIFO');
        });
    });
    describe('parseQualifiedName', () => {
        it('returns simple name with no module or path', () => {
            const result = (0, symbolUtils_1.parseQualifiedName)('FIFO');
            (0, chai_1.expect)(result).to.deep.equal({
                module: undefined,
                path: [],
                name: 'FIFO'
            });
        });
        it('parses single nesting level', () => {
            const result = (0, symbolUtils_1.parseQualifiedName)('FIFO::push');
            (0, chai_1.expect)(result).to.deep.equal({
                module: undefined,
                path: ['FIFO'],
                name: 'push'
            });
        });
        it('identifies module path with dots', () => {
            const result = (0, symbolUtils_1.parseQualifiedName)('data.fifo::FIFO::push');
            (0, chai_1.expect)(result).to.deep.equal({
                module: 'data.fifo',
                path: ['FIFO'],
                name: 'push'
            });
        });
        it('handles module with no additional path', () => {
            const result = (0, symbolUtils_1.parseQualifiedName)('data.fifo::FIFO');
            (0, chai_1.expect)(result).to.deep.equal({
                module: 'data.fifo',
                path: [],
                name: 'FIFO'
            });
        });
        it('handles multiple nesting levels without module', () => {
            const result = (0, symbolUtils_1.parseQualifiedName)('Outer::Inner::method');
            (0, chai_1.expect)(result).to.deep.equal({
                module: undefined,
                path: ['Outer', 'Inner'],
                name: 'method'
            });
        });
    });
    describe('moduleMatchesImport', () => {
        it('matches exact path', () => {
            (0, chai_1.expect)((0, symbolUtils_1.moduleMatchesImport)('data.fifo', { path: 'data.fifo' })).to.be.true;
        });
        it('matches suffix import', () => {
            // If user writes `import fifo;` and module is `data.fifo`
            (0, chai_1.expect)((0, symbolUtils_1.moduleMatchesImport)('data.fifo', { path: 'fifo' })).to.be.true;
        });
        it('does not match unrelated modules', () => {
            (0, chai_1.expect)((0, symbolUtils_1.moduleMatchesImport)('data.fifo', { path: 'control.flow' })).to.be.false;
        });
        it('handles aliased imports', () => {
            (0, chai_1.expect)((0, symbolUtils_1.moduleMatchesImport)('data.fifo', { path: 'data.fifo', alias: 'df' })).to.be.true;
        });
        it('matches when import is more specific', () => {
            // import data.fifo.FIFO should provide access to data.fifo module
            (0, chai_1.expect)((0, symbolUtils_1.moduleMatchesImport)('data.fifo', { path: 'data.fifo.FIFO' })).to.be.true;
        });
        it('does not match partial names', () => {
            (0, chai_1.expect)((0, symbolUtils_1.moduleMatchesImport)('data.fifos', { path: 'fifo' })).to.be.false;
        });
    });
    describe('getModuleTail', () => {
        it('returns last segment of dotted path', () => {
            (0, chai_1.expect)((0, symbolUtils_1.getModuleTail)('data.fifo')).to.equal('fifo');
        });
        it('returns full name for single segment', () => {
            (0, chai_1.expect)((0, symbolUtils_1.getModuleTail)('control')).to.equal('control');
        });
        it('handles deeply nested modules', () => {
            (0, chai_1.expect)((0, symbolUtils_1.getModuleTail)('a.b.c.d')).to.equal('d');
        });
    });
    describe('isSymbolAccessible', () => {
        it('global symbols are always accessible', () => {
            (0, chai_1.expect)((0, symbolUtils_1.isSymbolAccessible)(undefined, 'mymodule', [])).to.be.true;
        });
        it('same module is accessible', () => {
            (0, chai_1.expect)((0, symbolUtils_1.isSymbolAccessible)('data.fifo', 'data.fifo', [])).to.be.true;
        });
        it('imported modules are accessible', () => {
            (0, chai_1.expect)((0, symbolUtils_1.isSymbolAccessible)('data.fifo', 'mymodule', [{ path: 'data.fifo' }])).to.be.true;
        });
        it('non-imported modules are not accessible', () => {
            (0, chai_1.expect)((0, symbolUtils_1.isSymbolAccessible)('data.fifo', 'mymodule', [{ path: 'control.flow' }])).to.be.false;
        });
        it('suffix imports make symbols accessible', () => {
            (0, chai_1.expect)((0, symbolUtils_1.isSymbolAccessible)('data.fifo', 'mymodule', [{ path: 'fifo' }])).to.be.true;
        });
    });
    describe('computeAccessibilityScore', () => {
        it('same module gets highest score', () => {
            const score = (0, symbolUtils_1.computeAccessibilityScore)('data.fifo', [], 'data.fifo', [], []);
            (0, chai_1.expect)(score).to.be.greaterThan(80);
        });
        it('global symbols get moderate score', () => {
            const score = (0, symbolUtils_1.computeAccessibilityScore)(undefined, [], 'mymodule', [], []);
            (0, chai_1.expect)(score).to.be.greaterThan(0);
        });
        it('imported modules get bonus', () => {
            const importedScore = (0, symbolUtils_1.computeAccessibilityScore)('data.fifo', [], 'mymodule', [{ path: 'data.fifo' }], []);
            const notImportedScore = (0, symbolUtils_1.computeAccessibilityScore)('data.fifo', [], 'mymodule', [], []);
            (0, chai_1.expect)(importedScore).to.be.greaterThan(notImportedScore);
        });
        it('exact scope match gets very high score', () => {
            const exactMatch = (0, symbolUtils_1.computeAccessibilityScore)('mod', ['FIFO'], 'mod', [], ['FIFO']);
            const noMatch = (0, symbolUtils_1.computeAccessibilityScore)('mod', ['Queue'], 'mod', [], ['FIFO']);
            (0, chai_1.expect)(exactMatch).to.be.greaterThan(noMatch + 100);
        });
        it('common prefix adds incremental score', () => {
            const twoCommon = (0, symbolUtils_1.computeAccessibilityScore)(undefined, ['A', 'B', 'C'], undefined, [], ['A', 'B', 'X']);
            const oneCommon = (0, symbolUtils_1.computeAccessibilityScore)(undefined, ['A', 'Y', 'Z'], undefined, [], ['A', 'B', 'X']);
            (0, chai_1.expect)(twoCommon).to.be.greaterThan(oneCommon);
        });
    });
    describe('countCommonPrefix', () => {
        it('returns 0 for completely different arrays', () => {
            (0, chai_1.expect)((0, symbolUtils_1.countCommonPrefix)(['a', 'b'], ['x', 'y'])).to.equal(0);
        });
        it('counts matching prefix elements', () => {
            (0, chai_1.expect)((0, symbolUtils_1.countCommonPrefix)(['a', 'b', 'c'], ['a', 'b', 'x'])).to.equal(2);
        });
        it('handles empty arrays', () => {
            (0, chai_1.expect)((0, symbolUtils_1.countCommonPrefix)([], ['a'])).to.equal(0);
            (0, chai_1.expect)((0, symbolUtils_1.countCommonPrefix)(['a'], [])).to.equal(0);
        });
        it('counts full match', () => {
            (0, chai_1.expect)((0, symbolUtils_1.countCommonPrefix)(['a', 'b'], ['a', 'b'])).to.equal(2);
        });
    });
    describe('arraysEqual', () => {
        it('returns true for identical arrays', () => {
            (0, chai_1.expect)((0, symbolUtils_1.arraysEqual)(['a', 'b'], ['a', 'b'])).to.be.true;
        });
        it('returns false for different lengths', () => {
            (0, chai_1.expect)((0, symbolUtils_1.arraysEqual)(['a'], ['a', 'b'])).to.be.false;
        });
        it('returns false for different contents', () => {
            (0, chai_1.expect)((0, symbolUtils_1.arraysEqual)(['a', 'b'], ['a', 'x'])).to.be.false;
        });
        it('returns true for empty arrays', () => {
            (0, chai_1.expect)((0, symbolUtils_1.arraysEqual)([], [])).to.be.true;
        });
    });
    describe('createResolutionResult', () => {
        const scoreGetter = (item) => item.score;
        it('returns none confidence for empty candidates', () => {
            const result = (0, symbolUtils_1.createResolutionResult)([], scoreGetter);
            (0, chai_1.expect)(result.confidence).to.equal('none');
            (0, chai_1.expect)(result.primary).to.be.undefined;
            (0, chai_1.expect)(result.alternatives).to.have.lengthOf(0);
        });
        it('returns exact/high for single candidate', () => {
            const candidates = [{ name: 'a', score: 200 }];
            const result = (0, symbolUtils_1.createResolutionResult)(candidates, scoreGetter);
            (0, chai_1.expect)(result.confidence).to.be.oneOf(['exact', 'high']);
            (0, chai_1.expect)(result.primary.name).to.equal('a');
            (0, chai_1.expect)(result.totalCandidates).to.equal(1);
        });
        it('returns exact for large score gap with high primary', () => {
            const candidates = [
                { name: 'best', score: 200 },
                { name: 'worse', score: 100 }
            ];
            const result = (0, symbolUtils_1.createResolutionResult)(candidates, scoreGetter);
            (0, chai_1.expect)(result.confidence).to.equal('exact');
            (0, chai_1.expect)(result.primary.name).to.equal('best');
            (0, chai_1.expect)(result.alternatives).to.have.lengthOf(1);
        });
        it('returns low for tied candidates', () => {
            const candidates = [
                { name: 'a', score: 50 },
                { name: 'b', score: 50 }
            ];
            const result = (0, symbolUtils_1.createResolutionResult)(candidates, scoreGetter);
            (0, chai_1.expect)(result.confidence).to.equal('low');
        });
        it('lists all alternatives after primary', () => {
            const candidates = [
                { name: 'first', score: 100 },
                { name: 'second', score: 90 },
                { name: 'third', score: 80 }
            ];
            const result = (0, symbolUtils_1.createResolutionResult)(candidates, scoreGetter);
            (0, chai_1.expect)(result.alternatives).to.have.lengthOf(2);
            (0, chai_1.expect)(result.alternatives[0].name).to.equal('second');
            (0, chai_1.expect)(result.alternatives[1].name).to.equal('third');
        });
    });
});
//# sourceMappingURL=symbolUtils.test.js.map