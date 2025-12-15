use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn has(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

#[test]
fn parses_unrolled_for_with_structured_header() {
    let src = r#"
        inline void main() {
            unrolled_for (const uint32 i : 4) {
                uint32 x = i + 1;
                return;
            }
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::UnrolledForStmt));

    let unrolled = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::UnrolledForStmt)
        .expect("expected UnrolledForStmt");

    assert!(
        unrolled.descendants().any(|n| n.kind() == SyntaxKind::ParenExpr),
        "expected header ParenExpr"
    );
    assert!(
        unrolled.descendants().any(|n| n.kind() == SyntaxKind::Type),
        "expected Type in header"
    );
    assert!(
        unrolled.descendants().any(|n| n.kind() == SyntaxKind::Expr),
        "expected Expr for limit"
    );
}
