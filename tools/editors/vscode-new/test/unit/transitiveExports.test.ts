import { expect } from 'chai';
import {
    ModuleExports,
    createEmptyModuleExports,
    resolveTransitiveExports,
    resolveImportsWithTransitives,
    isSymbolStrictlyAccessible,
    suggestImportsForSymbol,
    isClassMember,
    isClassMemberFromScopePath,
    filterByAccessibility,
    ResolvedImports
} from '../../src/utils/importUtils';
import { DocumentImport } from '../../src/service/IWorkspaceIndexer';

describe('Transitive Export Resolution', () => {
    describe('createEmptyModuleExports', () => {
        it('creates a module exports object with empty collections', () => {
            const exports = createEmptyModuleExports('data.fifo');
            
            expect(exports.modulePath).to.equal('data.fifo');
            expect(exports.exportedSymbols.size).to.equal(0);
            expect(exports.exportedNames.size).to.equal(0);
            expect(exports.explicitExports?.size).to.equal(0);
            expect(exports.reExportedModules?.size).to.equal(0);
            expect(exports.moduleDifferences?.size).to.equal(0);
        });
    });

    describe('resolveTransitiveExports', () => {
        it('resolves direct exports from a module', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['data.fifo', {
                    modulePath: 'data.fifo',
                    exportedSymbols: new Set(['data.fifo::FIFO', 'data.fifo::push']),
                    exportedNames: new Set(['FIFO', 'push']),
                    explicitExports: new Set(['FIFO', 'push']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }]
            ]);

            const result = resolveTransitiveExports('data.fifo', moduleExportsMap);
            
            expect(result.has('data.fifo::FIFO')).to.be.true;
            expect(result.has('data.fifo::push')).to.be.true;
            expect(result.size).to.equal(2);
        });

        it('resolves single-level re-exports', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['base', {
                    modulePath: 'base',
                    exportedSymbols: new Set(['base::uint32', 'base::int32']),
                    exportedNames: new Set(['uint32', 'int32']),
                    explicitExports: new Set(['uint32', 'int32']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['wrapper', {
                    modulePath: 'wrapper',
                    exportedSymbols: new Set(['wrapper::Helper']),
                    exportedNames: new Set(['Helper']),
                    explicitExports: new Set(['Helper']),
                    reExportedModules: new Set(['base']),
                    moduleDifferences: new Map()
                }]
            ]);

            const result = resolveTransitiveExports('wrapper', moduleExportsMap);
            
            // Direct export
            expect(result.has('wrapper::Helper')).to.be.true;
            // Re-exported from base
            expect(result.has('base::uint32')).to.be.true;
            expect(result.has('base::int32')).to.be.true;
            expect(result.size).to.equal(3);
        });

        it('resolves multi-level transitive re-exports', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['level0', {
                    modulePath: 'level0',
                    exportedSymbols: new Set(['level0::Core']),
                    exportedNames: new Set(['Core']),
                    explicitExports: new Set(['Core']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['level1', {
                    modulePath: 'level1',
                    exportedSymbols: new Set(['level1::Middle']),
                    exportedNames: new Set(['Middle']),
                    explicitExports: new Set(['Middle']),
                    reExportedModules: new Set(['level0']),
                    moduleDifferences: new Map()
                }],
                ['level2', {
                    modulePath: 'level2',
                    exportedSymbols: new Set(['level2::Top']),
                    exportedNames: new Set(['Top']),
                    explicitExports: new Set(['Top']),
                    reExportedModules: new Set(['level1']),
                    moduleDifferences: new Map()
                }]
            ]);

            const result = resolveTransitiveExports('level2', moduleExportsMap);
            
            expect(result.has('level2::Top')).to.be.true;
            expect(result.has('level1::Middle')).to.be.true;
            expect(result.has('level0::Core')).to.be.true;
            expect(result.size).to.equal(3);
        });

        it('detects and handles cycles', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['moduleA', {
                    modulePath: 'moduleA',
                    exportedSymbols: new Set(['moduleA::SymA']),
                    exportedNames: new Set(['SymA']),
                    explicitExports: new Set(['SymA']),
                    reExportedModules: new Set(['moduleB']),
                    moduleDifferences: new Map()
                }],
                ['moduleB', {
                    modulePath: 'moduleB',
                    exportedSymbols: new Set(['moduleB::SymB']),
                    exportedNames: new Set(['SymB']),
                    explicitExports: new Set(['SymB']),
                    reExportedModules: new Set(['moduleA']), // Cycle back to A
                    moduleDifferences: new Map()
                }]
            ]);

            // Should not throw or hang
            const result = resolveTransitiveExports('moduleA', moduleExportsMap);
            
            expect(result.has('moduleA::SymA')).to.be.true;
            expect(result.has('moduleB::SymB')).to.be.true;
            expect(result.size).to.equal(2);
        });

        it('handles self-referential modules', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['self.ref', {
                    modulePath: 'self.ref',
                    exportedSymbols: new Set(['self.ref::Symbol']),
                    exportedNames: new Set(['Symbol']),
                    explicitExports: new Set(['Symbol']),
                    reExportedModules: new Set(['self.ref']), // Self-reference
                    moduleDifferences: new Map()
                }]
            ]);

            const result = resolveTransitiveExports('self.ref', moduleExportsMap);
            
            expect(result.has('self.ref::Symbol')).to.be.true;
            expect(result.size).to.equal(1);
        });

        it('handles module differences (exclusions)', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['params', {
                    modulePath: 'params',
                    exportedSymbols: new Set(['params::Config', 'params::Debug', 'params::Release']),
                    exportedNames: new Set(['Config', 'Debug', 'Release']),
                    explicitExports: new Set(['Config', 'Debug', 'Release']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['params.cmdargs', {
                    modulePath: 'params.cmdargs',
                    exportedSymbols: new Set(['params::Debug']), // Only Debug in cmdargs
                    exportedNames: new Set(['Debug']),
                    explicitExports: new Set(['Debug']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['clean', {
                    modulePath: 'clean',
                    exportedSymbols: new Set(),
                    exportedNames: new Set(),
                    explicitExports: new Set(),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map([['params', 'params.cmdargs']])
                }]
            ]);

            const result = resolveTransitiveExports('clean', moduleExportsMap);
            
            // Should have params exports minus params.cmdargs exports
            expect(result.has('params::Config')).to.be.true;
            expect(result.has('params::Release')).to.be.true;
            expect(result.has('params::Debug')).to.be.false; // Excluded by difference
            expect(result.size).to.equal(2);
        });

        it('returns empty set for unknown module', () => {
            const moduleExportsMap = new Map<string, ModuleExports>();
            const result = resolveTransitiveExports('unknown.module', moduleExportsMap);
            
            expect(result.size).to.equal(0);
        });

        it('handles suffix matching for re-exports', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['data.fifo', {
                    modulePath: 'data.fifo',
                    exportedSymbols: new Set(['data.fifo::FIFO']),
                    exportedNames: new Set(['FIFO']),
                    explicitExports: new Set(['FIFO']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['wrapper', {
                    modulePath: 'wrapper',
                    exportedSymbols: new Set(),
                    exportedNames: new Set(),
                    explicitExports: new Set(),
                    reExportedModules: new Set(['fifo']), // Suffix import
                    moduleDifferences: new Map()
                }]
            ]);

            const result = resolveTransitiveExports('wrapper', moduleExportsMap);
            
            expect(result.has('data.fifo::FIFO')).to.be.true;
        });
    });

    describe('resolveImportsWithTransitives', () => {
        const createTestModuleMap = () => new Map<string, ModuleExports>([
            ['base', {
                modulePath: 'base',
                exportedSymbols: new Set(['base::uint32', 'base::int32', 'base::string']),
                exportedNames: new Set(['uint32', 'int32', 'string']),
                explicitExports: new Set(['uint32', 'int32', 'string']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['data.fifo', {
                modulePath: 'data.fifo',
                exportedSymbols: new Set(['data.fifo::FIFO', 'data.fifo::CircularBuffer']),
                exportedNames: new Set(['FIFO', 'CircularBuffer']),
                explicitExports: new Set(['FIFO', 'CircularBuffer']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['utils.math', {
                modulePath: 'utils.math',
                exportedSymbols: new Set(['utils.math::abs', 'utils.math::max']),
                exportedNames: new Set(['abs', 'max']),
                explicitExports: new Set(['abs', 'max']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }]
        ]);

        it('includes implicit base import by default', () => {
            const moduleExportsMap = createTestModuleMap();
            const imports: DocumentImport[] = [
                { path: 'data.fifo' }
            ];

            const result = resolveImportsWithTransitives('mymodule', imports, moduleExportsMap);
            
            expect(result.importedModules.has('base')).to.be.true;
            expect(result.accessibleQualifiedNames.has('base::uint32')).to.be.true;
        });

        it('excludes implicit base when disabled', () => {
            const moduleExportsMap = createTestModuleMap();
            const imports: DocumentImport[] = [
                { path: 'data.fifo' }
            ];

            const result = resolveImportsWithTransitives(
                'mymodule',
                imports,
                moduleExportsMap,
                { includeImplicitBase: false }
            );
            
            expect(result.importedModules.has('base')).to.be.false;
            expect(result.accessibleQualifiedNames.has('base::uint32')).to.be.false;
        });

        it('does not duplicate base if explicitly imported', () => {
            const moduleExportsMap = createTestModuleMap();
            const imports: DocumentImport[] = [
                { path: 'base' },
                { path: 'data.fifo' }
            ];

            const result = resolveImportsWithTransitives('mymodule', imports, moduleExportsMap);
            
            // Should still work, just not add base twice
            expect(result.importedModules.has('base')).to.be.true;
            expect(result.accessibleQualifiedNames.has('base::uint32')).to.be.true;
        });

        it('resolves multiple imports', () => {
            const moduleExportsMap = createTestModuleMap();
            const imports: DocumentImport[] = [
                { path: 'data.fifo' },
                { path: 'utils.math' }
            ];

            const result = resolveImportsWithTransitives(
                'mymodule',
                imports,
                moduleExportsMap,
                { includeImplicitBase: false }
            );
            
            expect(result.importedModules.has('data.fifo')).to.be.true;
            expect(result.importedModules.has('utils.math')).to.be.true;
            expect(result.accessibleQualifiedNames.has('data.fifo::FIFO')).to.be.true;
            expect(result.accessibleQualifiedNames.has('utils.math::abs')).to.be.true;
        });

        it('handles aliases correctly', () => {
            const moduleExportsMap = createTestModuleMap();
            const imports: DocumentImport[] = [
                { path: 'data.fifo', alias: 'fifo' }
            ];

            const result = resolveImportsWithTransitives(
                'mymodule',
                imports,
                moduleExportsMap,
                { includeImplicitBase: false }
            );
            
            expect(result.aliasToModule.get('fifo')).to.equal('data.fifo');
        });

        it('includes current module exports as accessible', () => {
            const moduleExportsMap = createTestModuleMap();
            moduleExportsMap.set('mymodule', {
                modulePath: 'mymodule',
                exportedSymbols: new Set(['mymodule::MyClass']),
                exportedNames: new Set(['MyClass']),
                explicitExports: new Set(['MyClass']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            });

            const result = resolveImportsWithTransitives(
                'mymodule',
                [],
                moduleExportsMap,
                { includeImplicitBase: false }
            );
            
            expect(result.currentModule).to.equal('mymodule');
            expect(result.accessibleQualifiedNames.has('mymodule::MyClass')).to.be.true;
        });

        it('handles suffix imports', () => {
            const moduleExportsMap = createTestModuleMap();
            const imports: DocumentImport[] = [
                { path: 'fifo' } // Suffix of data.fifo
            ];

            const result = resolveImportsWithTransitives(
                'mymodule',
                imports,
                moduleExportsMap,
                { includeImplicitBase: false }
            );
            
            expect(result.importedModules.has('data.fifo')).to.be.true;
            expect(result.accessibleQualifiedNames.has('data.fifo::FIFO')).to.be.true;
        });
    });

    describe('isSymbolStrictlyAccessible', () => {
        const createTestResolvedImports = (): ResolvedImports => ({
            currentModule: 'mymodule',
            importedModules: new Set(['data.fifo', 'base']),
            aliasToModule: new Map([['fifo', 'data.fifo']]),
            accessibleQualifiedNames: new Set([
                'mymodule::Helper',
                'data.fifo::FIFO',
                'base::uint32'
            ])
        });

        it('returns true for symbols in accessibleQualifiedNames', () => {
            const resolved = createTestResolvedImports();
            
            expect(isSymbolStrictlyAccessible('data.fifo::FIFO', resolved)).to.be.true;
            expect(isSymbolStrictlyAccessible('base::uint32', resolved)).to.be.true;
        });

        it('returns true for current module symbols', () => {
            const resolved = createTestResolvedImports();
            
            expect(isSymbolStrictlyAccessible('mymodule::Helper', resolved)).to.be.true;
            expect(isSymbolStrictlyAccessible('mymodule::OtherSymbol', resolved)).to.be.true;
        });

        it('returns true for symbols in imported modules', () => {
            const resolved = createTestResolvedImports();
            
            // Even if not in accessibleQualifiedNames, should be accessible if module is imported
            expect(isSymbolStrictlyAccessible('data.fifo::CircularBuffer', resolved)).to.be.true;
            // Single-segment module names should also work (e.g., implicit `base`)
            expect(isSymbolStrictlyAccessible('base::size_t', resolved)).to.be.true;
        });

        it('returns true for global symbols (no module)', () => {
            const resolved = createTestResolvedImports();
            
            expect(isSymbolStrictlyAccessible('GlobalFunction', resolved)).to.be.true;
            expect(isSymbolStrictlyAccessible('printf', resolved)).to.be.true;
        });

        it('returns false for non-imported module symbols', () => {
            const resolved = createTestResolvedImports();
            
            expect(isSymbolStrictlyAccessible('control.flow::Pipeline', resolved)).to.be.false;
            expect(isSymbolStrictlyAccessible('utils.math::abs', resolved)).to.be.false;
            // Single-segment module name should not be treated as global
            expect(isSymbolStrictlyAccessible('counter::count_t', resolved)).to.be.false;
        });

        it('handles empty resolved imports', () => {
            const resolved: ResolvedImports = {
                currentModule: undefined,
                importedModules: new Set(),
                aliasToModule: new Map(),
                accessibleQualifiedNames: new Set()
            };
            
            // Global symbols still accessible
            expect(isSymbolStrictlyAccessible('GlobalFunc', resolved)).to.be.true;
            
            // Module symbols not accessible
            expect(isSymbolStrictlyAccessible('data.fifo::FIFO', resolved)).to.be.false;
        });

        it('returns false for class members as bare identifiers', () => {
            const resolved = createTestResolvedImports();
            
            // Class members should NOT be accessible as bare identifiers
            // This is the key fix for the saturating_counter::count_t bug
            expect(isSymbolStrictlyAccessible('data.fifo::FIFO::push', resolved)).to.be.false;
            expect(isSymbolStrictlyAccessible('data.counter.saturating::saturating_counter::count_t', resolved)).to.be.false;
            // Also handle single-segment module paths (e.g., "counter::Type::member")
            expect(isSymbolStrictlyAccessible('counter::saturating_counter::count_t', resolved)).to.be.false;
        });

        it('returns true for class members when forBareIdentifier is false', () => {
            const resolved = createTestResolvedImports();
            // For qualified access, members are accessible, but the containing module still
            // needs to be in the import closure.
            const resolvedWithCounter: ResolvedImports = {
                ...resolved,
                importedModules: new Set([...resolved.importedModules, 'counter'])
            };
            
            // When accessing via qualified syntax (e.g., FIFO::push), members should be accessible
            expect(isSymbolStrictlyAccessible('data.fifo::FIFO::push', resolved, { forBareIdentifier: false })).to.be.true;
            expect(isSymbolStrictlyAccessible('counter::saturating_counter::count_t', resolvedWithCounter, { forBareIdentifier: false })).to.be.true;
        });
    });

    describe('suggestImportsForSymbol', () => {
        it('suggests modules that directly export the symbol', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['data.fifo', {
                    modulePath: 'data.fifo',
                    exportedSymbols: new Set(['data.fifo::FIFO']),
                    exportedNames: new Set(['FIFO']),
                    explicitExports: new Set(['FIFO']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['utils.math', {
                    modulePath: 'utils.math',
                    exportedSymbols: new Set(['utils.math::abs']),
                    exportedNames: new Set(['abs']),
                    explicitExports: new Set(['abs']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }]
            ]);

            const suggestions = suggestImportsForSymbol('data.fifo::FIFO', moduleExportsMap);
            
            expect(suggestions).to.include('data.fifo');
            expect(suggestions).to.not.include('utils.math');
        });

        it('suggests modules that re-export the symbol', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['data.fifo', {
                    modulePath: 'data.fifo',
                    exportedSymbols: new Set(['data.fifo::FIFO']),
                    exportedNames: new Set(['FIFO']),
                    explicitExports: new Set(['FIFO']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['wrapper', {
                    modulePath: 'wrapper',
                    exportedSymbols: new Set(),
                    exportedNames: new Set(),
                    explicitExports: new Set(),
                    reExportedModules: new Set(['data.fifo']),
                    moduleDifferences: new Map(),
                    resolvedExports: new Set(['data.fifo::FIFO']) // Pre-resolved
                }]
            ]);

            const suggestions = suggestImportsForSymbol('data.fifo::FIFO', moduleExportsMap);
            
            expect(suggestions).to.include('data.fifo');
            expect(suggestions).to.include('wrapper');
        });

        it('returns empty array for unknown symbols', () => {
            const moduleExportsMap = new Map<string, ModuleExports>();
            const suggestions = suggestImportsForSymbol('unknown::Symbol', moduleExportsMap);
            
            expect(suggestions).to.be.an('array').that.is.empty;
        });

        it('returns multiple modules if symbol is in many', () => {
            const moduleExportsMap = new Map<string, ModuleExports>([
                ['module1', {
                    modulePath: 'module1',
                    exportedSymbols: new Set(['shared::Symbol']),
                    exportedNames: new Set(['Symbol']),
                    explicitExports: new Set(['Symbol']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }],
                ['module2', {
                    modulePath: 'module2',
                    exportedSymbols: new Set(['shared::Symbol']),
                    exportedNames: new Set(['Symbol']),
                    explicitExports: new Set(['Symbol']),
                    reExportedModules: new Set(),
                    moduleDifferences: new Map()
                }]
            ]);

            const suggestions = suggestImportsForSymbol('shared::Symbol', moduleExportsMap);
            
            expect(suggestions).to.include('module1');
            expect(suggestions).to.include('module2');
            expect(suggestions.length).to.equal(2);
        });
    });
});

describe('Module Difference Integration', () => {
    it('correctly applies module differences in complex scenario', () => {
        // Scenario: params module has many symbols, params.cmdargs has debug-only symbols
        // clean module wants params minus cmdargs
        const moduleExportsMap = new Map<string, ModuleExports>([
            ['params', {
                modulePath: 'params',
                exportedSymbols: new Set([
                    'params::HARTS',
                    'params::CLOCK_FREQ',
                    'params::DEBUG_MODE',
                    'params::VERBOSE'
                ]),
                exportedNames: new Set(['HARTS', 'CLOCK_FREQ', 'DEBUG_MODE', 'VERBOSE']),
                explicitExports: new Set(['HARTS', 'CLOCK_FREQ', 'DEBUG_MODE', 'VERBOSE']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['params.cmdargs', {
                modulePath: 'params.cmdargs',
                exportedSymbols: new Set([
                    'params::DEBUG_MODE',
                    'params::VERBOSE'
                ]),
                exportedNames: new Set(['DEBUG_MODE', 'VERBOSE']),
                explicitExports: new Set(['DEBUG_MODE', 'VERBOSE']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['clean.params', {
                modulePath: 'clean.params',
                exportedSymbols: new Set(),
                exportedNames: new Set(),
                explicitExports: new Set(),
                reExportedModules: new Set(),
                moduleDifferences: new Map([['params', 'params.cmdargs']])
            }]
        ]);

        const result = resolveTransitiveExports('clean.params', moduleExportsMap);
        
        // Should have params exports minus cmdargs
        expect(result.has('params::HARTS')).to.be.true;
        expect(result.has('params::CLOCK_FREQ')).to.be.true;
        expect(result.has('params::DEBUG_MODE')).to.be.false; // Excluded
        expect(result.has('params::VERBOSE')).to.be.false; // Excluded
        expect(result.size).to.equal(2);
    });
});

describe('Implicit Base Import Edge Cases', () => {
    it('handles base module not found gracefully', () => {
        const moduleExportsMap = new Map<string, ModuleExports>([
            ['data.fifo', {
                modulePath: 'data.fifo',
                exportedSymbols: new Set(['data.fifo::FIFO']),
                exportedNames: new Set(['FIFO']),
                explicitExports: new Set(['FIFO']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }]
        ]);
        // base module is NOT in the map

        const result = resolveImportsWithTransitives(
            'mymodule',
            [{ path: 'data.fifo' }],
            moduleExportsMap
        );
        
        // Should not crash, base just won't be resolved
        expect(result.importedModules.has('data.fifo')).to.be.true;
        expect(result.accessibleQualifiedNames.has('data.fifo::FIFO')).to.be.true;
    });

    it('handles base as suffix path (e.g., stdlib.base)', () => {
        const moduleExportsMap = new Map<string, ModuleExports>([
            ['stdlib.base', {
                modulePath: 'stdlib.base',
                exportedSymbols: new Set(['stdlib.base::uint32']),
                exportedNames: new Set(['uint32']),
                explicitExports: new Set(['uint32']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }]
        ]);

        const result = resolveImportsWithTransitives(
            'mymodule',
            [], // No explicit imports
            moduleExportsMap
        );
        
        // Implicit 'base' should match 'stdlib.base' via suffix matching
        expect(result.importedModules.has('stdlib.base')).to.be.true;
        expect(result.accessibleQualifiedNames.has('stdlib.base::uint32')).to.be.true;
    });
});

describe('Explicit Symbol Re-Export (base::count_t scenario)', () => {
    it('makes re-exported symbols accessible through the re-exporting module', () => {
        // This simulates the base.k scenario where:
        // - type.stdtype defines count_t
        // - base imports type.stdtype and re-exports count_t by name
        // - User imports base, should be able to use count_t
        
        const moduleExportsMap = new Map<string, ModuleExports>([
            ['type.stdtype', {
                modulePath: 'type.stdtype',
                exportedSymbols: new Set(['type.stdtype::count_t', 'type.stdtype::index_t']),
                exportedNames: new Set(['count_t', 'index_t']),
                explicitExports: new Set(['count_t', 'index_t']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }],
            ['base', {
                modulePath: 'base',
                // After resolveExplicitSymbolReExports(), base.exportedSymbols should include type.stdtype::count_t
                exportedSymbols: new Set(['type.stdtype::count_t']), // This is what the indexer would populate
                exportedNames: new Set(['count_t']),
                explicitExports: new Set(['count_t']),
                reExportedModules: new Set(),
                moduleDifferences: new Map()
            }]
        ]);
        
        // When user imports base (either explicitly or via implicit base)
        const result = resolveImportsWithTransitives(
            'mymodule',
            [{ path: 'base' }],
            moduleExportsMap,
            { includeImplicitBase: false } // Test explicit import
        );
        
        // The re-exported symbol should be accessible
        expect(result.accessibleQualifiedNames.has('type.stdtype::count_t')).to.be.true;
    });
    
    it('isSymbolStrictlyAccessible returns true for re-exported symbols', () => {
        const resolved: ResolvedImports = {
            currentModule: 'mymodule',
            importedModules: new Set(['base']), // User imports base, not type.stdtype
            aliasToModule: new Map(),
            accessibleQualifiedNames: new Set([
                'type.stdtype::count_t' // This came from base's re-export
            ])
        };
        
        // Even though type.stdtype is not directly imported, count_t should be accessible
        // because it's in accessibleQualifiedNames (via base's re-export)
        expect(isSymbolStrictlyAccessible('type.stdtype::count_t', resolved)).to.be.true;
    });
    
    it('class members remain inaccessible even when module re-exports symbols', () => {
        const resolved: ResolvedImports = {
            currentModule: 'mymodule',
            importedModules: new Set(['data.counter.saturating']),
            aliasToModule: new Map(),
            accessibleQualifiedNames: new Set([
                'data.counter.saturating::saturating_counter'
            ])
        };
        
        // Class member should NOT be accessible as a bare identifier
        expect(isSymbolStrictlyAccessible('data.counter.saturating::saturating_counter::count_t', resolved)).to.be.false;
    });
});
describe('isClassMemberFromScopePath', () => {
    it('returns false for module-level symbols (scopePath with 1 element)', () => {
        // Symbol directly in module
        expect(isClassMemberFromScopePath(['data.fifo'])).to.be.false;
        expect(isClassMemberFromScopePath(['base'])).to.be.false;
        expect(isClassMemberFromScopePath(['counter'])).to.be.false;
    });
    
    it('returns true for class members (scopePath with 2+ elements)', () => {
        // Symbol inside a class in a dotted module
        expect(isClassMemberFromScopePath(['data.fifo', 'FIFO'])).to.be.true;
        // Symbol inside a class in a single-segment module (this was the bug!)
        expect(isClassMemberFromScopePath(['counter', 'saturating_counter'])).to.be.true;
        // Deeply nested
        expect(isClassMemberFromScopePath(['data.fifo', 'FIFO', 'InnerClass'])).to.be.true;
    });
    
    it('returns false for global symbols (empty scopePath)', () => {
        expect(isClassMemberFromScopePath([])).to.be.false;
    });
});

describe('Class member filtering for single-segment modules', () => {
    it('filters out class members even when module name has no dots', () => {
        // This is the key bug: counter::saturating_counter::count_t was not being filtered
        // because isClassMember couldn't detect it (no dots in "counter")
        // But isClassMemberFromScopePath can detect it from scopePath
        
        const resolved: ResolvedImports = {
            currentModule: 'mymodule',
            importedModules: new Set(['counter', 'base']),
            aliasToModule: new Map(),
            accessibleQualifiedNames: new Set([
                'base::count_t',          // Module-level type from base
                'counter::saturating_counter' // The class itself
            ])
        };
        
        const symbols = [
            {
                qualifiedName: 'base::count_t',
                scopePath: ['base'],  // Module-level - accessible
            },
            {
                qualifiedName: 'counter::saturating_counter::count_t',
                scopePath: ['counter', 'saturating_counter'],  // Class member - NOT accessible
            }
        ];
        
        const filtered = filterByAccessibility(symbols, resolved);
        
        // Should only include the module-level count_t, not the class member
        expect(filtered.length).to.equal(1);
        expect(filtered[0].qualifiedName).to.equal('base::count_t');
    });
    
    it('correctly identifies class members using scopePath even without dots', () => {
        // Verify our detection is correct
        expect(isClassMemberFromScopePath(['counter', 'saturating_counter'])).to.be.true;
        expect(isClassMemberFromScopePath(['counter'])).to.be.false;
    });
});