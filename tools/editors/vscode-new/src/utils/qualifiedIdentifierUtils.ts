/**
 * Utilities for working with qualified identifiers like `Foo::Bar`.
 *
 * Kept vscode-free so it can be unit tested under mocha without the VS Code runtime.
 */

export interface SyntaxNodeLike {
    id: number;
    type: string;
    text: string;
    parent: SyntaxNodeLike | null;
    namedChildCount: number;
    namedChild(index: number): SyntaxNodeLike | null;
    namedChildren: SyntaxNodeLike[];
}

export interface QualifiedStaticMemberContext {
    /** The container name (e.g., `EnumType`) */
    containerName: string;
    /** The member name (e.g., `Value`) */
    memberName: string;
}

/**
 * If `identifier` is the rightmost segment in a `qualified_identifier` chain,
 * returns the immediate container + member context.
 *
 * Example: for `EnumType::Value` when hovering `Value`, returns:
 * `{ containerName: "EnumType", memberName: "Value" }`
 */
export function extractQualifiedStaticMemberContext(
    identifier: SyntaxNodeLike | null | undefined
): QualifiedStaticMemberContext | undefined {
    if (!identifier) { return undefined; }

    // Walk up to a qualified identifier.
    let current: SyntaxNodeLike | null = identifier.parent;
    const MAX_DEPTH = 8;
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
        if (current.type === 'qualified_identifier' || current.type === 'scoped_identifier') {
            const idNodes = collectIdentifierSegments(current);
            if (idNodes.length < 2) { return undefined; }

            const last = idNodes[idNodes.length - 1];
            if (last.id !== identifier.id) {
                // We only handle the rightmost segment (the actual member).
                return undefined;
            }

            const container = idNodes[idNodes.length - 2];
            const containerName = container.text;
            const memberName = last.text;

            if (!containerName || !memberName) { return undefined; }
            return { containerName, memberName };
        }
        current = current.parent;
    }

    return undefined;
}

function collectIdentifierSegments(node: SyntaxNodeLike): SyntaxNodeLike[] {
    // Grammar yields identifiers as named children within qualified_identifier.
    // Be conservative: only accept identifier-ish nodes.
    const segments: SyntaxNodeLike[] = [];

    // Fast path: use namedChildren.
    for (const child of node.namedChildren ?? []) {
        if (child.type === 'identifier' || child.type === 'type_identifier') {
            segments.push(child);
        }
    }

    // Fallback: use namedChild(index).
    if (segments.length === 0 && node.namedChildCount > 0) {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (!child) { continue; }
            if (child.type === 'identifier' || child.type === 'type_identifier') {
                segments.push(child);
            }
        }
    }

    return segments;
}
