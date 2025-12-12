/**
 * Unit tests for Copilot Language Model Tools.
 * 
 * Tests the ACTUAL tool logic functions from toolLogic.ts using MockWorkspaceIndexer.
 * This ensures we're testing the real implementation, not duplicated test code.
 */

import { expect } from 'chai';
import {
    MockWorkspaceIndexer,
    createTestIndexer,
    createMockSymbol
} from '../mocks/indexer';
import { Uri, Range } from '../mocks/vscode';
// Import the actual logic functions we're testing
import {
    lookupSymbolLogic,
    getTypeMembersLogic,
    getModuleExportsLogic,
    getImportsLogic,
    searchSymbolsLogic,
    getSymbolDetailsLogic,
    listModulesLogic,
    getModuleApiLogic,
    getDocumentSymbolsLogic,
    symbolToToolInfo
} from '../../src/copilot/toolLogic';

/**
 * Error codes for tool responses.
 */
type ToolErrorCode = 'SYMBOL_NOT_FOUND' | 'FILE_NOT_FOUND' | 'INVALID_INPUT' | 'INTERNAL_ERROR';

/**
 * Helper to check if a response is an error response.
 */
function isErrorResponse(response: unknown): response is { error: string; code: ToolErrorCode } {
    return typeof response === 'object' && response !== null && 'error' in response;
}

/**
 * Helper to check if a response is a success response with results.
 */
function isSuccessResponse<T>(response: { results?: T[] } | { error: string }): response is { results: T[] } {
    return 'results' in response && Array.isArray(response.results);
}

describe('Copilot Tools', () => {
    let indexer: MockWorkspaceIndexer;

    beforeEach(() => {
        indexer = createTestIndexer();
    });

    // Helper to create a mock Uri factory for tests
    const mockGetUri = (filePath: string) => Uri.file(filePath);

    // ========================================================================
    // LookupSymbol Tests (using actual lookupSymbolLogic)
    // ========================================================================

    describe('LookupSymbol', () => {
        it('should find symbol by name', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'FIFO' }) as any;

            expect(result.results).to.be.an('array');
            expect(result.results.length).to.be.greaterThan(0);
            expect(result.results[0].name).to.equal('FIFO');
            expect(result.results[0].qualifiedName).to.equal('data.fifo::FIFO');
            expect(result.results[0].kind).to.equal('class');
        });

        it('should return documentation in results', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'FIFO' }) as any;

            expect(result.results[0].documentation).to.include('FIFO queue');
        });

        it('should return signature in results', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'push' }) as any;

            expect(result.results[0].signature).to.include('void push');
        });

        it('should filter by scope path', () => {
            // Add another 'push' in a different scope
            indexer.addSymbol(createMockSymbol('push', 'method', ['other', 'Stack'], {
                uri: Uri.file('/other/stack.k'),
                signature: 'void push(int value)'
            }));

            const result = lookupSymbolLogic(indexer, { 
                symbolName: 'push', 
                scopePath: ['data.fifo', 'FIFO'] 
            }) as any;

            // Should prefer the FIFO::push due to scope match
            expect(result.results[0].qualifiedName).to.equal('data.fifo::FIFO::push');
        });

        it('should return error for non-existent symbol', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'NonExistent' }) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.error).to.include('No symbols found');
            expect(result.code).to.equal('SYMBOL_NOT_FOUND');
        });

        it('should return error for missing symbolName', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: undefined as any }) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('INVALID_INPUT');
        });

        it('should handle multiple matches', () => {
            // Add duplicate symbol in different scope
            indexer.addSymbol(createMockSymbol('Config', 'struct', ['other'], {
                uri: Uri.file('/other/config.k')
            }));

            const result = lookupSymbolLogic(indexer, { symbolName: 'Config' }) as any;

            expect(result.results.length).to.be.greaterThan(1);
            expect(result.totalCount).to.be.greaterThan(1);
        });
    });

    // ========================================================================
    // GetTypeMembers Tests (using actual getTypeMembersLogic)
    // ========================================================================

    describe('GetTypeMembers', () => {
        it('should get all members of a type', async () => {
            const result = await getTypeMembersLogic(indexer, { typeName: 'FIFO' }) as any;

            expect(result.results).to.be.an('array');
            expect(result.results.length).to.be.greaterThan(0);
            expect(result.containerType).to.equal('FIFO');
        });

        it('should include methods and fields by default', async () => {
            const result = await getTypeMembersLogic(indexer, { typeName: 'FIFO' }) as any;

            const categories = result.results.map((r: any) => r.category);
            expect(categories).to.include('method');
            expect(categories).to.include('member');
        });

        it('should filter to methods only', async () => {
            const result = await getTypeMembersLogic(indexer, {
                typeName: 'FIFO',
                includeMethods: true,
                includeFields: false
            }) as any;

            const categories = result.results.map((r: any) => r.category);
            expect(categories.every((c: string) => c === 'method')).to.be.true;
        });

        it('should filter to fields only', async () => {
            const result = await getTypeMembersLogic(indexer, {
                typeName: 'FIFO',
                includeMethods: false,
                includeFields: true
            }) as any;

            const categories = result.results.map((r: any) => r.category);
            expect(categories.every((c: string) => c === 'member')).to.be.true;
        });

        it('should handle template types', async () => {
            const result = await getTypeMembersLogic(indexer, { typeName: 'FIFO<uint32, 16>' }) as any;

            // Should still find members (base type extraction)
            expect(result.results.length).to.be.greaterThan(0);
        });

        it('should respect limit parameter', async () => {
            const result = await getTypeMembersLogic(indexer, { typeName: 'FIFO', limit: 2 }) as any;

            expect(result.results.length).to.be.at.most(2);
            expect(result.truncated).to.be.true;
        });

        it('should return error for non-existent type', async () => {
            const result = await getTypeMembersLogic(indexer, { typeName: 'NonExistent' }) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('SYMBOL_NOT_FOUND');
        });

        it('should return error for missing typeName', async () => {
            const result = await getTypeMembersLogic(indexer, { typeName: undefined as any }) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('INVALID_INPUT');
        });
    });

    // ========================================================================
    // GetModuleExports Tests (using actual getModuleExportsLogic)
    // ========================================================================

    describe('GetModuleExports', () => {
        it('should get exports from a file', () => {
            const result = getModuleExportsLogic(indexer, { filePath: '/project/src/main.k' }, mockGetUri) as any;

            expect(result.results).to.be.an('array');
            expect(result.modulePath).to.equal('main');
        });

        it('should include module-level symbols', () => {
            const result = getModuleExportsLogic(indexer, { filePath: '/project/src/main.k' }, mockGetUri) as any;

            const names = result.results.map((r: any) => r.name);
            expect(names).to.include('processData');
            expect(names).to.include('Config');
        });

        it('should respect limit parameter', () => {
            const result = getModuleExportsLogic(indexer, { filePath: '/project/src/main.k', limit: 1 }, mockGetUri) as any;

            expect(result.results.length).to.be.at.most(1);
            expect(result.truncated).to.be.true;
        });

        it('should return error for non-indexed file', () => {
            const result = getModuleExportsLogic(indexer, { filePath: '/unknown/file.k' }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('FILE_NOT_FOUND');
        });

        it('should return error for missing filePath', () => {
            const result = getModuleExportsLogic(indexer, { filePath: undefined as any }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('INVALID_INPUT');
        });
    });

    // ========================================================================
    // GetImports Tests (using actual getImportsLogic)
    // ========================================================================

    describe('GetImports', () => {
        it('should get imports for a file', () => {
            const result = getImportsLogic(indexer, { filePath: '/project/src/main.k' }, mockGetUri) as any;

            expect(result.currentModule).to.equal('main');
            expect(result.imports).to.be.an('array');
            expect(result.importedModules).to.be.an('array');
        });

        it('should include import paths', () => {
            const result = getImportsLogic(indexer, { filePath: '/project/src/main.k' }, mockGetUri) as any;

            expect(result.imports.length).to.be.greaterThan(0);
            expect(result.imports[0].path).to.equal('data.fifo');
        });

        it('should mark imports as resolved', () => {
            const result = getImportsLogic(indexer, { filePath: '/project/src/main.k' }, mockGetUri) as any;

            // data.fifo should be resolved since we added its context
            expect(result.imports[0].resolved).to.be.true;
        });

        it('should return error for non-indexed file', () => {
            const result = getImportsLogic(indexer, { filePath: '/unknown/file.k' }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('FILE_NOT_FOUND');
        });

        it('should return error for missing filePath', () => {
            const result = getImportsLogic(indexer, { filePath: undefined as any }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('INVALID_INPUT');
        });

        it('should handle file with no imports', () => {
            const result = getImportsLogic(indexer, { filePath: '/stdlib/data/fifo.k' }, mockGetUri) as any;

            expect(result.currentModule).to.equal('data.fifo');
            expect(result.imports).to.be.an('array');
            expect(result.imports.length).to.equal(0);
        });
    });

    // ========================================================================
    // New Discovery / Navigation Tool Logic Tests
    // ========================================================================

    describe('ListModules', () => {
        it('should list indexed modules in stable order', () => {
            const result = listModulesLogic(indexer, { limit: 50 }) as any;

            expect(result.results).to.be.an('array');
            expect(result.totalCount).to.equal(2);
            expect(result.results.map((m: any) => m.modulePath)).to.deep.equal(['data.fifo', 'main']);
            expect(result.results[0].declaringFile).to.have.property('uri');
            expect(result.results[0].declaringFile).to.have.property('path');
        });
    });

    describe('GetModuleApi', () => {
        it('should return exported symbols for a module', () => {
            const result = getModuleApiLogic(indexer, { modulePath: 'data.fifo', limit: 100 }) as any;

            expect(result.modulePath).to.equal('data.fifo');
            expect(result.exports).to.be.an('array');

            const qualified = result.exports.map((e: any) => e.qualifiedName);
            expect(qualified).to.include('data.fifo::FIFO');
            expect(qualified).to.include('data.fifo::FIFO::push');
        });

        it('should respect limit parameter', () => {
            const result = getModuleApiLogic(indexer, { modulePath: 'data.fifo', limit: 1 }) as any;

            expect(result.exports.length).to.equal(1);
            expect(result.truncated).to.equal(true);
        });
    });

    describe('GetDocumentSymbols', () => {
        it('should list top-level symbols for a file', () => {
            const result = getDocumentSymbolsLogic(indexer, { filePath: '/project/src/main.k' }, mockGetUri) as any;

            expect(result.modulePath).to.equal('main');
            expect(result.file).to.have.property('uri');
            expect(result.file).to.have.property('path');
            expect(result.symbols).to.be.an('array');

            const names = result.symbols.map((s: any) => s.name);
            expect(names).to.include('processData');
            expect(names).to.include('Config');
        });

        it('should include scopePath when requested', () => {
            const result = getDocumentSymbolsLogic(
                indexer,
                { filePath: '/project/src/main.k', includeScopePath: true, scope: 'all' },
                mockGetUri
            ) as any;

            expect(result.symbols).to.be.an('array');
            expect(result.symbols.some((s: any) => 'scopePath' in s)).to.equal(true);
        });
    });

    describe('GetSymbolDetails', () => {
        it('should return rich symbol info by qualifiedName', () => {
            const result = getSymbolDetailsLogic(indexer, { qualifiedName: 'data.fifo::FIFO' }) as any;

            expect(result.symbol).to.be.an('object');
            expect(result.symbol.name).to.equal('FIFO');
            expect(result.symbol.qualifiedName).to.equal('data.fifo::FIFO');
            expect(result.symbol.kind).to.equal('class');
            expect(result.symbol).to.have.property('location');
        });

        it('should return error for unknown qualifiedName', () => {
            const result = getSymbolDetailsLogic(indexer, { qualifiedName: 'nope::Missing' }) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('SYMBOL_NOT_FOUND');
        });
    });

    // ========================================================================
    // SearchSymbols Tests (using actual searchSymbolsLogic)
    // ========================================================================

    describe('SearchSymbols', () => {
        it('should find symbols by prefix', () => {
            const result = searchSymbolsLogic(indexer, { query: 'FIF' }, mockGetUri) as any;

            expect(result.files).to.be.an('array');
            expect(result.files.length).to.be.greaterThan(0);
            const firstMatch = result.files[0].matches[0];
            expect(firstMatch.name).to.equal('FIFO');
        });

        it('should find symbols by substring', () => {
            const result = searchSymbolsLogic(indexer, { query: 'Data' }, mockGetUri) as any;

            expect(result.files).to.be.an('array');
            const allMatches = result.files.flatMap((f: any) => f.matches);
            expect(allMatches.some((m: any) => m.name.toLowerCase().includes('data'))).to.be.true;
        });

        it('should filter by category', () => {
            const result = searchSymbolsLogic(indexer, { query: 'pu', category: 'method' }, mockGetUri) as any;

            expect(result.files).to.be.an('array');
            const allMatches = result.files.flatMap((f: any) => f.matches);
            const categories = allMatches.map((r: any) => r.category);
            expect(categories.every((c: string) => c === 'method')).to.be.true;
        });

        it('should filter by file path', () => {
            const result = searchSymbolsLogic(
                indexer, 
                { query: 'process', filePath: '/project/src/main.k' }, 
                mockGetUri
            ) as any;

            expect(result.files).to.be.an('array');
            expect(result.files.length).to.equal(1);
            expect(result.files[0].file.path).to.include('main.k');
        });

        it('should return error for short query', () => {
            const result = searchSymbolsLogic(indexer, { query: 'a' }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('INVALID_INPUT');
        });

        it('should return error for empty query', () => {
            const result = searchSymbolsLogic(indexer, { query: '' }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('INVALID_INPUT');
        });

        it('should respect limit parameter', () => {
            // Add many symbols to test limit
            for (let i = 0; i < 10; i++) {
                indexer.addSymbol(createMockSymbol(`testFunc${i}`, 'function', []));
            }

            const result = searchSymbolsLogic(indexer, { query: 'testFunc', limit: 3 }, mockGetUri) as any;

            const returnedCount = result.files.reduce((sum: number, f: any) => sum + f.matches.length, 0);
            expect(returnedCount).to.equal(3);
            expect(result.truncated).to.be.true;
            expect(result.totalCount).to.equal(10);
        });

        it('should return error for no matches', () => {
            const result = searchSymbolsLogic(indexer, { query: 'zzzzNotFound' }, mockGetUri) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('SYMBOL_NOT_FOUND');
        });
    });

    // ========================================================================
    // Output Format Tests
    // ========================================================================

    describe('Output Format', () => {
        it('should return valid JSON structure for success', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'FIFO' }) as any;

            // Verify structure
            expect(result).to.have.property('results');
            expect(result.results).to.be.an('array');
            
            // Verify symbol structure
            const symbol = result.results[0];
            expect(symbol).to.have.property('name');
            expect(symbol).to.have.property('qualifiedName');
            expect(symbol).to.have.property('kind');
            expect(symbol).to.have.property('category');
            expect(symbol).to.have.property('location');
            expect(symbol).to.have.property('scopePath');

            // Verify location structure
            expect(symbol.location).to.have.property('uri');
            expect(symbol.location).to.have.property('path');
        });

        it('should return valid JSON structure for error', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'NonExistent' }) as any;

            // Verify error structure
            expect(result).to.have.property('error');
            expect(result).to.have.property('code');
            expect(typeof result.error).to.equal('string');
            expect(typeof result.code).to.equal('string');
        });

        it('should return a structured location with range', () => {
            const result = lookupSymbolLogic(indexer, { symbolName: 'FIFO' }) as any;

            const location = result.results[0].location;
            expect(location).to.be.an('object');
            expect(location.path).to.be.a('string');
            expect(location.uri).to.be.a('string');
            if (location.range) {
                expect(location.range.start.line).to.be.a('number');
                expect(location.range.start.character).to.be.a('number');
            }
        });
    });

    // ========================================================================
    // Edge Cases
    // ========================================================================

    describe('Edge Cases', () => {
        it('should handle empty index', () => {
            const emptyIndexer = new MockWorkspaceIndexer();
            const result = lookupSymbolLogic(emptyIndexer, { symbolName: 'anything' }) as any;

            expect(isErrorResponse(result)).to.be.true;
            expect(result.code).to.equal('SYMBOL_NOT_FOUND');
        });

        it('should handle symbols with special characters in names', () => {
            indexer.addSymbol(createMockSymbol('operator+', 'method', ['Math'], {
                signature: 'int operator+(int a, int b)'
            }));

            const result = lookupSymbolLogic(indexer, { symbolName: 'operator+' }) as any;

            expect(result.results[0].name).to.equal('operator+');
        });

        it('should handle very long symbol names', () => {
            const longName = 'a'.repeat(200);
            indexer.addSymbol(createMockSymbol(longName, 'function', []));

            const result = lookupSymbolLogic(indexer, { symbolName: longName }) as any;

            expect(result.results[0].name).to.equal(longName);
        });

        it('should handle unicode in symbol names', () => {
            indexer.addSymbol(createMockSymbol('αβγ', 'variable', [], {
                typeHint: 'int'
            }));

            const result = lookupSymbolLogic(indexer, { symbolName: 'αβγ' }) as any;

            expect(result.results[0].name).to.equal('αβγ');
        });
    });
});
