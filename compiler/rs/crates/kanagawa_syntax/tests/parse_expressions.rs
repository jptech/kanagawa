use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn has(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

fn node_has_token(node: &SyntaxNode, kind: SyntaxKind) -> bool {
    node.descendants_with_tokens()
        .any(|it| it.as_token().is_some_and(|tok| tok.kind() == kind))
}

#[test]
fn parses_binary_precedence_mul_over_add() {
    let src = r#"
        inline uint32 f() {
            return 1 + 2 * 3;
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::ReturnStmt));

    let plus_bin = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::BinaryExpr && node_has_token(n, SyntaxKind::Plus))
        .expect("expected BinaryExpr with '+'");

    let has_mul_inside = plus_bin
        .descendants()
        .any(|n| n.kind() == SyntaxKind::BinaryExpr && node_has_token(&n, SyntaxKind::Star));
    assert!(
        has_mul_inside,
        "expected '*' BinaryExpr nested under '+' BinaryExpr"
    );
}

#[test]
fn parses_assignment_right_associative_in_return() {
    let src = r#"
        inline uint32 f() {
            return x = y = z;
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let outer_assign = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::AssignExpr)
        .expect("expected AssignExpr");

    let nested_assign_count = outer_assign
        .descendants()
        .filter(|n| n.kind() == SyntaxKind::AssignExpr)
        .count();

    assert!(
        nested_assign_count >= 2,
        "expected nested AssignExpr for right-assoc assignment"
    );
}

#[test]
fn parses_value_template_arg_as_restricted_expr() {
    let src = r#"
        inline Bar<uint<32>, bitsizeof(uint<32>)> f() {
            return Bar<uint<32>, bitsizeof(uint<32>)>(0);
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::TypeTemplateArgs));

    let has_expr_template_arg = root.descendants().any(|n| {
        n.kind() == SyntaxKind::TypeTemplateArg
            && n.descendants().any(|c| c.kind() == SyntaxKind::Expr)
    });
    assert!(
        has_expr_template_arg,
        "expected at least one value template arg parsed as Expr"
    );
}
