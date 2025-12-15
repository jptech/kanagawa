use std::{fs, path::PathBuf};

use kanagawa_syntax::{parse_file, SyntaxKind};

fn has(root: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

fn repo_root() -> PathBuf {
    // crates/kanagawa_syntax -> crates -> rs -> compiler -> repo
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.join("..")
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap()
}

#[test]
fn parses_expression_level_attribute_prefixes() {
    let text = r#"
uint1 Shared(uint1 x) { return x; }

uint1 f(uint1 x) {
  // attribute prefix inside return expression
  return [[transaction_size(8)]] Shared(x);
}

uint1 g(uint1 x) {
  // attribute prefix inside an argument expression
  return Shared([[transaction_size(4)]] Shared(x));
}

class C {
  // function-type member decl should be treated like a var decl
  (uint32)->uint32 cb;
};
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::Attrs));
    assert!(has(&root, SyntaxKind::AttrBlock));
    assert!(has(&root, SyntaxKind::ReturnStmt));
    assert!(has(&root, SyntaxKind::ClassDecl));
    assert!(has(&root, SyntaxKind::ClassVarDecl));
}

#[test]
fn parses_repo_file_with_expression_level_attrs_without_diagnostics() {
    let path = repo_root().join("test/logic/last.k");
    let text = fs::read_to_string(&path).unwrap();

    let parse = parse_file(&text);
    assert!(
        parse.diagnostics.is_empty(),
        "unexpected diagnostics for {}: {:?}",
        path.display(),
        parse.diagnostics
    );

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::Attrs));
}
