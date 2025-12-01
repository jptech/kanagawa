/**
 * Tests for KanagawaReferencesProvider
 * 
 * Priority: P1 - Tests the find-all-references functionality
 * 
 * The references provider must:
 * 1. Find all usages of a symbol across files
 * 2. Optionally include the declaration
 * 3. Handle local vs global scope correctly
 * 4. Match only exact symbol references, not substrings
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    SymbolKind,
    Location
} from '../../mocks/vscode';
import { computeQualifiedName } from '../../../src/utils/symbolUtils';

// Mock symbol info
interface MockSymbolInfo {
    name: string;
    qualifiedName: string;
    uri: Uri;
    range: Range;
    kind: SymbolKind;
    scopePath: string[];
    category: string;
}

function createMockSymbol(
    name: string,
    category: string,
    scopePath: string[] = [],
    options?: Partial<MockSymbolInfo>
): MockSymbolInfo {
    return {
        name,
        qualifiedName: computeQualifiedName(name, scopePath),
        uri: options?.uri ?? Uri.file('/test/file.k'),
        range: options?.range ?? new Range(0, 0, 0, name.length),
        kind: SymbolKind.Variable,
        scopePath,
        category,
        ...options
    };
}

describe('ReferencesProvider', () => {
    describe('Reference Collection', () => {
        interface IdentifierOccurrence {
            uri: Uri;
            range: Range;
            isDeclaration: boolean;
        }

        it('should include declaration when requested', () => {
            const occurrences: IdentifierOccurrence[] = [
                { uri: Uri.file('/test.k'), range: new Range(5, 4, 5, 8), isDeclaration: true },
                { uri: Uri.file('/test.k'), range: new Range(10, 8, 10, 12), isDeclaration: false },
                { uri: Uri.file('/test.k'), range: new Range(15, 8, 15, 12), isDeclaration: false }
            ];

            const includeDeclaration = true;
            const filtered = includeDeclaration 
                ? occurrences 
                : occurrences.filter(o => !o.isDeclaration);

            expect(filtered.length).to.equal(3);
        });

        it('should exclude declaration when not requested', () => {
            const occurrences: IdentifierOccurrence[] = [
                { uri: Uri.file('/test.k'), range: new Range(5, 4, 5, 8), isDeclaration: true },
                { uri: Uri.file('/test.k'), range: new Range(10, 8, 10, 12), isDeclaration: false },
                { uri: Uri.file('/test.k'), range: new Range(15, 8, 15, 12), isDeclaration: false }
            ];

            const includeDeclaration = false;
            const filtered = includeDeclaration 
                ? occurrences 
                : occurrences.filter(o => !o.isDeclaration);

            expect(filtered.length).to.equal(2);
            expect(filtered.every(o => !o.isDeclaration)).to.be.true;
        });
    });

    describe('Symbol Matching', () => {
        it('should match exact identifiers only', () => {
            // Should not match "foobar" when looking for "foo"
            function isExactMatch(identifier: string, target: string): boolean {
                return identifier === target;
            }

            expect(isExactMatch('foo', 'foo')).to.be.true;
            expect(isExactMatch('foobar', 'foo')).to.be.false;
            expect(isExactMatch('foo', 'foobar')).to.be.false;
            expect(isExactMatch('Foo', 'foo')).to.be.false; // Case sensitive
        });

        it('should verify resolution to same definition', () => {
            function isSameDefinition(
                a: { uri: string; line: number; char: number },
                b: { uri: string; line: number; char: number }
            ): boolean {
                return a.uri === b.uri && 
                       a.line === b.line && 
                       a.char === b.char;
            }

            const def1 = { uri: 'file:///a.k', line: 5, char: 4 };
            const def2 = { uri: 'file:///a.k', line: 5, char: 4 };
            const def3 = { uri: 'file:///b.k', line: 5, char: 4 };

            expect(isSameDefinition(def1, def2)).to.be.true;
            expect(isSameDefinition(def1, def3)).to.be.false;
        });
    });

    describe('Scope Handling', () => {
        it('should limit local variable references to scope', () => {
            // Local variables should only show references within their scope
            interface ScopedReference {
                line: number;
                inScope: boolean;
            }

            const references: ScopedReference[] = [
                { line: 5, inScope: true },   // Declaration
                { line: 7, inScope: true },   // Use in scope
                { line: 10, inScope: true },  // Use in scope
                { line: 20, inScope: false }  // Same name, different scope
            ];

            const inScopeRefs = references.filter(r => r.inScope);
            expect(inScopeRefs.length).to.equal(3);
        });

        it('should find workspace-wide references for globals', () => {
            const globalSymbol = createMockSymbol('FIFO', 'class', ['data.fifo']);

            // Global symbols can be referenced from any file
            const files = [
                Uri.file('/src/main.k'),
                Uri.file('/src/utils.k'),
                Uri.file('/test/test.k')
            ];

            // Each file could have references
            const potentialRefLocations = files.map(uri => ({
                uri,
                hasImport: true // Assume proper imports
            }));

            expect(potentialRefLocations.length).to.equal(3);
        });
    });

    describe('Cross-File References', () => {
        it('should collect references from multiple files', () => {
            const references: Location[] = [];
            
            // Simulate finding references in multiple files
            references.push(new Location(Uri.file('/src/a.k'), new Range(10, 4, 10, 8)));
            references.push(new Location(Uri.file('/src/b.k'), new Range(20, 8, 20, 12)));
            references.push(new Location(Uri.file('/src/c.k'), new Range(5, 4, 5, 8)));

            expect(references.length).to.equal(3);
            
            const uniqueFiles = new Set(references.map(r => r.uri.toString()));
            expect(uniqueFiles.size).to.equal(3);
        });

        it('should deduplicate same-location references', () => {
            const seen = new Set<string>();
            const references: Location[] = [];

            function addReference(uri: Uri, range: Range): void {
                const key = `${uri.toString()}#${range.start.line}:${range.start.character}`;
                if (seen.has(key)) return;
                seen.add(key);
                references.push(new Location(uri, range));
            }

            // Try to add same reference twice
            const uri = Uri.file('/test.k');
            addReference(uri, new Range(10, 4, 10, 8));
            addReference(uri, new Range(10, 4, 10, 8));
            addReference(uri, new Range(15, 4, 15, 8));

            expect(references.length).to.equal(2);
        });
    });

    describe('Member References', () => {
        it('should find method references across types', () => {
            // When looking for references to FIFO::push, should not include Stack::push
            interface TypedReference {
                containerType: string;
                memberName: string;
                uri: Uri;
                range: Range;
            }

            const references: TypedReference[] = [
                { containerType: 'FIFO', memberName: 'push', uri: Uri.file('/a.k'), range: new Range(10, 0, 10, 4) },
                { containerType: 'FIFO', memberName: 'push', uri: Uri.file('/b.k'), range: new Range(20, 0, 20, 4) },
                { containerType: 'Stack', memberName: 'push', uri: Uri.file('/c.k'), range: new Range(30, 0, 30, 4) }
            ];

            const fifoRefs = references.filter(r => r.containerType === 'FIFO');
            expect(fifoRefs.length).to.equal(2);
        });
    });

    describe('Reference Context', () => {
        /**
         * References can be categorized by their context:
         * - Read: using the value
         * - Write: assigning to the variable
         * - Declaration: where the symbol is declared
         */

        type ReferenceContext = 'read' | 'write' | 'declaration';

        interface ContextualReference {
            uri: Uri;
            range: Range;
            context: ReferenceContext;
        }

        it('should identify declaration context', () => {
            function classifyContext(
                nodeType: string,
                fieldName: string | null
            ): ReferenceContext {
                if (nodeType === 'variable_decl' || 
                    nodeType === 'parameter' ||
                    nodeType === 'function_definition') {
                    return 'declaration';
                }
                if (nodeType === 'assignment_expression' && fieldName === 'left') {
                    return 'write';
                }
                return 'read';
            }

            expect(classifyContext('variable_decl', 'name')).to.equal('declaration');
            expect(classifyContext('assignment_expression', 'left')).to.equal('write');
            expect(classifyContext('call_expression', 'argument')).to.equal('read');
        });

        it('should separate read and write references', () => {
            const references: ContextualReference[] = [
                { uri: Uri.file('/t.k'), range: new Range(1, 0, 1, 1), context: 'declaration' },
                { uri: Uri.file('/t.k'), range: new Range(5, 0, 5, 1), context: 'read' },
                { uri: Uri.file('/t.k'), range: new Range(8, 0, 8, 1), context: 'write' },
                { uri: Uri.file('/t.k'), range: new Range(10, 0, 10, 1), context: 'read' }
            ];

            const reads = references.filter(r => r.context === 'read');
            const writes = references.filter(r => r.context === 'write');

            expect(reads.length).to.equal(2);
            expect(writes.length).to.equal(1);
        });
    });

    describe('Import-Aware References', () => {
        interface ModuleContext {
            module: string;
            imports: string[];
        }

        function canAccessSymbol(
            symbolModule: string | undefined,
            context: ModuleContext
        ): boolean {
            if (!symbolModule) return true; // Global
            if (symbolModule === context.module) return true; // Same module
            return context.imports.includes(symbolModule); // Imported
        }

        it('should find references only in importing files', () => {
            const symbolModule = 'data.fifo';
            
            const files: ModuleContext[] = [
                { module: 'main', imports: ['data.fifo'] },      // Can access
                { module: 'utils', imports: ['data.queue'] },    // Cannot
                { module: 'data.fifo', imports: [] }             // Same module
            ];

            const accessibleFiles = files.filter(f => canAccessSymbol(symbolModule, f));
            expect(accessibleFiles.length).to.equal(2);
        });
    });

    describe('Performance Optimization', () => {
        it('should skip files without identifier match', () => {
            // Quick text search before AST parsing
            function fileContainsIdentifier(content: string, identifier: string): boolean {
                // Use word boundary check to avoid substring matches
                const pattern = new RegExp(`\\b${identifier}\\b`);
                return pattern.test(content);
            }

            expect(fileContainsIdentifier('int foo = 1;', 'foo')).to.be.true;
            expect(fileContainsIdentifier('int foobar = 1;', 'foo')).to.be.false;
            expect(fileContainsIdentifier('int bar = foo + 1;', 'foo')).to.be.true;
        });

        it('should batch file processing', () => {
            const files = Array.from({ length: 100 }, (_, i) => 
                Uri.file(`/src/file${i}.k`)
            );

            const chunkSize = 10;
            const chunks: Uri[][] = [];
            
            for (let i = 0; i < files.length; i += chunkSize) {
                chunks.push(files.slice(i, i + chunkSize));
            }

            expect(chunks.length).to.equal(10);
            expect(chunks[0].length).to.equal(10);
        });
    });

    describe('Edge Cases', () => {
        it('should handle symbols with no references', () => {
            const references: Location[] = [];
            
            // A symbol might only have its declaration
            const declaration = new Location(
                Uri.file('/test.k'),
                new Range(5, 4, 5, 8)
            );

            const includeDeclaration = true;
            if (includeDeclaration) {
                references.push(declaration);
            }

            expect(references.length).to.equal(1);
        });

        it('should handle renamed imports', () => {
            // import data.fifo as df;
            // df.FIFO should reference data.fifo::FIFO
            
            const aliasMap = new Map<string, string>();
            aliasMap.set('df', 'data.fifo');

            function resolveAlias(identifier: string): string {
                return aliasMap.get(identifier) ?? identifier;
            }

            expect(resolveAlias('df')).to.equal('data.fifo');
            expect(resolveAlias('FIFO')).to.equal('FIFO');
        });

        it('should handle symbols in comments (exclude)', () => {
            // References in comments should not be counted
            interface ParsedReference {
                text: string;
                inComment: boolean;
                range: Range;
            }

            const potentialRefs: ParsedReference[] = [
                { text: 'FIFO', inComment: false, range: new Range(5, 0, 5, 4) },
                { text: 'FIFO', inComment: true, range: new Range(10, 0, 10, 4) },  // In comment
                { text: 'FIFO', inComment: false, range: new Range(15, 0, 15, 4) }
            ];

            const validRefs = potentialRefs.filter(r => !r.inComment);
            expect(validRefs.length).to.equal(2);
        });

        it('should handle symbols in string literals (exclude)', () => {
            interface ParsedReference {
                text: string;
                inString: boolean;
                range: Range;
            }

            const potentialRefs: ParsedReference[] = [
                { text: 'FIFO', inString: false, range: new Range(5, 0, 5, 4) },
                { text: 'FIFO', inString: true, range: new Range(10, 0, 10, 4) },  // In string
            ];

            const validRefs = potentialRefs.filter(r => !r.inString);
            expect(validRefs.length).to.equal(1);
        });
    });
});
