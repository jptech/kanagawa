import { expect } from 'chai';
import { Uri } from '../mocks/vscode';
import { rankSymbolsForResolution } from '../../src/utils/resolutionRanking';
import { ResolvedImports } from '../../src/utils/importUtils';

type Sym = {
	qualifiedName: string;
	scopePath: string[];
	uri: any;
};

function resolvedImports(opts: {
	currentModule?: string;
	importedModules?: string[];
	accessibleQualifiedNames?: string[];
}): ResolvedImports {
	return {
		currentModule: opts.currentModule,
		importedModules: new Set(opts.importedModules ?? []),
		aliasToModule: new Map(),
		accessibleQualifiedNames: new Set(opts.accessibleQualifiedNames ?? [])
	};
}

describe('resolutionRanking', () => {
	it('prefers same-module global symbol via declaring module', () => {
		const doc = Uri.file('/ws/app/main.k') as any;
		const imports = resolvedImports({ currentModule: 'app', importedModules: ['lib'] });

		const fromUnrelatedTest: Sym = {
			qualifiedName: 'log_message_t',
			scopePath: [],
			uri: Uri.file('/ws/hdk/DataMover/test/project/data_mover_test_defines.pd') as any
		};
		const fromSameModuleFile: Sym = {
			qualifiedName: 'log_message_t',
			scopePath: [],
			uri: Uri.file('/ws/app/defs.pd') as any
		};

		const ranked = rankSymbolsForResolution([fromUnrelatedTest, fromSameModuleFile], {
			documentUri: doc,
			resolvedImports: imports,
			getDeclaringModule: (s) => (s.uri.toString().includes('/ws/app/') ? 'app' : undefined)
		});

		expect(ranked[0].symbol.uri.toString()).to.equal(fromSameModuleFile.uri.toString());
	});

	it('prefers imported-module global symbol via declaring module over unrelated workspace file', () => {
		const doc = Uri.file('/ws/app/main.k') as any;
		const imports = resolvedImports({ currentModule: 'app', importedModules: ['lib'] });

		const fromUnrelatedTest: Sym = {
			qualifiedName: 'log_message_t',
			scopePath: [],
			uri: Uri.file('/ws/hdk/DataMover/test/project/data_mover_test_defines.pd') as any
		};
		const fromImportedModuleFile: Sym = {
			qualifiedName: 'log_message_t',
			scopePath: [],
			uri: Uri.file('/ws/lib/defines.pd') as any
		};

		const ranked = rankSymbolsForResolution([fromUnrelatedTest, fromImportedModuleFile], {
			documentUri: doc,
			resolvedImports: imports,
			getDeclaringModule: (s) => (s.uri.toString().includes('/ws/lib/') ? 'lib' : undefined)
		});

		expect(ranked[0].symbol.uri.toString()).to.equal(fromImportedModuleFile.uri.toString());
	});

	it('uses path proximity to break ties when module signals are absent', () => {
		const doc = Uri.file('/ws/app/sub/main.k') as any;
		const imports = resolvedImports({ currentModule: 'app', importedModules: [] });

		const farther: Sym = {
			qualifiedName: 'log_message_t',
			scopePath: [],
			uri: Uri.file('/ws/other/place/defs.pd') as any
		};
		const closer: Sym = {
			qualifiedName: 'log_message_t',
			scopePath: [],
			uri: Uri.file('/ws/app/defs.pd') as any
		};

		const ranked = rankSymbolsForResolution([farther, closer], {
			documentUri: doc,
			resolvedImports: imports,
			getDeclaringModule: () => undefined
		});

		expect(ranked[0].symbol.uri.toString()).to.equal(closer.uri.toString());
	});
});
