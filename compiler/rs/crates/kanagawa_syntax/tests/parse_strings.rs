use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn contains_kind(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

fn count_kind(root: &SyntaxNode, kind: SyntaxKind) -> usize {
    root.descendants().filter(|n| n.kind() == kind).count()
}

#[test]
fn parses_interpolated_string_as_subtree() {
    let src = r#"
        inline void main() {
            const auto s = "foo{intConst + 3:x8}bar";
        }
    "#;

    let parse = parse_file(src);
    assert!(
        parse.diagnostics.is_empty(),
        "diagnostics: {:?}",
        parse.diagnostics
    );

    let root = parse.syntax_node();
    assert!(contains_kind(&root, SyntaxKind::InterpolatedStringExpr));
    assert!(contains_kind(&root, SyntaxKind::StringInterpolation));
    assert_eq!(count_kind(&root, SyntaxKind::StringInterpolation), 1);
}

#[test]
fn parses_plain_string_as_literal_expr() {
    let src = r#"
        inline void main() {
            const auto s = "hello\\nworld";
        }
    "#;

    let parse = parse_file(src);
    assert!(
        parse.diagnostics.is_empty(),
        "diagnostics: {:?}",
        parse.diagnostics
    );

    let root = parse.syntax_node();
    assert!(contains_kind(&root, SyntaxKind::StringLiteralExpr));
    assert!(!contains_kind(&root, SyntaxKind::StringInterpolation));
}
