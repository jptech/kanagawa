import { expect } from 'chai';
import { extractQualifiedStaticMemberContext, SyntaxNodeLike } from '../../src/utils/qualifiedIdentifierUtils';

function createMockNode(
    type: string,
    text: string,
    children: SyntaxNodeLike[] = [],
    id: number = Math.floor(Math.random() * 1_000_000)
): SyntaxNodeLike {
    const node: SyntaxNodeLike = {
        id,
        type,
        text,
        parent: null,
        namedChildCount: children.length,
        namedChildren: children,
        namedChild: (index: number) => children[index] ?? null
    };

    for (const child of children) {
        child.parent = node;
    }

    return node;
}

describe('qualifiedIdentifierUtils', () => {
    it('extracts static member context for `EnumType::Value` when hovering Value', () => {
        const enumType = createMockNode('identifier', 'EnumType', [], 1);
        const value = createMockNode('identifier', 'Value', [], 2);
        createMockNode('qualified_identifier', '', [enumType, value], 100);

        const ctx = extractQualifiedStaticMemberContext(value);
        expect(ctx).to.not.equal(undefined);
        expect(ctx!.containerName).to.equal('EnumType');
        expect(ctx!.memberName).to.equal('Value');
    });

    it('returns undefined when hovering the container (EnumType)', () => {
        const enumType = createMockNode('identifier', 'EnumType', [], 1);
        const value = createMockNode('identifier', 'Value', [], 2);
        createMockNode('qualified_identifier', '', [enumType, value], 100);

        const ctx = extractQualifiedStaticMemberContext(enumType);
        expect(ctx).to.equal(undefined);
    });

    it('returns undefined for non-qualified identifiers', () => {
        const id = createMockNode('identifier', 'Value', [], 1);
        expect(extractQualifiedStaticMemberContext(id)).to.equal(undefined);
    });

    it('handles longer chains by using the immediate container', () => {
        const a = createMockNode('identifier', 'A', [], 1);
        const b = createMockNode('identifier', 'B', [], 2);
        const c = createMockNode('identifier', 'C', [], 3);
        createMockNode('qualified_identifier', '', [a, b, c], 100);

        const ctx = extractQualifiedStaticMemberContext(c);
        expect(ctx).to.not.equal(undefined);
        expect(ctx!.containerName).to.equal('B');
        expect(ctx!.memberName).to.equal('C');
    });
});
