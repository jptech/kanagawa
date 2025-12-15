use kanagawa_syntax::{parse_file, SyntaxKind};

fn has(root: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

#[test]
fn parses_static_assert_both_spellings() {
    let text = r#"
static_assert(1);
static assert(2);

uint32 f() {
  static_assert(3);
  static assert(4);
  return 0;
}

class C {
public:
  static assert(5);
  static_assert(6);
}
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::StaticAssertDecl));
    // Sanity: make sure we didn't get stuck.
    assert!(has(&root, SyntaxKind::FunctionDef));
    assert!(has(&root, SyntaxKind::ClassDecl));
}
