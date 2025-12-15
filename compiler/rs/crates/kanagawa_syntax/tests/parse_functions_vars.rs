use kanagawa_syntax::{parse_file, SyntaxKind};

fn has(root: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

#[test]
fn parses_function_decl_def_and_global_var() {
    let text = r#"
[[async]] inline uint32 add(uint32 a, uint32 b);
uint32 foo(uint32 x) { return x; }
int x = 3;
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::FunctionDecl));
    assert!(has(&root, SyntaxKind::FunctionDef));
    assert!(has(&root, SyntaxKind::GlobalVarDecl));
    assert!(has(&root, SyntaxKind::FuncParams));
    assert!(has(&root, SyntaxKind::Block));
}

#[test]
fn parses_static_if_decl_arms() {
    let text = r#"
static if (1) uint32 a(uint32 x);
static if (0) uint32 b(); else uint32 c() { return 0; }
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::StaticIfDecl));
    assert!(has(&root, SyntaxKind::FunctionDecl));
    assert!(has(&root, SyntaxKind::FunctionDef));
}
