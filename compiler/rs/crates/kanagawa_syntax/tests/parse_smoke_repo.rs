use std::{fs, path::PathBuf};

use kanagawa_syntax::{parse_file, SyntaxKind};

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
fn parses_library_optional_without_diagnostics() {
    let path = repo_root().join("library/data/optional.k");
    let text = fs::read_to_string(&path).unwrap();

    let parse = parse_file(&text);
    assert!(
        parse.diagnostics.is_empty(),
        "unexpected diagnostics for {}: {:?}",
        path.display(),
        parse.diagnostics
    );

    let root = parse.syntax_node();
    let mut saw_module = false;
    let mut saw_import = false;
    let mut saw_template = false;
    let mut saw_struct = false;
    let mut saw_fn_def = false;

    for n in root.descendants() {
        match n.kind() {
            SyntaxKind::ModuleDecl => saw_module = true,
            SyntaxKind::ImportDecl => saw_import = true,
            SyntaxKind::TemplateDecl => saw_template = true,
            SyntaxKind::StructDecl => saw_struct = true,
            SyntaxKind::FunctionDef => saw_fn_def = true,
            _ => {}
        }
    }

    assert!(saw_module, "expected to find a ModuleDecl node");
    assert!(saw_import, "expected to find at least one ImportDecl node");
    assert!(
        saw_template,
        "expected to find at least one TemplateDecl node"
    );
    assert!(saw_struct, "expected to find at least one StructDecl node");
    assert!(saw_fn_def, "expected to find at least one FunctionDef node");
}
