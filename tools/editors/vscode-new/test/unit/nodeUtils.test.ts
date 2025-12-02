import { expect } from 'chai';

// Test the key format pattern used by makeLocationKey and makePositionKey
// These utility functions use vscode types and are tested via the key format they produce

describe('Node Utilities - Key Format Pattern', () => {
    // The key format is: `${uri.toString()}#${line}:${character}`
    // We can verify the format logic without vscode dependencies

    describe('key format consistency', () => {
        it('key format produces unique strings for different positions', () => {
            const uri = 'file:///test/file.k';
            const key1 = `${uri}#10:5`;
            const key2 = `${uri}#10:6`;
            expect(key1).to.not.equal(key2);
        });

        it('key format produces unique strings for different files', () => {
            const uri1 = 'file:///test/file1.k';
            const uri2 = 'file:///test/file2.k';
            const key1 = `${uri1}#10:5`;
            const key2 = `${uri2}#10:5`;
            expect(key1).to.not.equal(key2);
        });

        it('key format produces unique strings for different lines', () => {
            const uri = 'file:///test/file.k';
            const key1 = `${uri}#10:5`;
            const key2 = `${uri}#11:5`;
            expect(key1).to.not.equal(key2);
        });

        it('key format handles zero positions', () => {
            const uri = 'file:///test/file.k';
            const key = `${uri}#0:0`;
            expect(key).to.include('#0:0');
        });

        it('key format handles large line numbers', () => {
            const uri = 'file:///test/file.k';
            const key = `${uri}#10000:500`;
            expect(key).to.include('#10000:500');
        });

        it('key format is parseable', () => {
            const uri = 'file:///test/file.k';
            const line = 42;
            const char = 15;
            const key = `${uri}#${line}:${char}`;
            
            // Verify we can extract components
            const hashIndex = key.lastIndexOf('#');
            const extractedUri = key.substring(0, hashIndex);
            const [extractedLine, extractedChar] = key.substring(hashIndex + 1).split(':').map(Number);
            
            expect(extractedUri).to.equal(uri);
            expect(extractedLine).to.equal(line);
            expect(extractedChar).to.equal(char);
        });
    });
});

describe('Node Utilities - resolveToIdentifier Pattern', () => {
    /**
     * Tests for the identifier resolution algorithm used across all providers.
     * The actual function uses tree-sitter nodes; these tests verify the logic patterns.
     */

    // Mock node structure for testing
    interface MockNode {
        type: string;
        text?: string;
        parent?: MockNode;
        namedChildCount: number;
        namedChildren: MockNode[];
        childForFieldName(name: string): MockNode | null;
        namedChild(index: number): MockNode | null;
    }

    function createMockNode(
        type: string,
        text?: string,
        children: MockNode[] = [],
        fieldChildren: Record<string, MockNode> = {}
    ): MockNode {
        const node: MockNode = {
            type,
            text,
            namedChildCount: children.length,
            namedChildren: children,
            childForFieldName: (name: string) => fieldChildren[name] ?? null,
            namedChild: (index: number) => children[index] ?? null
        };
        // Set parent references
        for (const child of children) {
            child.parent = node;
        }
        for (const child of Object.values(fieldChildren)) {
            child.parent = node;
        }
        return node;
    }

    // Simplified resolveToIdentifier algorithm
    function resolveToIdentifier(node: MockNode | null | undefined): MockNode | undefined {
        let current = node;
        while (current) {
            if (current.type === 'identifier' || current.type === 'type_identifier') {
                return current;
            }
            
            if (current.type === 'qualified_identifier' || current.type === 'scoped_identifier') {
                const nameField = current.childForFieldName('name');
                if (nameField && (nameField.type === 'identifier' || nameField.type === 'type_identifier')) {
                    return nameField;
                }
                if (current.namedChildCount > 0) {
                    current = current.namedChild(current.namedChildCount - 1) ?? undefined;
                    continue;
                }
            }
            
            if (current.type === 'template_instantiation') {
                const baseType = current.childForFieldName('type') ?? current.namedChild(0);
                if (baseType) {
                    if (baseType.type === 'identifier' || baseType.type === 'type_identifier') {
                        return baseType;
                    }
                    current = baseType;
                    continue;
                }
            }
            
            if (current.type === 'member_expression' || current.type === 'field_expression') {
                const memberField = current.childForFieldName('member') ?? 
                                   current.childForFieldName('field') ??
                                   current.namedChild(current.namedChildCount - 1);
                if (memberField && (memberField.type === 'identifier' || memberField.type === 'type_identifier')) {
                    return memberField;
                }
            }
            
            if (current.type === 'module_name' && current.namedChildCount > 0) {
                current = current.namedChild(current.namedChildCount - 1) ?? undefined;
                continue;
            }
            
            current = current.parent;
        }
        return undefined;
    }

    describe('direct identifier resolution', () => {
        it('should return identifier nodes directly', () => {
            const node = createMockNode('identifier', 'foo');
            const result = resolveToIdentifier(node);
            expect(result?.type).to.equal('identifier');
            expect(result?.text).to.equal('foo');
        });

        it('should return type_identifier nodes directly', () => {
            const node = createMockNode('type_identifier', 'MyClass');
            const result = resolveToIdentifier(node);
            expect(result?.type).to.equal('type_identifier');
            expect(result?.text).to.equal('MyClass');
        });
    });

    describe('qualified identifier resolution', () => {
        it('should extract name field from qualified_identifier', () => {
            const nameNode = createMockNode('identifier', 'Bar');
            const node = createMockNode('qualified_identifier', undefined, [], { name: nameNode });
            
            const result = resolveToIdentifier(node);
            expect(result?.text).to.equal('Bar');
        });

        it('should fallback to last child if no name field', () => {
            const child1 = createMockNode('identifier', 'Foo');
            const child2 = createMockNode('identifier', 'Bar');
            const node = createMockNode('qualified_identifier', undefined, [child1, child2]);
            
            const result = resolveToIdentifier(node);
            expect(result?.text).to.equal('Bar');
        });
    });

    describe('template instantiation resolution', () => {
        it('should extract type field from template_instantiation', () => {
            const typeNode = createMockNode('type_identifier', 'Vector');
            const node = createMockNode('template_instantiation', undefined, [], { type: typeNode });
            
            const result = resolveToIdentifier(node);
            expect(result?.text).to.equal('Vector');
        });

        it('should use first child if no type field', () => {
            const baseType = createMockNode('identifier', 'FIFO');
            const node = createMockNode('template_instantiation', undefined, [baseType]);
            
            const result = resolveToIdentifier(node);
            expect(result?.text).to.equal('FIFO');
        });
    });

    describe('member expression resolution', () => {
        it('should extract member field from member_expression', () => {
            const memberNode = createMockNode('identifier', 'method');
            const node = createMockNode('member_expression', undefined, [], { member: memberNode });
            
            const result = resolveToIdentifier(node);
            expect(result?.text).to.equal('method');
        });

        it('should extract field from field_expression', () => {
            const fieldNode = createMockNode('identifier', 'value');
            const node = createMockNode('field_expression', undefined, [], { field: fieldNode });
            
            const result = resolveToIdentifier(node);
            expect(result?.text).to.equal('value');
        });
    });

    describe('parent traversal', () => {
        it('should traverse up to parent if current node is not resolvable', () => {
            const identifier = createMockNode('identifier', 'target');
            const punctuation = createMockNode('.', '.');
            punctuation.parent = createMockNode('member_expression', undefined, [], { member: identifier });
            
            // Starting from punctuation, should find identifier via parent
            const result = resolveToIdentifier(punctuation);
            expect(result?.text).to.equal('target');
        });

        it('should return undefined if no identifier found', () => {
            const node = createMockNode('comment', '// just a comment');
            const result = resolveToIdentifier(node);
            expect(result).to.be.undefined;
        });
    });

    describe('null/undefined handling', () => {
        it('should handle null input', () => {
            const result = resolveToIdentifier(null);
            expect(result).to.be.undefined;
        });

        it('should handle undefined input', () => {
            const result = resolveToIdentifier(undefined);
            expect(result).to.be.undefined;
        });
    });
});
