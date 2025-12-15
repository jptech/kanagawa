use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn has(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

#[test]
fn parses_initializer_lists_as_structured_subtrees() {
    let src = r#"
        inline void main() {
            static Foo foo = {.field1 = 10, .field2 = false};
            static Bump b = { 3 };
            return;
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::DesignatedInitializerListExpr));
    assert!(has(&root, SyntaxKind::DesignatedInitializer));
    assert!(has(&root, SyntaxKind::InitializerListExpr));
}

#[test]
fn parses_return_initializer_list_expression() {
    let src = r#"
        inline uint32[4] f() {
            return {0, 1, 2, 3};
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::ReturnStmt));
    assert!(has(&root, SyntaxKind::InitializerListExpr));
}
