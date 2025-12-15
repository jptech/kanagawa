use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn has(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

#[test]
fn parses_specific_type_nodes_as_structured_cst() {
    let src = r#"
        using memory_quad_port = [[memory, quad_port]] uint32[8];

        inline void main() {
            uint32[4] xs;
            (uint32)->uint8 fptr;
            typename Foo::Bar dep;
            decltype(1 + 2 * 3) dt;
            return;
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();

    assert!(has(&root, SyntaxKind::TypeArray), "expected TypeArray");
    assert!(has(&root, SyntaxKind::TypeArrayDim), "expected TypeArrayDim");

    assert!(has(&root, SyntaxKind::TypeFunction), "expected TypeFunction");
    assert!(
        has(&root, SyntaxKind::TypeFunctionParams),
        "expected TypeFunctionParams"
    );

    assert!(has(&root, SyntaxKind::TypeTypename), "expected TypeTypename");
    assert!(has(&root, SyntaxKind::TypePath), "expected TypePath");

    assert!(has(&root, SyntaxKind::TypeDecltype), "expected TypeDecltype");

    // `decltype(...)` should contain a structured paren expression and expression subtree.
    let decltype_node = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::TypeDecltype)
        .expect("expected a TypeDecltype node");
    assert!(
        decltype_node
            .descendants()
            .any(|n| n.kind() == SyntaxKind::ParenExpr),
        "expected decltype to contain ParenExpr"
    );
    assert!(
        decltype_node
            .descendants()
            .any(|n| n.kind() == SyntaxKind::BinaryExpr),
        "expected decltype to contain a BinaryExpr"
    );

    // Type-leading attributes (used for memory/array intent) should parse as `Attrs` inside the type.
    assert!(has(&root, SyntaxKind::Attrs), "expected Attrs in type context");
}
