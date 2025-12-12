/**
 * Mock WorkspaceIndexer for unit testing Copilot tools.
 * 
 * Implements IWorkspaceIndexer with configurable fixture data,
 * enabling isolated testing of tool logic without real parsing.
 */

import {
    IWorkspaceIndexer,
    SymbolInfo,
    SymbolCategory,
    DocumentContext,
    DocumentImport,
    ResolveOptions
} from '../../src/service/IWorkspaceIndexer';
import { ResolutionResult, createResolutionResult, computeQualifiedName } from '../../src/utils/symbolUtils';
import { ResolvedImports } from '../../src/utils/importUtils';
import { MemberResolutionOptions, MemberResolutionResult } from '../../src/utils/memberUtils';
import { TemplateInstantiation } from '../../src/utils/templateUtils';
import { Uri, Range, SymbolKind } from './vscode';

/**
 * Options for creating mock symbols.
 */
export interface MockSymbolOptions {
    uri?: Uri;
    range?: Range;
    kind?: SymbolKind;
    detail?: string;
    signature?: string;
    docMarkdown?: string;
    typeHint?: string;
}

/**
 * Creates a mock SymbolInfo for testing.
 */
export function createMockSymbol(
    name: string,
    category: SymbolCategory,
    scopePath: string[] = [],
    options: MockSymbolOptions = {}
): SymbolInfo {
    const qualifiedName = computeQualifiedName(name, scopePath);
    const uri = options.uri ?? Uri.file('/test/file.k');
    const range = options.range ?? new Range(0, 0, 0, name.length);
    
    // Map category to appropriate SymbolKind
    let kind: SymbolKind;
    switch (category) {
        case 'class':
            kind = SymbolKind.Class;
            break;
        case 'struct':
            kind = SymbolKind.Struct;
            break;
        case 'function':
            kind = SymbolKind.Function;
            break;
        case 'method':
            kind = SymbolKind.Method;
            break;
        case 'variable':
        case 'member':
            kind = SymbolKind.Field;
            break;
        case 'module':
            kind = SymbolKind.Module;
            break;
        case 'enum':
            kind = SymbolKind.Enum;
            break;
        case 'constant':
            kind = SymbolKind.Constant;
            break;
        case 'alias':
            kind = SymbolKind.TypeParameter;
            break;
        default:
            kind = SymbolKind.Variable;
    }

    return {
        name,
        qualifiedName,
        uri: uri as any, // Cast to satisfy the vscode.Uri type
        range: range as any,
        kind: options.kind ?? kind,
        detail: options.detail ?? category,
        signature: options.signature,
        docMarkdown: options.docMarkdown,
        scopePath,
        category,
        typeHint: options.typeHint
    };
}

/**
 * Mock implementation of IWorkspaceIndexer for testing.
 */
export class MockWorkspaceIndexer implements IWorkspaceIndexer {
    private symbols: Map<string, SymbolInfo[]> = new Map();
    private qualifiedIndex: Map<string, SymbolInfo> = new Map();
    private documentContexts: Map<string, DocumentContext> = new Map();
    private membersByType: Map<string, SymbolInfo[]> = new Map();
    private typeInferenceResults: Map<string, string> = new Map();

    // ========================================================================
    // Test Data Setup
    // ========================================================================

    /**
     * Adds a symbol to the mock index.
     */
    addSymbol(symbol: SymbolInfo): void {
        // Add to name index
        const existing = this.symbols.get(symbol.name) ?? [];
        existing.push(symbol);
        this.symbols.set(symbol.name, existing);
        
        // Add to qualified index
        this.qualifiedIndex.set(symbol.qualifiedName, symbol);
        
        // Add to members-by-type if it has a scope
        if (symbol.scopePath.length > 0) {
            const container = symbol.scopePath[symbol.scopePath.length - 1];
            const members = this.membersByType.get(container) ?? [];
            members.push(symbol);
            this.membersByType.set(container, members);
        }
    }

    /**
     * Adds multiple symbols at once.
     */
    addSymbols(symbols: SymbolInfo[]): void {
        for (const symbol of symbols) {
            this.addSymbol(symbol);
        }
    }

    /**
     * Sets the document context for a URI.
     */
    setDocumentContext(uri: Uri, context: DocumentContext): void {
        this.documentContexts.set(uri.toString(), context);
    }

    /**
     * Sets a type inference result for testing.
     * Key format: "file:line:char"
     */
    setTypeInferenceResult(filePath: string, line: number, char: number, type: string): void {
        const key = `${filePath}:${line}:${char}`;
        this.typeInferenceResults.set(key, type);
    }

    /**
     * Clears all mock data.
     */
    clear(): void {
        this.symbols.clear();
        this.qualifiedIndex.clear();
        this.documentContexts.clear();
        this.membersByType.clear();
        this.typeInferenceResults.clear();
    }

    // ========================================================================
    // IWorkspaceIndexer Implementation
    // ========================================================================

    getSymbols(name: string): SymbolInfo[] | undefined {
        return this.symbols.get(name);
    }

    getAllSymbols(): SymbolInfo[] {
        const all: SymbolInfo[] = [];
        for (const list of this.symbols.values()) {
            all.push(...list);
        }
        return all;
    }

    resolveQualified(qualifiedName: string): SymbolInfo | undefined {
        return this.qualifiedIndex.get(qualifiedName);
    }

    resolveWithContext(
        name: string,
        scopePath: string[],
        options?: ResolveOptions
    ): ResolutionResult<SymbolInfo> {
        const candidates = this.symbols.get(name) ?? [];
        
        if (candidates.length === 0) {
            return createResolutionResult<SymbolInfo>([], () => 0);
        }

        // Simple scoring: exact scope match > partial match > no match
        const scored = candidates.map(sym => {
            let score = 10;
            
            // Exact scope match
            if (this.scopePathsEqual(sym.scopePath, scopePath)) {
                score += 200;
            }
            
            // Same file bonus
            if (options?.uri && sym.uri.toString() === options.uri.toString()) {
                score += 15;
            }
            
            // Partial scope match
            const common = this.commonScopeLength(sym.scopePath, scopePath);
            score += common * 10;
            
            return { sym, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const sorted = scored.map(s => s.sym);

        return createResolutionResult(sorted, (sym) => {
            const entry = scored.find(s => s.sym === sym);
            return entry?.score ?? 0;
        });
    }

    getSymbol(
        name: string,
        scopePath: string[],
        options?: ResolveOptions
    ): SymbolInfo | undefined {
        const qn = computeQualifiedName(name, scopePath);
        const exact = this.qualifiedIndex.get(qn);
        if (exact) return exact;

        const result = this.resolveWithContext(name, scopePath, options);
        return result.primary;
    }

    async inferTypeFromExpression(
        document: any,
        expression?: any,
        depth?: number
    ): Promise<string | undefined> {
        if (!expression) return undefined;
        
        // Look up pre-configured result
        const line = expression.startPosition?.row ?? 0;
        const char = expression.startPosition?.column ?? 0;
        const key = `${document.uri.fsPath}:${line}:${char}`;
        
        return this.typeInferenceResults.get(key);
    }

    getMembersForType(
        typeName: string,
        options?: { includeMethods?: boolean; includeFields?: boolean; includeConstants?: boolean }
    ): SymbolInfo[] {
        // Strip template arguments for lookup
        const baseName = typeName.replace(/<.*>/, '');
        const members = this.membersByType.get(baseName) ?? [];
        
        const includeMethods = options?.includeMethods ?? true;
        const includeFields = options?.includeFields ?? true;
        const includeConstants = options?.includeConstants ?? true;
        
        return members.filter(m => {
            if (m.category === 'method' && !includeMethods) return false;
            if (m.category === 'member' && !includeFields) return false;
            if (m.category === 'constant' && !includeConstants) return false;
            return true;
        });
    }

    resolveMembersForType(
        typeName: string,
        options?: MemberResolutionOptions
    ): MemberResolutionResult {
        const members = this.getMembersForType(typeName, {
            includeMethods: options?.includeMethods,
            includeFields: options?.includeFields,
            includeConstants: options?.includeConstants
        });

        const baseName = typeName.replace(/<.*>/, '');
        
        return {
            members,
            containerType: baseName,
            isExactMatch: members.length > 0
        };
    }

    async resolveInstantiatedMembers(
        typeName: string,
        options?: MemberResolutionOptions
    ): Promise<MemberResolutionResult & { instantiation?: TemplateInstantiation }> {
        const base = this.resolveMembersForType(typeName, options);
        
        // For mock, just return without instantiation
        return base;
    }

    getMemberByName(
        typeName: string,
        memberName: string,
        options?: { preferMethod?: boolean }
    ): SymbolInfo | undefined {
        const members = this.getMembersForType(typeName);
        const matches = members.filter(m => m.name === memberName);
        
        if (matches.length === 0) return undefined;
        if (matches.length === 1) return matches[0];
        
        if (options?.preferMethod) {
            const method = matches.find(m => m.category === 'method');
            if (method) return method;
        }
        
        return matches[0];
    }

    getDocumentContext(uri: any): DocumentContext | undefined {
        return this.documentContexts.get(uri.toString());
    }

    getResolvedImports(uri: any): ResolvedImports {
        const context = this.documentContexts.get(uri.toString());
        
        if (!context) {
            return {
                currentModule: undefined,
                importedModules: new Set(),
                aliasToModule: new Map(),
                accessibleQualifiedNames: new Set()
            };
        }

        const importedModules = new Set<string>();
        const aliasToModule = new Map<string, string>();
        
        for (const imp of context.imports) {
            importedModules.add(imp.path);
            if (imp.alias) {
                aliasToModule.set(imp.alias, imp.path);
            }
        }

        return {
            currentModule: context.modulePath,
            importedModules,
            aliasToModule,
            accessibleQualifiedNames: new Set()
        };
    }

    getIndexedUris(): any[] {
        const uris: any[] = [];
        for (const key of this.documentContexts.keys()) {
            uris.push(Uri.parse(key));
        }
        return uris;
    }

    getModuleExportedQualifiedNames(
        modulePath: string,
        _options?: { includeTransitive?: boolean }
    ): string[] {
        // For unit tests we approximate module exports by returning all symbols
        // whose qualified name is in the requested module.
        const prefix = modulePath + '::';
        const qualifiedNames: string[] = [];
        for (const sym of this.qualifiedIndex.values()) {
            if (sym.qualifiedName.startsWith(prefix)) {
                qualifiedNames.push(sym.qualifiedName);
            }
        }
        qualifiedNames.sort((a, b) => a.localeCompare(b));
        return qualifiedNames;
    }

    getStats(): { totalSymbols: number; uniqueFiles: number; recentlyIndexed: number; verbose: boolean } {
        const files = new Set<string>();
        for (const list of this.symbols.values()) {
            for (const sym of list) {
                files.add(sym.uri.toString());
            }
        }
        
        return {
            totalSymbols: this.symbols.size,
            uniqueFiles: files.size,
            recentlyIndexed: 0,
            verbose: false
        };
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    private scopePathsEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    private commonScopeLength(a: string[], b: string[]): number {
        const minLen = Math.min(a.length, b.length);
        let common = 0;
        for (let i = 0; i < minLen; i++) {
            if (a[i] === b[i]) {
                common++;
            } else {
                break;
            }
        }
        return common;
    }
}

/**
 * Creates a pre-populated mock indexer with common test fixtures.
 */
export function createTestIndexer(): MockWorkspaceIndexer {
    const indexer = new MockWorkspaceIndexer();
    
    // Add a sample class with members
    const fifoUri = Uri.file('/stdlib/data/fifo.k');
    
    indexer.addSymbols([
        createMockSymbol('FIFO', 'class', ['data.fifo'], {
            uri: fifoUri,
            signature: 'template<typename T, auto N = 32> class FIFO',
            docMarkdown: 'A hardware FIFO queue with configurable depth.',
            range: new Range(10, 0, 10, 4)
        }),
        createMockSymbol('push', 'method', ['data.fifo', 'FIFO'], {
            uri: fifoUri,
            signature: 'void push(T value)',
            docMarkdown: 'Pushes a value onto the FIFO.',
            typeHint: 'void',
            range: new Range(20, 4, 20, 8)
        }),
        createMockSymbol('pop', 'method', ['data.fifo', 'FIFO'], {
            uri: fifoUri,
            signature: 'T pop()',
            docMarkdown: 'Pops a value from the FIFO.',
            typeHint: 'T',
            range: new Range(30, 4, 30, 7)
        }),
        createMockSymbol('size', 'member', ['data.fifo', 'FIFO'], {
            uri: fifoUri,
            signature: 'uint32 size',
            typeHint: 'uint32',
            range: new Range(40, 4, 40, 8)
        }),
        createMockSymbol('MAX_SIZE', 'constant', ['data.fifo', 'FIFO'], {
            uri: fifoUri,
            signature: 'const auto MAX_SIZE = N',
            typeHint: 'auto',
            range: new Range(5, 4, 5, 12)
        })
    ]);

    // Add a sample module with functions
    const mainUri = Uri.file('/project/src/main.k');
    
    indexer.addSymbols([
        createMockSymbol('processData', 'function', ['main'], {
            uri: mainUri,
            signature: 'void processData(FIFO<uint32>& input)',
            docMarkdown: 'Processes data from input FIFO.',
            typeHint: 'void',
            range: new Range(15, 0, 15, 11)
        }),
        createMockSymbol('Config', 'struct', ['main'], {
            uri: mainUri,
            signature: 'struct Config',
            range: new Range(5, 0, 5, 6)
        })
    ]);

    // Set document contexts
    indexer.setDocumentContext(fifoUri, {
        modulePath: 'data.fifo',
        imports: []
    });

    indexer.setDocumentContext(mainUri, {
        modulePath: 'main',
        imports: [
            { path: 'data.fifo' }
        ]
    });

    return indexer;
}
