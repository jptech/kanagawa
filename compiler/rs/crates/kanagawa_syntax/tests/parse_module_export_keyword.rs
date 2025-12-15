//! Test module export edge cases.

use kanagawa_syntax::{parse_file, SyntaxKind};

fn has_kind(node: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    node.descendants().any(|n| n.kind() == kind)
}

#[test]
fn module_keyword_as_export_item() {
    // `module` can appear as an exported identifier, not just as a module re-export prefix
    let code = "module a1.a21 {module}";
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has_kind(&root, SyntaxKind::ModuleDecl));
    assert!(has_kind(&root, SyntaxKind::ModuleExports));
    assert!(has_kind(&root, SyntaxKind::ExportItem));
}

#[test]
fn module_reexport_still_works() {
    // `module foo` in export list should still work as module re-export
    let code = "module test {module foo}";
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has_kind(&root, SyntaxKind::ModuleDecl));
    assert!(has_kind(&root, SyntaxKind::ModuleExports));
    assert!(has_kind(&root, SyntaxKind::ModuleReference));
}

#[test]
fn module_reexport_with_diff() {
    // `module foo \ bar` should still work
    let code = r"module test {module foo \ bar}";
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has_kind(&root, SyntaxKind::ModuleReference));
    assert!(has_kind(&root, SyntaxKind::ModuleDiff));
}

#[test]
fn keyword_as_export_item() {
    // Other keywords should also be allowed as export items
    let code = "module test {void, bool, auto}";
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no errors, got: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let export_items: Vec<_> = root.descendants()
        .filter(|n| n.kind() == SyntaxKind::ExportItem)
        .collect();
    assert_eq!(export_items.len(), 3);
}
