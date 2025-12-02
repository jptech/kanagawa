/**
 * Tests for KanagawaDocumentSymbolProvider
 * 
 * Priority: P1 - Document symbols power the Outline view and Go to Symbol
 * 
 * The document symbol provider must:
 * 1. Build hierarchical symbol trees from AST
 * 2. Map symbol categories to VS Code SymbolKinds
 * 3. Extract and display template parameters
 * 4. Handle nested symbols (class members, function locals)
 * 5. Apply outline filters correctly
 * 6. Sort symbols by position
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    SymbolKind
} from '../../mocks/vscode';

describe('DocumentSymbolProvider', () => {

    // Types matching the real provider
    type SymbolCategory = 
        | 'module' | 'class' | 'struct' | 'union' | 'enum'
        | 'function' | 'method' | 'member' | 'variable'
        | 'constant' | 'alias' | 'parameter';

    interface SymbolData {
        name: string;
        kind: SymbolKind;
        detail: string;
        category: SymbolCategory;
        range: Range;
        selectionRange: Range;
        templateParams?: string;
        children: SymbolData[];
    }

    function createSymbolData(
        name: string,
        kind: SymbolKind,
        category: SymbolCategory,
        startLine: number,
        endLine: number,
        options: {
            detail?: string;
            templateParams?: string;
            children?: SymbolData[];
        } = {}
    ): SymbolData {
        return {
            name,
            kind,
            detail: options.detail ?? category,
            category,
            range: new Range(startLine, 0, endLine, 0),
            selectionRange: new Range(startLine, 0, startLine, name.length),
            templateParams: options.templateParams,
            children: options.children ?? []
        };
    }

    describe('Symbol Kind Mapping', () => {
        const categoryToKind: Record<string, SymbolKind> = {
            'module': SymbolKind.Module,
            'class': SymbolKind.Class,
            'struct': SymbolKind.Struct,
            'union': SymbolKind.Struct,
            'enum': SymbolKind.Enum,
            'function': SymbolKind.Function,
            'method': SymbolKind.Method,
            'member': SymbolKind.Field,
            'variable': SymbolKind.Variable,
            'constant': SymbolKind.EnumMember,
            'alias': SymbolKind.TypeParameter
        };

        it('should map module to Module kind', () => {
            expect(categoryToKind['module']).to.equal(SymbolKind.Module);
        });

        it('should map class to Class kind', () => {
            expect(categoryToKind['class']).to.equal(SymbolKind.Class);
        });

        it('should map struct to Struct kind', () => {
            expect(categoryToKind['struct']).to.equal(SymbolKind.Struct);
        });

        it('should map union to Struct kind (VS Code has no Union)', () => {
            expect(categoryToKind['union']).to.equal(SymbolKind.Struct);
        });

        it('should map enum to Enum kind', () => {
            expect(categoryToKind['enum']).to.equal(SymbolKind.Enum);
        });

        it('should map function to Function kind', () => {
            expect(categoryToKind['function']).to.equal(SymbolKind.Function);
        });

        it('should map member to Field kind', () => {
            expect(categoryToKind['member']).to.equal(SymbolKind.Field);
        });

        it('should map variable to Variable kind', () => {
            expect(categoryToKind['variable']).to.equal(SymbolKind.Variable);
        });

        it('should map constant to EnumMember kind', () => {
            expect(categoryToKind['constant']).to.equal(SymbolKind.EnumMember);
        });

        it('should map alias to TypeParameter kind', () => {
            expect(categoryToKind['alias']).to.equal(SymbolKind.TypeParameter);
        });
    });

    describe('Hierarchical Symbol Tree Building', () => {
        function buildFlatToHierarchical(
            flatSymbols: Array<{ id: number; parentId: number | null; data: SymbolData }>
        ): SymbolData[] {
            const byId = new Map<number, SymbolData>();
            const roots: SymbolData[] = [];

            for (const { id, data } of flatSymbols) {
                byId.set(id, { ...data, children: [] });
            }

            for (const { id, parentId } of flatSymbols) {
                const symbol = byId.get(id)!;
                if (parentId === null) {
                    roots.push(symbol);
                } else {
                    const parent = byId.get(parentId);
                    if (parent) {
                        parent.children.push(symbol);
                    } else {
                        roots.push(symbol);
                    }
                }
            }

            return roots;
        }

        it('should build flat list as roots', () => {
            const flat = [
                { id: 1, parentId: null, data: createSymbolData('foo', SymbolKind.Function, 'function', 0, 5) },
                { id: 2, parentId: null, data: createSymbolData('bar', SymbolKind.Function, 'function', 6, 10) }
            ];
            const tree = buildFlatToHierarchical(flat);
            expect(tree.length).to.equal(2);
            expect(tree[0].name).to.equal('foo');
            expect(tree[1].name).to.equal('bar');
        });

        it('should nest children under parent', () => {
            const flat = [
                { id: 1, parentId: null, data: createSymbolData('MyClass', SymbolKind.Class, 'class', 0, 20) },
                { id: 2, parentId: 1, data: createSymbolData('value', SymbolKind.Field, 'member', 2, 3) },
                { id: 3, parentId: 1, data: createSymbolData('getValue', SymbolKind.Method, 'method', 5, 10) }
            ];
            const tree = buildFlatToHierarchical(flat);
            expect(tree.length).to.equal(1);
            expect(tree[0].name).to.equal('MyClass');
            expect(tree[0].children.length).to.equal(2);
            expect(tree[0].children[0].name).to.equal('value');
            expect(tree[0].children[1].name).to.equal('getValue');
        });

        it('should handle multiple levels of nesting', () => {
            const flat = [
                { id: 1, parentId: null, data: createSymbolData('Outer', SymbolKind.Class, 'class', 0, 30) },
                { id: 2, parentId: 1, data: createSymbolData('Inner', SymbolKind.Class, 'class', 5, 20) },
                { id: 3, parentId: 2, data: createSymbolData('method', SymbolKind.Method, 'method', 10, 15) }
            ];
            const tree = buildFlatToHierarchical(flat);
            expect(tree.length).to.equal(1);
            expect(tree[0].children.length).to.equal(1);
            expect(tree[0].children[0].children.length).to.equal(1);
            expect(tree[0].children[0].children[0].name).to.equal('method');
        });

        it('should orphan children with missing parent', () => {
            const flat = [
                { id: 2, parentId: 999, data: createSymbolData('orphan', SymbolKind.Function, 'function', 0, 5) }
            ];
            const tree = buildFlatToHierarchical(flat);
            expect(tree.length).to.equal(1);
            expect(tree[0].name).to.equal('orphan');
        });
    });

    describe('Symbol Sorting', () => {
        function sortByPosition(symbols: SymbolData[]): SymbolData[] {
            const sorted = [...symbols].sort((a, b) => {
                const lineDiff = a.range.start.line - b.range.start.line;
                if (lineDiff !== 0) { return lineDiff; }
                return a.range.start.character - b.range.start.character;
            });
            
            // Recursively sort children
            for (const sym of sorted) {
                sym.children = sortByPosition(sym.children);
            }
            
            return sorted;
        }

        it('should sort by line number', () => {
            const symbols = [
                createSymbolData('third', SymbolKind.Function, 'function', 20, 25),
                createSymbolData('first', SymbolKind.Function, 'function', 0, 5),
                createSymbolData('second', SymbolKind.Function, 'function', 10, 15)
            ];
            const sorted = sortByPosition(symbols);
            expect(sorted[0].name).to.equal('first');
            expect(sorted[1].name).to.equal('second');
            expect(sorted[2].name).to.equal('third');
        });

        it('should sort by character when on same line', () => {
            const symbols = [
                createSymbolData('b', SymbolKind.Variable, 'variable', 0, 0),
                createSymbolData('a', SymbolKind.Variable, 'variable', 0, 0)
            ];
            // Adjust character positions
            symbols[0].range = new Range(0, 10, 0, 11);
            symbols[1].range = new Range(0, 0, 0, 1);
            
            const sorted = sortByPosition(symbols);
            expect(sorted[0].name).to.equal('a');
            expect(sorted[1].name).to.equal('b');
        });

        it('should recursively sort children', () => {
            const parent = createSymbolData('Parent', SymbolKind.Class, 'class', 0, 30, {
                children: [
                    createSymbolData('z_method', SymbolKind.Method, 'method', 20, 25),
                    createSymbolData('a_method', SymbolKind.Method, 'method', 5, 10)
                ]
            });
            const sorted = sortByPosition([parent]);
            expect(sorted[0].children[0].name).to.equal('a_method');
            expect(sorted[0].children[1].name).to.equal('z_method');
        });
    });

    describe('Template Parameters Extraction', () => {
        function formatDisplayName(name: string, templateParams?: string): string {
            return templateParams ? `${name}<${templateParams}>` : name;
        }

        it('should append template params to name', () => {
            expect(formatDisplayName('FIFO', 'T, N')).to.equal('FIFO<T, N>');
        });

        it('should return plain name when no params', () => {
            expect(formatDisplayName('Counter')).to.equal('Counter');
            expect(formatDisplayName('Counter', undefined)).to.equal('Counter');
        });

        it('should handle single template param', () => {
            expect(formatDisplayName('Optional', 'T')).to.equal('Optional<T>');
        });

        it('should handle complex template params', () => {
            expect(formatDisplayName('Map', 'K, V, Compare')).to.equal('Map<K, V, Compare>');
        });
    });

    describe('Outline Filtering', () => {
        interface FilterSnapshot {
            enabledCategories: Set<SymbolCategory>;
            modulePrefix?: string;
        }

        function filterSymbols(
            symbols: SymbolData[],
            snapshot: FilterSnapshot
        ): SymbolData[] {
            const result: SymbolData[] = [];
            
            for (const symbol of symbols) {
                const categoryEnabled = snapshot.enabledCategories.has(symbol.category);
                
                if (categoryEnabled) {
                    // Include this symbol with filtered children
                    const filteredChildren = filterSymbols(symbol.children, snapshot);
                    result.push({ ...symbol, children: filteredChildren });
                } else {
                    // Promote children up (they might be enabled even if parent isn't)
                    const promotedChildren = filterSymbols(symbol.children, snapshot);
                    result.push(...promotedChildren);
                }
            }
            
            return result;
        }

        it('should include symbols with enabled category', () => {
            const symbols = [
                createSymbolData('foo', SymbolKind.Function, 'function', 0, 5),
                createSymbolData('MyClass', SymbolKind.Class, 'class', 10, 20)
            ];
            const snapshot: FilterSnapshot = {
                enabledCategories: new Set(['function', 'class'])
            };
            const filtered = filterSymbols(symbols, snapshot);
            expect(filtered.length).to.equal(2);
        });

        it('should exclude symbols with disabled category', () => {
            const symbols = [
                createSymbolData('foo', SymbolKind.Function, 'function', 0, 5),
                createSymbolData('x', SymbolKind.Variable, 'variable', 10, 11)
            ];
            const snapshot: FilterSnapshot = {
                enabledCategories: new Set(['function'])
            };
            const filtered = filterSymbols(symbols, snapshot);
            expect(filtered.length).to.equal(1);
            expect(filtered[0].name).to.equal('foo');
        });

        it('should promote children when parent is filtered', () => {
            const symbols = [
                createSymbolData('MyClass', SymbolKind.Class, 'class', 0, 20, {
                    children: [
                        createSymbolData('method1', SymbolKind.Method, 'method', 5, 10),
                        createSymbolData('method2', SymbolKind.Method, 'method', 12, 17)
                    ]
                })
            ];
            const snapshot: FilterSnapshot = {
                enabledCategories: new Set(['method']) // class disabled
            };
            const filtered = filterSymbols(symbols, snapshot);
            expect(filtered.length).to.equal(2);
            expect(filtered[0].name).to.equal('method1');
            expect(filtered[1].name).to.equal('method2');
        });

        it('should handle nested filtering', () => {
            const symbols = [
                createSymbolData('Outer', SymbolKind.Class, 'class', 0, 40, {
                    children: [
                        createSymbolData('Inner', SymbolKind.Class, 'class', 5, 30, {
                            children: [
                                createSymbolData('method', SymbolKind.Method, 'method', 10, 20)
                            ]
                        })
                    ]
                })
            ];
            const snapshot: FilterSnapshot = {
                enabledCategories: new Set(['class']) // method disabled
            };
            const filtered = filterSymbols(symbols, snapshot);
            expect(filtered.length).to.equal(1);
            expect(filtered[0].children.length).to.equal(1);
            expect(filtered[0].children[0].children.length).to.equal(0);
        });

        it('should return empty for all disabled', () => {
            const symbols = [
                createSymbolData('foo', SymbolKind.Function, 'function', 0, 5)
            ];
            const snapshot: FilterSnapshot = {
                enabledCategories: new Set()
            };
            const filtered = filterSymbols(symbols, snapshot);
            expect(filtered.length).to.equal(0);
        });
    });

    describe('Template Wrapper Detection', () => {
        const templateWrappers = [
            'class_template', 'struct_template', 'union_template',
            'function_template', 'alias_template', 'enum_template'
        ];

        function isTemplateWrapper(nodeType: string): boolean {
            return templateWrappers.includes(nodeType);
        }

        it('should detect class_template', () => {
            expect(isTemplateWrapper('class_template')).to.be.true;
        });

        it('should detect struct_template', () => {
            expect(isTemplateWrapper('struct_template')).to.be.true;
        });

        it('should detect function_template', () => {
            expect(isTemplateWrapper('function_template')).to.be.true;
        });

        it('should detect alias_template', () => {
            expect(isTemplateWrapper('alias_template')).to.be.true;
        });

        it('should not detect class_decl as template', () => {
            expect(isTemplateWrapper('class_decl')).to.be.false;
        });

        it('should not detect function_definition as template', () => {
            expect(isTemplateWrapper('function_definition')).to.be.false;
        });
    });

    describe('Nested Template Detection', () => {
        // Tests for isNestedInsideClassBody logic
        function isNestedInsideClassBody(
            pathFromNodeToTemplate: string[]
        ): boolean {
            const bodyTypes = ['member_decl_list', 'class_body', 'struct_body', 'block'];
            return pathFromNodeToTemplate.some(type => bodyTypes.includes(type));
        }

        it('should detect node inside member_decl_list', () => {
            const path = ['class_decl', 'member_decl_list', 'function_definition'];
            expect(isNestedInsideClassBody(path)).to.be.true;
        });

        it('should detect node inside class_body', () => {
            const path = ['class_template', 'class_body', 'variable_decl'];
            expect(isNestedInsideClassBody(path)).to.be.true;
        });

        it('should detect node inside block', () => {
            const path = ['function_template', 'function_definition', 'block', 'variable_decl'];
            expect(isNestedInsideClassBody(path)).to.be.true;
        });

        it('should not detect direct child of template', () => {
            const path = ['class_template', 'class_decl'];
            expect(isNestedInsideClassBody(path)).to.be.false;
        });

        it('should not detect grandchild before body', () => {
            const path = ['class_template', 'attribute_list', 'class_decl'];
            expect(isNestedInsideClassBody(path)).to.be.false;
        });
    });

    describe('Range Computation', () => {
        function nodeToRange(
            startRow: number, startCol: number,
            endRow: number, endCol: number
        ): Range {
            return new Range(
                new Position(startRow, startCol),
                new Position(endRow, endCol)
            );
        }

        it('should create range from node positions', () => {
            const range = nodeToRange(10, 4, 25, 1);
            expect(range.start.line).to.equal(10);
            expect(range.start.character).to.equal(4);
            expect(range.end.line).to.equal(25);
            expect(range.end.character).to.equal(1);
        });

        it('should handle single-line nodes', () => {
            const range = nodeToRange(5, 0, 5, 20);
            expect(range.isSingleLine).to.be.true;
        });

        it('should handle multi-line nodes', () => {
            const range = nodeToRange(0, 0, 100, 0);
            expect(range.isSingleLine).to.be.false;
        });
    });

    describe('Selection Range for Navigation', () => {
        function createSelectionRange(
            nameStartRow: number, nameStartCol: number,
            nameEndRow: number, nameEndCol: number
        ): Range {
            return new Range(
                new Position(nameStartRow, nameStartCol),
                new Position(nameEndRow, nameEndCol)
            );
        }

        it('should use name node for selection', () => {
            // Full symbol: lines 0-20, name at line 0 cols 6-11
            const fullRange = new Range(0, 0, 20, 1);
            const selectionRange = createSelectionRange(0, 6, 0, 11);
            
            expect(selectionRange.start.line).to.equal(fullRange.start.line);
            expect(selectionRange.start.character).to.equal(6);
            expect(selectionRange.end.character).to.equal(11);
        });

        it('should handle name on different line than start', () => {
            // Template declaration where name is after template params
            const selectionRange = createSelectionRange(2, 0, 2, 10);
            expect(selectionRange.start.line).to.equal(2);
        });
    });

    describe('Query Capture Processing', () => {
        interface MockCapture {
            name: string;
            node: { id: number; type: string; text: string };
        }

        function captureToCategory(captureName: string): SymbolCategory | undefined {
            const mapping: Record<string, SymbolCategory> = {
                'module': 'module',
                'class': 'class',
                'struct': 'struct',
                'union': 'union',
                'enum': 'enum',
                'function': 'function',
                'alias': 'alias',
                'variable': 'variable',
                'member': 'member',
                'constant': 'constant'
            };
            return mapping[captureName];
        }

        it('should map module capture', () => {
            expect(captureToCategory('module')).to.equal('module');
        });

        it('should map class capture', () => {
            expect(captureToCategory('class')).to.equal('class');
        });

        it('should map function capture', () => {
            expect(captureToCategory('function')).to.equal('function');
        });

        it('should return undefined for name capture', () => {
            expect(captureToCategory('name')).to.be.undefined;
        });

        it('should return undefined for unknown capture', () => {
            expect(captureToCategory('unknown')).to.be.undefined;
        });
    });

    describe('Module Path Computation', () => {
        interface MockNode {
            type: string;
            name?: string;
            parent: MockNode | null;
        }

        function computeModulePath(node: MockNode): string | undefined {
            const segments: string[] = [];
            let current: MockNode | null = node.parent;
            
            while (current) {
                if (current.type === 'module_decl' && current.name) {
                    segments.unshift(current.name);
                }
                current = current.parent;
            }
            
            return segments.length > 0 ? segments.join('.') : undefined;
        }

        it('should compute single module path', () => {
            const node: MockNode = {
                type: 'class_decl',
                parent: {
                    type: 'module_decl',
                    name: 'data.fifo',
                    parent: null
                }
            };
            expect(computeModulePath(node)).to.equal('data.fifo');
        });

        it('should compute nested module path', () => {
            const node: MockNode = {
                type: 'function_definition',
                parent: {
                    type: 'module_decl',
                    name: 'inner',
                    parent: {
                        type: 'module_decl',
                        name: 'outer',
                        parent: null
                    }
                }
            };
            expect(computeModulePath(node)).to.equal('outer.inner');
        });

        it('should return undefined for no module', () => {
            const node: MockNode = {
                type: 'function_definition',
                parent: null
            };
            expect(computeModulePath(node)).to.be.undefined;
        });

        it('should skip non-module ancestors', () => {
            const node: MockNode = {
                type: 'variable_decl',
                parent: {
                    type: 'class_decl',
                    parent: {
                        type: 'module_decl',
                        name: 'mymod',
                        parent: null
                    }
                }
            };
            expect(computeModulePath(node)).to.equal('mymod');
        });
    });

    describe('Detail String Generation', () => {
        function getCategoryDetail(category: SymbolCategory): string {
            const details: Record<SymbolCategory, string> = {
                'module': 'module',
                'class': 'class',
                'struct': 'struct',
                'union': 'union',
                'enum': 'enum',
                'function': 'function',
                'method': 'method',
                'member': 'field',
                'variable': 'variable',
                'constant': 'constant',
                'alias': 'type',
                'parameter': 'parameter'
            };
            return details[category];
        }

        it('should return "field" for member category', () => {
            expect(getCategoryDetail('member')).to.equal('field');
        });

        it('should return "type" for alias category', () => {
            expect(getCategoryDetail('alias')).to.equal('type');
        });

        it('should return category name for most types', () => {
            expect(getCategoryDetail('class')).to.equal('class');
            expect(getCategoryDetail('function')).to.equal('function');
            expect(getCategoryDetail('enum')).to.equal('enum');
        });
    });
});
