import { expect } from 'chai';
import {
    normalizeModulePath,
    matchesImportPath,
    extractModuleFromQualified,
    extractContainerPath,
    resolveImports,
    isQualifiedNameAccessible,
    computeImportScore,
    filterByAccessibility,
    isClassMember,
    ModuleExports
} from '../../src/utils/importUtils';

describe('Import Utilities', () => {
    describe('normalizeModulePath', () => {
        it('removes leading and trailing dots', () => {
            expect(normalizeModulePath('.data.fifo.')).to.equal('data.fifo');
        });

        it('trims whitespace', () => {
            expect(normalizeModulePath('  data.fifo  ')).to.equal('data.fifo');
        });

        it('returns empty string for only dots', () => {
            expect(normalizeModulePath('...')).to.equal('');
        });

        it('handles normal paths unchanged', () => {
            expect(normalizeModulePath('data.fifo')).to.equal('data.fifo');
        });
    });

    describe('isClassMember', () => {
        it('returns false for module-level symbols', () => {
            // module::Type is at module level, not a class member
            expect(isClassMember('data.fifo::FIFO')).to.be.false;
            expect(isClassMember('base::count_t')).to.be.false;
            expect(isClassMember('control.flow::Pipeline')).to.be.false;
        });

        it('returns true for class member symbols with module path', () => {
            // module::Type::member is a class member
            expect(isClassMember('data.fifo::FIFO::push')).to.be.true;
            expect(isClassMember('data.counter.saturating::saturating_counter::count_t')).to.be.true;
        });

        it('returns true for deeply nested members', () => {
            expect(isClassMember('module.path::Class::Inner::method')).to.be.true;
        });

        it('returns false for two-part qualified names', () => {
            // module::Symbol or Type::member (ambiguous) is NOT treated as a class member.
            // Class members require 3+ segments: module::Type::member.
            expect(isClassMember('FIFO::push')).to.be.false;
            expect(isClassMember('saturating_counter::count_t')).to.be.false;
        });

        it('returns false for simple names', () => {
            expect(isClassMember('count_t')).to.be.false;
            expect(isClassMember('FIFO')).to.be.false;
        });
    });

    describe('matchesImportPath', () => {
        it('matches exact paths', () => {
            expect(matchesImportPath('data.fifo', 'data.fifo')).to.be.true;
        });

        it('matches suffix imports', () => {
            // User imports "fifo", should match module "data.fifo"
            expect(matchesImportPath('data.fifo', 'fifo')).to.be.true;
        });

        it('matches specific symbol imports', () => {
            // User imports "data.fifo.FIFO", should match module "data.fifo"
            expect(matchesImportPath('data.fifo', 'data.fifo.FIFO')).to.be.true;
        });

        it('does not match unrelated paths', () => {
            expect(matchesImportPath('data.fifo', 'control.flow')).to.be.false;
        });

        it('does not match partial segment matches', () => {
            // "fifo" should not match "data.fifos" (different segment)
            expect(matchesImportPath('data.fifos', 'fifo')).to.be.false;
        });

        it('handles single-segment modules', () => {
            expect(matchesImportPath('base', 'base')).to.be.true;
            expect(matchesImportPath('base', 'other')).to.be.false;
        });
    });

    describe('extractModuleFromQualified', () => {
        it('extracts module from full qualified name', () => {
            expect(extractModuleFromQualified('data.fifo::FIFO::push')).to.equal('data.fifo');
        });

        it('extracts single-segment module paths', () => {
            expect(extractModuleFromQualified('FIFO::push')).to.equal('FIFO');
            expect(extractModuleFromQualified('base::uint32')).to.equal('base');
        });

        it('returns undefined for simple names', () => {
            expect(extractModuleFromQualified('helper')).to.be.undefined;
        });

        it('handles module-only qualified names', () => {
            expect(extractModuleFromQualified('data.fifo::FIFO')).to.equal('data.fifo');
        });
    });

    describe('extractContainerPath', () => {
        it('extracts container from method', () => {
            expect(extractContainerPath('data.fifo::FIFO::push')).to.equal('data.fifo::FIFO');
        });

        it('extracts container from type in module', () => {
            expect(extractContainerPath('data.fifo::FIFO')).to.equal('data.fifo');
        });

        it('returns undefined for top-level names', () => {
            expect(extractContainerPath('FIFO')).to.be.undefined;
        });

        it('handles nested containers', () => {
            expect(extractContainerPath('a::b::c::d')).to.equal('a::b::c');
        });
    });

    describe('resolveImports', () => {
        const moduleExportsMap = new Map<string, ModuleExports>([
            ['data.fifo', {
                modulePath: 'data.fifo',
                exportedSymbols: new Set(['data.fifo::FIFO', 'data.fifo::FIFO::push', 'data.fifo::FIFO::pop']),
                exportedNames: new Set(['FIFO', 'push', 'pop']),
                explicitExports: new Set(['FIFO', 'push', 'pop']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['data.stack', {
                modulePath: 'data.stack',
                exportedSymbols: new Set(['data.stack::Stack', 'data.stack::Stack::push']),
                exportedNames: new Set(['Stack', 'push']),
                explicitExports: new Set(['Stack', 'push']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['control.flow', {
                modulePath: 'control.flow',
                exportedSymbols: new Set(['control.flow::Pipeline']),
                exportedNames: new Set(['Pipeline']),
                explicitExports: new Set(['Pipeline']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }]
        ]);

        it('includes current module symbols', () => {
            const result = resolveImports('data.fifo', [], moduleExportsMap);
            expect(result.currentModule).to.equal('data.fifo');
            expect(result.accessibleQualifiedNames.has('data.fifo::FIFO')).to.be.true;
        });

        it('includes imported module symbols', () => {
            const result = resolveImports('mymodule', [{ path: 'data.fifo' }], moduleExportsMap);
            expect(result.importedModules.has('data.fifo')).to.be.true;
            expect(result.accessibleQualifiedNames.has('data.fifo::FIFO::push')).to.be.true;
        });

        it('tracks aliases', () => {
            const result = resolveImports('mymodule', [{ path: 'data.fifo', alias: 'df' }], moduleExportsMap);
            expect(result.aliasToModule.get('df')).to.equal('data.fifo');
        });

        it('handles suffix imports', () => {
            const result = resolveImports('mymodule', [{ path: 'fifo' }], moduleExportsMap);
            expect(result.importedModules.has('data.fifo')).to.be.true;
        });

        it('handles multiple imports', () => {
            const result = resolveImports('mymodule', [
                { path: 'data.fifo' },
                { path: 'control.flow' }
            ], moduleExportsMap);
            expect(result.importedModules.has('data.fifo')).to.be.true;
            expect(result.importedModules.has('control.flow')).to.be.true;
        });
    });

    describe('isQualifiedNameAccessible', () => {
        const resolved = {
            currentModule: 'mymodule',
            importedModules: new Set(['data.fifo']),
            aliasToModule: new Map<string, string>(),
            accessibleQualifiedNames: new Set(['data.fifo::FIFO', 'mymodule::Helper'])
        };

        it('returns true for directly accessible names', () => {
            expect(isQualifiedNameAccessible('data.fifo::FIFO', resolved)).to.be.true;
        });

        it('returns true for current module names', () => {
            expect(isQualifiedNameAccessible('mymodule::Helper', resolved)).to.be.true;
        });

        it('returns true for names in imported modules', () => {
            // Even if not in accessibleQualifiedNames, if module is imported
            expect(isQualifiedNameAccessible('data.fifo::SomethingElse', resolved)).to.be.true;
        });

        it('returns true for global scope names', () => {
            expect(isQualifiedNameAccessible('GlobalHelper', resolved)).to.be.true;
        });

        it('returns false for non-imported module names', () => {
            expect(isQualifiedNameAccessible('control.flow::Pipeline', resolved)).to.be.false;
        });

        it('returns false for class members as bare identifiers', () => {
            // Class members should NOT be accessible as bare identifiers
            // Even if the module is imported, the member is inside a class
            expect(isQualifiedNameAccessible('data.fifo::FIFO::push', resolved)).to.be.false;
            expect(isQualifiedNameAccessible('data.counter.saturating::saturating_counter::count_t', resolved)).to.be.false;
        });

        it('returns true for class members when forBareIdentifier is false', () => {
            // When explicitly accessing via qualified syntax, class members should be accessible
            expect(isQualifiedNameAccessible('data.fifo::FIFO::push', resolved, { forBareIdentifier: false })).to.be.true;
        });
    });

    describe('computeImportScore', () => {
        const resolved = {
            currentModule: 'mymodule',
            importedModules: new Set(['data.fifo']),
            aliasToModule: new Map<string, string>(),
            accessibleQualifiedNames: new Set(['data.fifo::FIFO'])
        };

        it('gives highest score to same module', () => {
            const score = computeImportScore('mymodule::Helper', 'mymodule', resolved);
            expect(score).to.be.greaterThan(80);
        });

        it('gives good score to directly accessible', () => {
            const score = computeImportScore('data.fifo::FIFO', 'data.fifo', resolved);
            expect(score).to.be.greaterThan(40);
        });

        it('gives moderate score to imported modules', () => {
            const score = computeImportScore('data.fifo::Other', 'data.fifo', resolved);
            expect(score).to.be.greaterThan(30);
        });

        it('gives base score to global symbols', () => {
            const score = computeImportScore('GlobalFunc', undefined, resolved);
            expect(score).to.be.greaterThan(10);
        });

        it('gives zero to non-imported modules', () => {
            const score = computeImportScore('control.flow::Pipeline', 'control.flow', resolved);
            expect(score).to.equal(0);
        });

        it('gives zero to class members (not accessible as bare identifiers)', () => {
            // Class members should get zero score since they can't be resolved bare
            const score = computeImportScore('data.fifo::FIFO::push', 'data.fifo', resolved);
            expect(score).to.equal(0);
        });
    });

    describe('filterByAccessibility', () => {
        const resolved = {
            currentModule: 'mymodule',
            importedModules: new Set(['data.fifo']),
            aliasToModule: new Map<string, string>(),
            accessibleQualifiedNames: new Set(['data.fifo::FIFO', 'mymodule::Helper'])
        };

        const symbols = [
            { qualifiedName: 'control.flow::Pipeline', scopePath: ['control.flow'] },
            { qualifiedName: 'data.fifo::FIFO', scopePath: ['data.fifo'] },
            { qualifiedName: 'mymodule::Helper', scopePath: ['mymodule'] },
            { qualifiedName: 'GlobalFunc', scopePath: [] }
        ];

        it('filters out inaccessible symbols by default', () => {
            const result = filterByAccessibility(symbols, resolved);
            const names = result.map(s => s.qualifiedName);
            expect(names).to.not.include('control.flow::Pipeline');
        });

        it('keeps accessible symbols', () => {
            const result = filterByAccessibility(symbols, resolved);
            const names = result.map(s => s.qualifiedName);
            expect(names).to.include('data.fifo::FIFO');
            expect(names).to.include('mymodule::Helper');
            expect(names).to.include('GlobalFunc');
        });

        it('sorts by accessibility score', () => {
            const result = filterByAccessibility(symbols, resolved);
            // mymodule::Helper should be first (same module = 100 points)
            // data.fifo::FIFO second (imported module 40 + accessible 50 = 90)
            expect(result[0].qualifiedName).to.equal('mymodule::Helper');
            expect(result[1].qualifiedName).to.equal('data.fifo::FIFO');
        });

        it('includes inaccessible when requested', () => {
            const result = filterByAccessibility(symbols, resolved, { includeInaccessible: true });
            const names = result.map(s => s.qualifiedName);
            expect(names).to.include('control.flow::Pipeline');
        });

        it('filters out class members even from imported modules', () => {
            // This is the key test for the bug fix:
            // saturating_counter::count_t should NOT resolve when looking for count_t
            const symbolsWithMember = [
                { qualifiedName: 'base::count_t', scopePath: ['base'] }, // Module-level, should be accessible
                { qualifiedName: 'data.counter.saturating::saturating_counter::count_t', scopePath: ['data.counter.saturating', 'saturating_counter'] } // Class member, should be filtered
            ];
            
            const resolvedWithBase = {
                currentModule: 'mymodule',
                importedModules: new Set(['base', 'data.counter.saturating']),
                aliasToModule: new Map<string, string>(),
                accessibleQualifiedNames: new Set(['base::count_t'])
            };

            const result = filterByAccessibility(symbolsWithMember, resolvedWithBase);
            const names = result.map(s => s.qualifiedName);
            
            // Should keep base::count_t (module-level export)
            expect(names).to.include('base::count_t');
            // Should NOT include the class member, even though module is imported
            expect(names).to.not.include('data.counter.saturating::saturating_counter::count_t');
        });
    });
});
