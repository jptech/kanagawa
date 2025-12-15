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
fn parses_lambda_expression_shape_first() {
    let text = r#"
uint32 f(uint32 x) {
  const auto g = [x](uint32 y) -> uint32 { return x + y; };
  const auto h = [](uint32 y){ return y; };
  return g(1) + h(2);
}
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::LambdaExpr));
    assert!(has(&root, SyntaxKind::LambdaCaptureList));
    assert!(has(&root, SyntaxKind::LambdaCapture));
    assert!(has(&root, SyntaxKind::LambdaParams));
    assert!(has(&root, SyntaxKind::LambdaReturnType));
    assert!(has(&root, SyntaxKind::Block));
    assert!(has(&root, SyntaxKind::ReturnStmt));
}

#[test]
fn parses_repo_file_with_lambdas_without_diagnostics() {
    let path = repo_root().join("test/library/control/fsm.k");
    let text = fs::read_to_string(&path).unwrap();

    let parse = parse_file(&text);
    assert!(
        parse.diagnostics.is_empty(),
        "unexpected diagnostics for {}: {:?}",
        path.display(),
        parse.diagnostics
    );

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::LambdaExpr));
}
