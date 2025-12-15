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
fn parses_enum_struct_union_bodies_shape_first() {
    let text = r#"
enum E: uint2 { A = 0, B, C = (1 + 1), }

struct S {
  uint32 x;
  uint8 y;
}

union U {
  uint32 a;
  uint8 b;
}
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::EnumDecl));
    assert!(has(&root, SyntaxKind::EnumBody));
    assert!(has(&root, SyntaxKind::EnumVariant));

    assert!(has(&root, SyntaxKind::StructDecl));
    assert!(has(&root, SyntaxKind::StructBody));
    assert!(has(&root, SyntaxKind::StructMemberDecl));

    assert!(has(&root, SyntaxKind::UnionDecl));
    assert!(has(&root, SyntaxKind::UnionBody));
    assert!(has(&root, SyntaxKind::UnionMemberDecl));
}

#[test]
fn parses_device_schema_without_diagnostics() {
    let path = repo_root().join("library/compiler/device/schema.k");
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
    assert!(has(&root, SyntaxKind::EnumDecl));
    assert!(has(&root, SyntaxKind::EnumBody));
    assert!(has(&root, SyntaxKind::StructDecl));
    assert!(has(&root, SyntaxKind::StructBody));
}
