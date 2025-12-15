//! Test for bitoffsetof/byteoffsetof callee IdentExpr parsing.

use kanagawa_syntax::{parse_file, SyntaxKind};

#[test]
fn bitoffsetof_has_callee_identexpr() {
    // Test that bitoffsetof produces a CallExpr with an IdentExpr callee
    let code = r#"
        struct Foo {
            uint32 x;
            uint16 y;
        }
        inline void test() {
            const auto offset = bitoffsetof(Foo, y);
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    // Find the CallExpr for bitoffsetof
    let root = parse.syntax_node();
    let call_expr = root.descendants()
        .find(|n| {
            n.kind() == SyntaxKind::CallExpr &&
            n.text().to_string().contains("bitoffsetof")
        })
        .expect("Expected to find bitoffsetof CallExpr");

    // Check that it has an IdentExpr child (the callee)
    let has_ident_callee = call_expr.children()
        .any(|c| c.kind() == SyntaxKind::IdentExpr);

    assert!(has_ident_callee, "CallExpr should have IdentExpr callee");
}

#[test]
fn byteoffsetof_has_callee_identexpr() {
    // Test that byteoffsetof produces a CallExpr with an IdentExpr callee
    let code = r#"
        struct Bar {
            uint8 a;
            uint32 b;
        }
        inline void test() {
            const auto offset = byteoffsetof(Bar, b);
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    // Find the CallExpr for byteoffsetof
    let root = parse.syntax_node();
    let call_expr = root.descendants()
        .find(|n| {
            n.kind() == SyntaxKind::CallExpr &&
            n.text().to_string().contains("byteoffsetof")
        })
        .expect("Expected to find byteoffsetof CallExpr");

    // Check that it has an IdentExpr child (the callee)
    let has_ident_callee = call_expr.children()
        .any(|c| c.kind() == SyntaxKind::IdentExpr);

    assert!(has_ident_callee, "CallExpr should have IdentExpr callee");
}
