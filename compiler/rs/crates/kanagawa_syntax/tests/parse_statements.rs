use kanagawa_syntax::{parse_file, SyntaxKind};

fn has(root: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

fn find_first(
    root: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>,
    kind: SyntaxKind,
) -> rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage> {
    root.descendants()
        .find(|n| n.kind() == kind)
        .unwrap_or_else(|| panic!("expected {kind:?}"))
}

#[test]
fn parses_common_statements_shape_first() {
    let text = r#"
uint32 f(uint32 x) {
  [[schedule(1)]] return x;
  if ((x + 1) < 10) { barrier; } else reorder { atomic { break; } }
  switch (x) {
    case 0: break;
    default: return 0;
  }
  do { x = x + 1; } while (x < 10);
  for (const uint32 i : 10 + 2) { x = x + i; }
  static if (x) return 1; else return 2;
}
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::FunctionDef));
    assert!(has(&root, SyntaxKind::Block));
    assert!(has(&root, SyntaxKind::StmtList));

    assert!(has(&root, SyntaxKind::AnnotatedStmt));
    assert!(has(&root, SyntaxKind::ReturnStmt));
    assert!(has(&root, SyntaxKind::IfStmt));
    assert!(has(&root, SyntaxKind::BarrierStmt));
    assert!(has(&root, SyntaxKind::ReorderStmt));
    assert!(has(&root, SyntaxKind::AtomicStmt));
    assert!(has(&root, SyntaxKind::BreakStmt));

    assert!(has(&root, SyntaxKind::SwitchStmt));
    assert!(has(&root, SyntaxKind::CaseLabel));
    assert!(has(&root, SyntaxKind::DefaultLabel));

    assert!(has(&root, SyntaxKind::DoWhileStmt));
    assert!(has(&root, SyntaxKind::RangeForStmt));
    assert!(has(&root, SyntaxKind::StaticIfStmt));
    assert!(has(&root, SyntaxKind::AssignStmt));

    // Verify statement headers now build structured condition/range subtrees.
    let if_stmt = find_first(&root, SyntaxKind::IfStmt);
    assert!(if_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ParenExpr));
    assert!(if_stmt.descendants().any(|n| n.kind() == SyntaxKind::Expr));
    assert!(if_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::BinaryExpr));

    let switch_stmt = find_first(&root, SyntaxKind::SwitchStmt);
    assert!(switch_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ParenExpr));
    assert!(switch_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::CaseLabel
            && n.descendants().any(|c| c.kind() == SyntaxKind::Expr)));

    let range_for = find_first(&root, SyntaxKind::RangeForStmt);
    assert!(range_for
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ParenExpr
            && n.descendants().any(|c| c.kind() == SyntaxKind::Type)));
    assert!(range_for
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ParenExpr
            && n.descendants().any(|c| c.kind() == SyntaxKind::Expr)));
}

#[test]
fn parses_statement_or_decl_items_in_blocks() {
    let text = r#"
  uint32 f(uint32 x) {
    uint32 y = 0;
    static uint32 z = 1;
    static default = 42;
    x += 1;
    ++x;
    y--;
    static if (x) { uint32 a = 3; } else { static uint32 b = 4; }
    static for (const uint32 i : 10) { y = y + i; }
    static_assert(x);
  }
  "#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::FunctionDef));
    assert!(has(&root, SyntaxKind::Block));
    assert!(has(&root, SyntaxKind::StmtList));

    assert!(has(&root, SyntaxKind::LocalVarDecl));
    assert!(has(&root, SyntaxKind::StaticVarDecl));
    assert!(has(&root, SyntaxKind::StaticDefaultInitStmt));

    assert!(has(&root, SyntaxKind::AssignStmt));
    assert!(has(&root, SyntaxKind::IncDecStmt));

    assert!(has(&root, SyntaxKind::StaticIfStmt));
    assert!(has(&root, SyntaxKind::StaticForStmt));
    assert!(has(&root, SyntaxKind::StaticAssertDecl));

    let assign_stmt = find_first(&root, SyntaxKind::AssignStmt);
    assert!(assign_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Expr));
    assert!(assign_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::AssignExpr));

    let incdec_stmt = find_first(&root, SyntaxKind::IncDecStmt);
    assert!(incdec_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Expr));
    assert!(incdec_stmt
        .descendants()
        .any(|n| n.kind() == SyntaxKind::UnaryExpr));
}
