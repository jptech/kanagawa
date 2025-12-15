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
fn parses_class_with_members_shape_first() {
    let text = r#"
class C {
public:
  default = 1;
  uint32 x;
  inline uint32 next(uint32 input) {
    uint32 y = input;
    atomic { static uint32 z = 0; }
    static for (const uint32 i : 4) { y += i; }
    return y;
  }
}
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::ClassDecl));
    assert!(has(&root, SyntaxKind::ClassBody));
    assert!(has(&root, SyntaxKind::AccessSpecifier));
    assert!(has(&root, SyntaxKind::DefaultInitDecl));
    assert!(has(&root, SyntaxKind::ClassVarDecl));
    assert!(has(&root, SyntaxKind::FunctionDef));
    assert!(has(&root, SyntaxKind::AtomicStmt));
    assert!(has(&root, SyntaxKind::StaticVarDecl));
    assert!(has(&root, SyntaxKind::StaticForStmt));
    assert!(has(&root, SyntaxKind::AssignStmt));
    assert!(has(&root, SyntaxKind::ReturnStmt));
}

#[test]
fn parses_library_pipelined_without_diagnostics() {
    let path = repo_root().join("library/data/buffer/pipelined.k");
    let text = fs::read_to_string(&path).unwrap();

    let parse = parse_file(&text);
    assert!(
        parse.diagnostics.is_empty(),
        "unexpected diagnostics for {}: {:?}",
        path.display(),
        parse.diagnostics
    );

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::ModuleDecl));
    assert!(has(&root, SyntaxKind::TemplateDecl));
    assert!(has(&root, SyntaxKind::ClassDecl));
    assert!(has(&root, SyntaxKind::FunctionDef));
    assert!(has(&root, SyntaxKind::StaticForStmt));
    assert!(has(&root, SyntaxKind::StaticVarDecl));
}
