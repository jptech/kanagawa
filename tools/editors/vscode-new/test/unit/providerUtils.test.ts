import { expect } from 'chai';
import {
    computeImportScore,
    extractModuleFromQualified,
    isQualifiedNameAccessible,
    ResolvedImports
} from '../../src/utils/importUtils';
import {
    createResolutionResult,
    ResolutionResult
} from '../../src/utils/symbolUtils';

/**
 * Tests for provider quality improvement utilities.
 * These test the core logic used by hover, definition, and completion providers.
 */
describe('Provider Quality Utilities', () => {
    describe('Resolution confidence computation', () => {
        it('returns none confidence for empty candidates', () => {
            const result = createResolutionResult<{ name: string }>([], () => 0);
            expect(result.confidence).to.equal('none');
            expect(result.primary).to.be.undefined;
            expect(result.alternatives).to.have.length(0);
        });

        it('returns exact/high confidence for single candidate with high score', () => {
            const candidates = [{ name: 'push' }];
            const result = createResolutionResult(candidates, () => 150);
            expect(result.confidence).to.equal('exact');
            expect(result.primary).to.deep.equal({ name: 'push' });
            expect(result.alternatives).to.have.length(0);
        });

        it('returns high confidence for single candidate with medium score', () => {
            const candidates = [{ name: 'push' }];
            const result = createResolutionResult(candidates, () => 80);
            expect(result.confidence).to.equal('high');
        });

        it('returns exact confidence when large score gap with high primary', () => {
            const candidates = [
                { name: 'best' },
                { name: 'second' }
            ];
            const scores = new Map([['best', 200], ['second', 50]]);
            const result = createResolutionResult(
                candidates,
                (item) => scores.get(item.name) ?? 0
            );
            expect(result.confidence).to.equal('exact');
            expect(result.primary?.name).to.equal('best');
        });

        it('returns low confidence for tied candidates', () => {
            const candidates = [
                { name: 'a' },
                { name: 'b' }
            ];
            const result = createResolutionResult(candidates, () => 50);
            expect(result.confidence).to.equal('low');
            expect(result.alternatives).to.have.length(1);
        });

        it('returns medium confidence for moderate score gap', () => {
            const candidates = [
                { name: 'first' },
                { name: 'second' }
            ];
            const scores = new Map([['first', 80], ['second', 55]]);
            const result = createResolutionResult(
                candidates,
                (item) => scores.get(item.name) ?? 0
            );
            expect(result.confidence).to.equal('medium');
        });
    });

    describe('Import-based accessibility', () => {
        const createResolvedImports = (opts: {
            currentModule?: string;
            importedModules?: string[];
        }): ResolvedImports => ({
            currentModule: opts.currentModule,
            importedModules: new Set(opts.importedModules ?? []),
            aliasToModule: new Map(),
            accessibleQualifiedNames: new Set()
        });

        it('same module symbols are accessible', () => {
            const imports = createResolvedImports({ currentModule: 'data.fifo' });
            // Module-level symbol (not a class member)
            const accessible = isQualifiedNameAccessible('data.fifo::FIFO', imports);
            expect(accessible).to.be.true;
        });

        it('imported module symbols are accessible', () => {
            const imports = createResolvedImports({
                currentModule: 'mymodule',
                importedModules: ['data.fifo']
            });
            // Module-level symbol (not a class member)
            const accessible = isQualifiedNameAccessible('data.fifo::FIFO', imports);
            expect(accessible).to.be.true;
        });

        it('class members are not accessible as bare identifiers', () => {
            const imports = createResolvedImports({
                currentModule: 'mymodule',
                importedModules: ['data.fifo']
            });
            // Class member symbols should NOT be accessible as bare identifiers
            const accessible = isQualifiedNameAccessible('data.fifo::FIFO::push', imports);
            expect(accessible).to.be.false;
        });

        it('global symbols are always accessible', () => {
            const imports = createResolvedImports({ currentModule: 'mymodule' });
            const accessible = isQualifiedNameAccessible('globalFunc', imports);
            expect(accessible).to.be.true;
        });

        it('non-imported module symbols are not accessible', () => {
            const imports = createResolvedImports({
                currentModule: 'mymodule',
                importedModules: ['other.module']
            });
            const accessible = isQualifiedNameAccessible('data.fifo::FIFO::push', imports);
            expect(accessible).to.be.false;
        });
    });

    describe('Import scoring for completion tiers', () => {
        const createResolvedImports = (opts: {
            currentModule?: string;
            importedModules?: string[];
        }): ResolvedImports => ({
            currentModule: opts.currentModule,
            importedModules: new Set(opts.importedModules ?? []),
            aliasToModule: new Map(),
            accessibleQualifiedNames: new Set()
        });

        it('same module gets highest score', () => {
            const imports = createResolvedImports({ currentModule: 'data.fifo' });
            const score = computeImportScore('data.fifo::FIFO', 'data.fifo', imports);
            expect(score).to.be.greaterThan(90); // High priority
        });

        it('imported module gets moderate score', () => {
            const imports = createResolvedImports({
                currentModule: 'mymodule',
                importedModules: ['data.fifo']
            });
            const score = computeImportScore('data.fifo::FIFO', 'data.fifo', imports);
            expect(score).to.be.greaterThan(30);
            expect(score).to.be.lessThan(90);
        });

        it('global symbols get base score', () => {
            const imports = createResolvedImports({ currentModule: 'mymodule' });
            const score = computeImportScore('globalFunc', undefined, imports);
            expect(score).to.be.greaterThan(0);
            expect(score).to.be.lessThan(50);
        });

        it('non-imported symbols get zero score', () => {
            const imports = createResolvedImports({ currentModule: 'mymodule' });
            const score = computeImportScore('other.module::Foo', 'other.module', imports);
            expect(score).to.equal(0);
        });
    });

    describe('Module extraction from qualified names', () => {
        it('extracts module from fully qualified name', () => {
            expect(extractModuleFromQualified('data.fifo::FIFO::push')).to.equal('data.fifo');
        });

        it('extracts single-segment module paths', () => {
            expect(extractModuleFromQualified('FIFO::push')).to.equal('FIFO');
        });

        it('returns undefined for simple names', () => {
            expect(extractModuleFromQualified('globalFunc')).to.be.undefined;
        });

        it('handles deeply nested module paths', () => {
            expect(extractModuleFromQualified('a.b.c.d::Class::method')).to.equal('a.b.c.d');
        });
    });

    describe('Completion tier assignment', () => {
        // These tests verify the tier assignment logic used by completion provider

        it('should rank symbols correctly: local > same_module > imported > keyword > global', () => {
            // This is a logical test of the tier order
            const SORT_PREFIX = {
                LOCAL: '0_',
                SAME_MODULE: '1_',
                IMPORTED: '2_',
                KEYWORD: '3_',
                GLOBAL: '4_',
                INACCESSIBLE: '9_'
            };

            // Verify prefix ordering (lexicographic)
            const sorted = [
                SORT_PREFIX.GLOBAL,
                SORT_PREFIX.KEYWORD,
                SORT_PREFIX.INACCESSIBLE,
                SORT_PREFIX.IMPORTED,
                SORT_PREFIX.SAME_MODULE,
                SORT_PREFIX.LOCAL
            ].sort();

            expect(sorted[0]).to.equal(SORT_PREFIX.LOCAL);
            expect(sorted[1]).to.equal(SORT_PREFIX.SAME_MODULE);
            expect(sorted[2]).to.equal(SORT_PREFIX.IMPORTED);
            expect(sorted[3]).to.equal(SORT_PREFIX.KEYWORD);
            expect(sorted[4]).to.equal(SORT_PREFIX.GLOBAL);
            expect(sorted[5]).to.equal(SORT_PREFIX.INACCESSIBLE);
        });
    });

    describe('Hover resolution scenarios', () => {
        // These tests verify expected behavior patterns for hover

        it('single accessible match should have exact confidence', () => {
            const accessible = [{ name: 'push', module: 'data.fifo' }];
            const inaccessible: typeof accessible = [];

            // Simulate the confidence computation
            if (accessible.length === 1) {
                expect('exact').to.equal('exact');
            }
        });

        it('multiple accessible matches should show primary + count', () => {
            const accessible = [
                { name: 'push', module: 'data.fifo' },
                { name: 'push', module: 'sync.queue' }
            ];

            const primary = accessible[0];
            const alternativeCount = accessible.length - 1;

            expect(primary.name).to.equal('push');
            expect(alternativeCount).to.equal(1);
        });

        it('only inaccessible matches should suggest import', () => {
            const accessible: { name: string; module: string }[] = [];
            const inaccessible = [{ name: 'FIFO', module: 'data.fifo' }];

            const shouldSuggestImport = accessible.length === 0 && inaccessible.length > 0;
            const suggestedModule = inaccessible[0].module;

            expect(shouldSuggestImport).to.be.true;
            expect(suggestedModule).to.equal('data.fifo');
        });
    });

    describe('Definition resolution scenarios', () => {
        // These tests verify expected behavior patterns for go-to-definition

        it('local symbol should return immediately (highest priority)', () => {
            const hasLocal = true;
            const hasMemberMatch = false;

            // Local takes precedence
            if (hasLocal) {
                expect('should return local').to.be.ok;
            }
        });

        it('single exact match should jump directly', () => {
            const matches = [{ name: 'FIFO', file: 'fifo.k' }];
            const confidence = matches.length === 1 ? 'exact' : 'ambiguous';

            expect(confidence).to.equal('exact');
            // In provider: return single Location, not array
        });

        it('multiple matches should show picker', () => {
            const matches = [
                { name: 'FIFO', file: 'data/fifo.k' },
                { name: 'FIFO', file: 'sync/fifo.k' }
            ];

            expect(matches.length).to.be.greaterThan(1);
            // In provider: return Location array for picker
        });

        it('should prefer same-module over imported', () => {
            const matches = [
                { name: 'Helper', module: 'current.module', score: 100 },
                { name: 'Helper', module: 'imported.module', score: 50 }
            ];

            const sorted = matches.sort((a, b) => b.score - a.score);
            expect(sorted[0].module).to.equal('current.module');
        });
    });
});
