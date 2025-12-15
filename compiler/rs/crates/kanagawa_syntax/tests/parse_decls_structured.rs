use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn has(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

fn find_first(root: &SyntaxNode, kind: SyntaxKind) -> SyntaxNode {
    root.descendants()
        .find(|n| n.kind() == kind)
        .unwrap_or_else(|| panic!("expected {kind:?}"))
}

#[test]
fn parses_var_decls_with_structured_type_and_initializer_expr() {
    let text = r#"
uint32 x = 1 + 2 * 3;

uint32 a = 1, b = 2;

inline uint32 f(uint32 y) {
  uint32 z = y + 1;
  static uint32 s = {0, 1, 2};
  return z;
}
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();

    // Global var decl: must contain Type + Expr.
    let global = find_first(&root, SyntaxKind::GlobalVarDecl);
    assert!(global.descendants().any(|n| n.kind() == SyntaxKind::Type));
    assert!(global.descendants().any(|n| n.kind() == SyntaxKind::Expr));
    assert!(global
        .descendants()
        .any(|n| n.kind() == SyntaxKind::BinaryExpr));

    // Local + static var decls.
    let local = find_first(&root, SyntaxKind::LocalVarDecl);
    assert!(local.descendants().any(|n| n.kind() == SyntaxKind::Type));
    assert!(local.descendants().any(|n| n.kind() == SyntaxKind::Expr));

    let static_var = find_first(&root, SyntaxKind::StaticVarDecl);
    assert!(static_var
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Type));
    assert!(static_var
        .descendants()
        .any(|n| n.kind() == SyntaxKind::InitializerListExpr));

    // Comma-separated globals should still parse (at least one extra Expr).
    assert!(has(&root, SyntaxKind::GlobalVarDecl));
    let global_var_count = root
        .descendants()
        .filter(|n| n.kind() == SyntaxKind::GlobalVarDecl)
        .count();
    assert!(global_var_count >= 2);
}

#[test]
fn parses_member_decls_with_structured_type_and_initializer_expr() {
    let text = r#"
struct S {
  uint32 x = 1 + 2;
};

union U {
  uint32 a;
  uint8 b;
};

class C {
public:
  default = 1 + 2 * 3;
  uint32 y = cast<uint32>(0);
  (uint32)->uint32 cb = cast<uint32>(0);
};
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();

    let struct_member = find_first(&root, SyntaxKind::StructMemberDecl);
    assert!(struct_member
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Type));
    assert!(struct_member
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Expr));
    assert!(struct_member
        .descendants()
        .any(|n| n.kind() == SyntaxKind::BinaryExpr));

    let union_member = find_first(&root, SyntaxKind::UnionMemberDecl);
    assert!(union_member
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Type));

    let class_var = find_first(&root, SyntaxKind::ClassVarDecl);
    assert!(class_var
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Type));
    assert!(class_var
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Expr));
    assert!(class_var
        .descendants()
        .any(|n| n.kind() == SyntaxKind::CastExpr));

    let default_init = find_first(&root, SyntaxKind::DefaultInitDecl);
    assert!(default_init
        .descendants()
        .any(|n| n.kind() == SyntaxKind::Expr));
    assert!(default_init
        .descendants()
        .any(|n| n.kind() == SyntaxKind::BinaryExpr));
}

#[test]
fn parses_static_assert_with_structured_condition_expr() {
    let text = r#"
static_assert(1 + 2 * 3);
static assert(4 + 5);
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let asserts: Vec<_> = root
        .descendants()
        .filter(|n| n.kind() == SyntaxKind::StaticAssertDecl)
        .collect();

    assert!(asserts.len() >= 2);
    for a in asserts {
        assert!(a.descendants().any(|n| n.kind() == SyntaxKind::ParenExpr));
        assert!(a.descendants().any(|n| n.kind() == SyntaxKind::Expr));
        assert!(a.descendants().any(|n| n.kind() == SyntaxKind::BinaryExpr));
    }
}
