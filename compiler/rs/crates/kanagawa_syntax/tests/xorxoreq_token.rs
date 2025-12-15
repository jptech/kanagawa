//! Test for XorXorEq (^^=) token parsing.

use kanagawa_syntax::{parse_file, SyntaxKind};

fn has_kind(node: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    node.descendants().any(|n| n.kind() == kind)
}

#[test]
fn xorxoreq_compound_assignment() {
    // Test that ^^= is parsed as a compound assignment
    let code = r#"
        inline void test() {
            bool x = false;
            x ^^= true;
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    // Should have an AssignStmt (compound assignment)
    assert!(has_kind(&root, SyntaxKind::AssignStmt));
}

#[test]
fn xorxoreq_token_recognized() {
    // Test that ^^= is a single token, not ^^ and =
    let code = r#"
        inline void test() {
            bool a = false;
            a ^^= false;
            a ^^= true;
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    // Count XorXorEq tokens
    let xorxoreq_count = parse.syntax_node()
        .descendants_with_tokens()
        .filter_map(|it| it.into_token())
        .filter(|t| t.kind() == SyntaxKind::XorXorEq)
        .count();

    assert_eq!(xorxoreq_count, 2, "Expected 2 XorXorEq tokens");
}
