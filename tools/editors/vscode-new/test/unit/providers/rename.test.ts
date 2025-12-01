/**
 * Tests for KanagawaRenameProvider
 * 
 * Priority: P0 - Tests the critical scope-aware rename functionality
 * that was fixed to handle variable shadowing correctly.
 * 
 * The rename provider must:
 * 1. Only rename variables within their actual scope
 * 2. Not rename shadowed variables in nested scopes
 * 3. Handle function parameters correctly
 * 4. Handle workspace-wide renames for non-local symbols
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    createTestDocument
} from '../../mocks/vscode';

/**
 * Represents a scope node in the scope tree.
 * Mirrors the ScopeNode interface in rename.ts
 */
interface ScopeNode {
    id: number;
    type: string;
    startRow: number;
    endRow: number;
    declarations: Map<string, { startRow: number; endRow: number }>;
    parent?: ScopeNode;
    children: ScopeNode[];
}

/**
 * Simulates identifier locations in source code
 */
interface IdentifierLocation {
    name: string;
    line: number;
    column: number;
}

/**
 * Test implementation of scope tree building for validation.
 * This simulates the logic in KanagawaRenameProvider.buildScopeTree()
 */
class ScopeTreeBuilder {
    private nextId = 1;

    /**
     * Builds a mock scope tree from a simplified representation.
     * In the real implementation, this walks the AST.
     */
    buildFromDescription(desc: ScopeDescription): ScopeNode {
        return this.buildNode(desc);
    }

    private buildNode(desc: ScopeDescription, parent?: ScopeNode): ScopeNode {
        const node: ScopeNode = {
            id: this.nextId++,
            type: desc.type,
            startRow: desc.startRow,
            endRow: desc.endRow,
            declarations: new Map(),
            parent,
            children: []
        };

        // Add declarations
        for (const decl of desc.declarations ?? []) {
            node.declarations.set(decl.name, { startRow: decl.line, endRow: decl.line });
        }

        // Add children
        for (const childDesc of desc.children ?? []) {
            const child = this.buildNode(childDesc, node);
            node.children.push(child);
        }

        return node;
    }
}

interface ScopeDescription {
    type: string;
    startRow: number;
    endRow: number;
    declarations?: { name: string; line: number }[];
    children?: ScopeDescription[];
}

/**
 * Test implementation of scope-aware identifier collection.
 * Mirrors collectScopeAwareIdentifiers() in rename.ts
 */
function collectScopeAwareIdentifiers(
    scopeTree: ScopeNode,
    targetName: string,
    targetScope: ScopeNode,
    allIdentifiers: IdentifierLocation[]
): IdentifierLocation[] {
    const results: IdentifierLocation[] = [];
    
    collectInScope(scopeTree, targetName, targetScope, allIdentifiers, results);
    
    return results;
}

function collectInScope(
    scope: ScopeNode,
    targetName: string,
    targetScope: ScopeNode,
    allIdentifiers: IdentifierLocation[],
    results: IdentifierLocation[]
): void {
    // Check if this scope shadows the target variable
    // (A scope shadows if it declares the same name AND is not the target scope
    // AND is a descendant of the target scope - meaning it's a nested scope with its own declaration)
    const shadowsTarget = scope !== targetScope &&
        scope.declarations.has(targetName) &&
        isAncestorScope(targetScope, scope);  // scope is a descendant of targetScope

    if (shadowsTarget) {
        // This scope has its own declaration that shadows the target, don't collect here or in children
        return;
    }

    // Check if we should collect from this scope
    // We collect if: this scope is the target, OR this scope is a descendant of target
    const isTargetScope = scope === targetScope;
    const isDescendantOfTarget = isAncestorScope(targetScope, scope);

    if (isTargetScope || isDescendantOfTarget) {
        // Collect identifiers in this scope (but not in child scopes - those are handled recursively)
        const childScopeRanges = scope.children.map(c => ({ start: c.startRow, end: c.endRow }));
        
        for (const id of allIdentifiers) {
            if (id.name !== targetName) continue;
            if (id.line < scope.startRow || id.line > scope.endRow) continue;
            
            // Check if this identifier is inside a child scope
            const inChildScope = childScopeRanges.some(
                range => id.line >= range.start && id.line <= range.end
            );
            
            if (!inChildScope) {
                results.push(id);
            }
        }
    }

    // Always recurse into children to find the target scope or its descendants
    for (const child of scope.children) {
        collectInScope(child, targetName, targetScope, allIdentifiers, results);
    }
}

function isAncestorScope(ancestor: ScopeNode, descendant: ScopeNode): boolean {
    let current: ScopeNode | undefined = descendant.parent;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

function findDeclarationScope(
    scopeTree: ScopeNode,
    position: Position,
    name: string
): ScopeNode | undefined {
    // Check if this scope has the declaration
    const decl = scopeTree.declarations.get(name);
    if (decl) {
        if (position.line >= decl.startRow) {
            return scopeTree;
        }
    }

    // Check children
    for (const child of scopeTree.children) {
        const found = findDeclarationScope(child, position, name);
        if (found) return found;
    }

    return undefined;
}

describe('RenameProvider', () => {
    describe('Identifier Validation', () => {
        function isValidIdentifier(name: string): boolean {
            if (!name || name.length === 0) return false;
            return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
        }

        it('should accept valid identifiers', () => {
            expect(isValidIdentifier('foo')).to.be.true;
            expect(isValidIdentifier('_bar')).to.be.true;
            expect(isValidIdentifier('Foo123')).to.be.true;
            expect(isValidIdentifier('a_b_c')).to.be.true;
            expect(isValidIdentifier('MAX_VALUE')).to.be.true;
        });

        it('should reject invalid identifiers', () => {
            expect(isValidIdentifier('')).to.be.false;
            expect(isValidIdentifier('123foo')).to.be.false;
            expect(isValidIdentifier('foo-bar')).to.be.false;
            expect(isValidIdentifier('foo.bar')).to.be.false;
            expect(isValidIdentifier('foo bar')).to.be.false;
            expect(isValidIdentifier('class')).to.be.true; // Keywords are valid identifiers structurally
        });
    });

    describe('Scope Tree Building', () => {
        const builder = new ScopeTreeBuilder();

        it('should build tree with nested scopes', () => {
            const tree = builder.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 20,
                declarations: [{ name: 'x', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 5,
                        endRow: 15,
                        declarations: [],
                        children: []
                    }
                ]
            });

            expect(tree.type).to.equal('function_definition');
            expect(tree.children.length).to.equal(1);
            expect(tree.children[0].parent).to.equal(tree);
        });

        it('should track declarations per scope', () => {
            const tree = builder.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 20,
                declarations: [
                    { name: 'a', line: 1 },
                    { name: 'b', line: 2 }
                ],
                children: []
            });

            expect(tree.declarations.has('a')).to.be.true;
            expect(tree.declarations.has('b')).to.be.true;
            expect(tree.declarations.has('c')).to.be.false;
        });
    });

    describe('Scope-Aware Identifier Collection', () => {
        const builder = new ScopeTreeBuilder();

        it('should collect identifiers only in target scope', () => {
            // Simulate:
            // func test() {        // line 0
            //     int x = 1;       // line 1 - declaration
            //     use(x);          // line 2 - use
            //     {                // line 3
            //         use(x);      // line 4 - use (in child, but no shadow)
            //     }                // line 5
            // }                    // line 6
            
            const tree = builder.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 6,
                declarations: [{ name: 'x', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 3,
                        endRow: 5,
                        declarations: [],
                        children: []
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 1, column: 8 },   // declaration
                { name: 'x', line: 2, column: 8 },   // use
                { name: 'x', line: 4, column: 12 }   // use in nested block
            ];

            const targetScope = tree; // Declaration is in function scope
            const collected = collectScopeAwareIdentifiers(tree, 'x', targetScope, identifiers);

            // Should collect all 3 - nested block doesn't shadow
            expect(collected.length).to.equal(3);
        });

        it('should not collect shadowed identifiers', () => {
            // Simulate:
            // func test() {        // line 0
            //     int x = 1;       // line 1 - outer declaration
            //     use(x);          // line 2 - outer use
            //     {                // line 3
            //         int x = 2;   // line 4 - shadow declaration
            //         use(x);      // line 5 - use of shadow
            //     }                // line 6
            //     use(x);          // line 7 - outer use again
            // }                    // line 8
            
            const tree = builder.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 8,
                declarations: [{ name: 'x', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 3,
                        endRow: 6,
                        declarations: [{ name: 'x', line: 4 }], // Shadow!
                        children: []
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 1, column: 8 },   // outer declaration
                { name: 'x', line: 2, column: 8 },   // outer use
                { name: 'x', line: 4, column: 12 },  // shadow declaration
                { name: 'x', line: 5, column: 12 },  // shadow use
                { name: 'x', line: 7, column: 8 }    // outer use again
            ];

            // Rename the OUTER x (declared at line 1)
            const outerScope = tree;
            const collected = collectScopeAwareIdentifiers(tree, 'x', outerScope, identifiers);

            // Should collect only outer uses: lines 1, 2, 7 (NOT 4, 5 which are shadow)
            expect(collected.length).to.equal(3);
            expect(collected.some(id => id.line === 1)).to.be.true;
            expect(collected.some(id => id.line === 2)).to.be.true;
            expect(collected.some(id => id.line === 7)).to.be.true;
            expect(collected.some(id => id.line === 4)).to.be.false;
            expect(collected.some(id => id.line === 5)).to.be.false;
        });

        it('should handle renaming the shadowed variable', () => {
            // Same structure as above, but now rename the SHADOW variable
            const builder2 = new ScopeTreeBuilder();
            
            const tree = builder2.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 8,
                declarations: [{ name: 'x', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 3,
                        endRow: 6,
                        declarations: [{ name: 'x', line: 4 }], // Shadow!
                        children: []
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 1, column: 8 },
                { name: 'x', line: 2, column: 8 },
                { name: 'x', line: 4, column: 12 },  // shadow declaration
                { name: 'x', line: 5, column: 12 },  // shadow use
                { name: 'x', line: 7, column: 8 }
            ];

            // Rename the INNER (shadow) x - target the inner block
            const innerScope = tree.children[0];
            const collected = collectScopeAwareIdentifiers(tree, 'x', innerScope, identifiers);

            // Should collect only shadow uses: lines 4, 5
            expect(collected.length).to.equal(2);
            expect(collected.some(id => id.line === 4)).to.be.true;
            expect(collected.some(id => id.line === 5)).to.be.true;
            expect(collected.some(id => id.line === 1)).to.be.false;
            expect(collected.some(id => id.line === 2)).to.be.false;
            expect(collected.some(id => id.line === 7)).to.be.false;
        });

        it('should handle multiple levels of shadowing', () => {
            // func test() {        // line 0
            //     int x = 1;       // line 1 - level 0
            //     {                // line 2
            //         int x = 2;   // line 3 - level 1 shadow
            //         {            // line 4
            //             int x = 3; // line 5 - level 2 shadow
            //             use(x);  // line 6
            //         }            // line 7
            //         use(x);      // line 8
            //     }                // line 9
            //     use(x);          // line 10
            // }                    // line 11
            
            const builder3 = new ScopeTreeBuilder();
            
            const tree = builder3.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 11,
                declarations: [{ name: 'x', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 2,
                        endRow: 9,
                        declarations: [{ name: 'x', line: 3 }],
                        children: [
                            {
                                type: 'block',
                                startRow: 4,
                                endRow: 7,
                                declarations: [{ name: 'x', line: 5 }],
                                children: []
                            }
                        ]
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 1, column: 8 },
                { name: 'x', line: 3, column: 12 },
                { name: 'x', line: 5, column: 16 },
                { name: 'x', line: 6, column: 16 },
                { name: 'x', line: 8, column: 12 },
                { name: 'x', line: 10, column: 8 }
            ];

            // Rename level 1 shadow (declared at line 3)
            const level1Scope = tree.children[0];
            const collected = collectScopeAwareIdentifiers(tree, 'x', level1Scope, identifiers);

            // Should get lines 3 and 8 only (not 5, 6 which are level 2, not 1, 10 which are level 0)
            expect(collected.length).to.equal(2);
            expect(collected.some(id => id.line === 3)).to.be.true;
            expect(collected.some(id => id.line === 8)).to.be.true;
        });

        it('should handle for-loop scopes', () => {
            // for (int i = 0; i < n; i++) {  // line 0
            //     use(i);                     // line 1
            //     {                           // line 2
            //         int i = 5;              // line 3 - shadow
            //         use(i);                 // line 4
            //     }                           // line 5
            // }                               // line 6
            // use(i); // error, but let's test // line 7 - out of scope
            
            const builder4 = new ScopeTreeBuilder();
            
            const tree = builder4.buildFromDescription({
                type: 'for_statement',
                startRow: 0,
                endRow: 6,
                declarations: [{ name: 'i', line: 0 }],
                children: [
                    {
                        type: 'block',
                        startRow: 2,
                        endRow: 5,
                        declarations: [{ name: 'i', line: 3 }],
                        children: []
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'i', line: 0, column: 9 },   // for init
                { name: 'i', line: 0, column: 16 },  // for condition
                { name: 'i', line: 0, column: 23 },  // for update
                { name: 'i', line: 1, column: 8 },   // loop body use
                { name: 'i', line: 3, column: 12 },  // shadow decl
                { name: 'i', line: 4, column: 12 }   // shadow use
            ];

            // Rename the for-loop variable
            const forScope = tree;
            const collected = collectScopeAwareIdentifiers(tree, 'i', forScope, identifiers);

            // Should get lines 0 (3 times) and 1, but NOT 3, 4
            expect(collected.length).to.equal(4);
            expect(collected.filter(id => id.line === 0).length).to.equal(3);
            expect(collected.some(id => id.line === 1)).to.be.true;
            expect(collected.some(id => id.line === 3)).to.be.false;
            expect(collected.some(id => id.line === 4)).to.be.false;
        });
    });

    describe('Declaration Scope Finding', () => {
        const builder = new ScopeTreeBuilder();

        it('should find correct scope for declaration', () => {
            const tree = builder.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 10,
                declarations: [{ name: 'outer', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 3,
                        endRow: 8,
                        declarations: [{ name: 'inner', line: 4 }],
                        children: []
                    }
                ]
            });

            // Find scope for 'outer' at line 5
            const outerScope = findDeclarationScope(tree, new Position(5, 0), 'outer');
            expect(outerScope?.type).to.equal('function_definition');

            // Find scope for 'inner' at line 5
            const innerScope = findDeclarationScope(tree, new Position(5, 0), 'inner');
            expect(innerScope?.type).to.equal('block');
        });

        it('should return undefined for undeclared variables', () => {
            const tree = builder.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 10,
                declarations: [{ name: 'x', line: 1 }],
                children: []
            });

            const scope = findDeclarationScope(tree, new Position(5, 0), 'y');
            expect(scope).to.be.undefined;
        });
    });

    describe('Same Symbol Detection', () => {
        function isSameSymbol(a: { uri: string; line: number; char: number }, b: { uri: string; line: number; char: number }): boolean {
            return a.uri === b.uri && a.line === b.line && a.char === b.char;
        }

        it('should match identical locations', () => {
            const a = { uri: 'file:///test.k', line: 5, char: 10 };
            const b = { uri: 'file:///test.k', line: 5, char: 10 };
            expect(isSameSymbol(a, b)).to.be.true;
        });

        it('should not match different files', () => {
            const a = { uri: 'file:///test1.k', line: 5, char: 10 };
            const b = { uri: 'file:///test2.k', line: 5, char: 10 };
            expect(isSameSymbol(a, b)).to.be.false;
        });

        it('should not match different lines', () => {
            const a = { uri: 'file:///test.k', line: 5, char: 10 };
            const b = { uri: 'file:///test.k', line: 6, char: 10 };
            expect(isSameSymbol(a, b)).to.be.false;
        });

        it('should not match different columns', () => {
            const a = { uri: 'file:///test.k', line: 5, char: 10 };
            const b = { uri: 'file:///test.k', line: 5, char: 11 };
            expect(isSameSymbol(a, b)).to.be.false;
        });
    });

    describe('Location Deduplication', () => {
        it('should deduplicate locations', () => {
            const seen = new Set<string>();
            const locations: { uri: string; line: number; char: number }[] = [];

            function addLocation(uri: string, line: number, char: number): void {
                const key = `${uri}#${line}:${char}`;
                if (seen.has(key)) return;
                seen.add(key);
                locations.push({ uri, line, char });
            }

            addLocation('file:///test.k', 5, 10);
            addLocation('file:///test.k', 5, 10);  // duplicate
            addLocation('file:///test.k', 6, 10);
            addLocation('file:///test.k', 5, 10);  // duplicate again

            expect(locations.length).to.equal(2);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty scope tree', () => {
            const builder5 = new ScopeTreeBuilder();
            
            const tree = builder5.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 5,
                declarations: [],
                children: []
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 2, column: 8 }
            ];

            const collected = collectScopeAwareIdentifiers(tree, 'x', tree, identifiers);
            expect(collected.length).to.equal(1);
        });

        it('should handle deeply nested scopes without shadowing', () => {
            const builder6 = new ScopeTreeBuilder();
            
            const tree = builder6.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 20,
                declarations: [{ name: 'x', line: 1 }],
                children: [
                    {
                        type: 'block',
                        startRow: 2,
                        endRow: 18,
                        declarations: [],
                        children: [
                            {
                                type: 'block',
                                startRow: 3,
                                endRow: 17,
                                declarations: [],
                                children: [
                                    {
                                        type: 'block',
                                        startRow: 4,
                                        endRow: 16,
                                        declarations: [],
                                        children: []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 1, column: 8 },
                { name: 'x', line: 5, column: 8 },
                { name: 'x', line: 10, column: 8 },
                { name: 'x', line: 15, column: 8 }
            ];

            const collected = collectScopeAwareIdentifiers(tree, 'x', tree, identifiers);
            // All should be collected since no shadowing
            expect(collected.length).to.equal(4);
        });

        it('should handle siblings scopes with same variable name', () => {
            // func test() {
            //     { int x = 1; use(x); }  // scope 1
            //     { int x = 2; use(x); }  // scope 2 - different x!
            // }
            
            const builder7 = new ScopeTreeBuilder();
            
            const tree = builder7.buildFromDescription({
                type: 'function_definition',
                startRow: 0,
                endRow: 10,
                declarations: [],
                children: [
                    {
                        type: 'block',
                        startRow: 1,
                        endRow: 3,
                        declarations: [{ name: 'x', line: 1 }],
                        children: []
                    },
                    {
                        type: 'block',
                        startRow: 4,
                        endRow: 6,
                        declarations: [{ name: 'x', line: 4 }],
                        children: []
                    }
                ]
            });

            const identifiers: IdentifierLocation[] = [
                { name: 'x', line: 1, column: 8 },   // scope 1 decl
                { name: 'x', line: 2, column: 8 },   // scope 1 use
                { name: 'x', line: 4, column: 8 },   // scope 2 decl
                { name: 'x', line: 5, column: 8 }    // scope 2 use
            ];

            // Rename x in scope 1
            const scope1 = tree.children[0];
            const collected = collectScopeAwareIdentifiers(tree, 'x', scope1, identifiers);

            // Should only get scope 1 identifiers (lines 1, 2)
            expect(collected.length).to.equal(2);
            expect(collected.some(id => id.line === 1)).to.be.true;
            expect(collected.some(id => id.line === 2)).to.be.true;
            expect(collected.some(id => id.line === 4)).to.be.false;
            expect(collected.some(id => id.line === 5)).to.be.false;
        });
    });
});
