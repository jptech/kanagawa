import { expect } from 'chai';
import { ResolvedImports } from '../../src/utils/importUtils';
import { computeCompletionTier, pickBestCompletionSymbols } from '../../src/utils/completionUtils';

describe('completionUtils', () => {
    const createResolvedImports = (opts: {
        currentModule?: string;
        importedModules?: string[];
        accessibleQualifiedNames?: string[];
    }): ResolvedImports => ({
        currentModule: opts.currentModule,
        importedModules: new Set(opts.importedModules ?? []),
        aliasToModule: new Map(),
        accessibleQualifiedNames: new Set(opts.accessibleQualifiedNames ?? [])
    });

    it('treats re-exported qualified names as imported-tier', () => {
        const imports = createResolvedImports({
            currentModule: 'my.mod',
            importedModules: ['base'],
            // `count_t` comes from type.stdtype but is re-exported into accessibility.
            accessibleQualifiedNames: ['type.stdtype::count_t']
        });

        expect(computeCompletionTier({ qualifiedName: 'type.stdtype::count_t', scopePath: ['type.stdtype'] }, imports)).to.equal('imported');
    });

    it('prefers accessible symbol when same name appears first as inaccessible', () => {
        const imports = createResolvedImports({
            currentModule: 'my.mod',
            importedModules: ['base'],
            accessibleQualifiedNames: ['type.stdtype::count_t']
        });

        const symbols = [
            { name: 'count_t', qualifiedName: 'other.counter::count_t', scopePath: ['other.counter'] },
            { name: 'count_t', qualifiedName: 'type.stdtype::count_t', scopePath: ['type.stdtype'] }
        ];

        const best = pickBestCompletionSymbols(symbols, imports);
        const picked = best.get('count_t');
        expect(picked).to.not.equal(undefined);
        expect(picked!.symbol.qualifiedName).to.equal('type.stdtype::count_t');
        expect(picked!.tier).to.equal('imported');
    });

    it('prefers same-module over imported', () => {
        const imports = createResolvedImports({
            currentModule: 'base',
            importedModules: ['type.stdtype'],
            accessibleQualifiedNames: ['type.stdtype::count_t']
        });

        const symbols = [
            { name: 'count_t', qualifiedName: 'type.stdtype::count_t', scopePath: ['type.stdtype'] },
            { name: 'count_t', qualifiedName: 'base::count_t', scopePath: ['base'] }
        ];

        const best = pickBestCompletionSymbols(symbols, imports);
        const picked = best.get('count_t');
        expect(picked!.symbol.qualifiedName).to.equal('base::count_t');
        expect(picked!.tier).to.equal('same_module');
    });
});
