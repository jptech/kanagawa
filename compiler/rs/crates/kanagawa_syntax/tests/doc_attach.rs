use kanagawa_syntax::{attached_doc_comments, parse_file, SyntaxKind};

#[test]
fn attaches_pre_and_post_doc_comments() {
    let text = "//| pre a\n//| pre b\nmodule foo\n//< post x\nimport a.b\n";
    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let module = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::ModuleDecl)
        .expect("expected ModuleDecl");

    let docs = attached_doc_comments(&module);
    assert_eq!(docs.pre, vec!["pre a".to_string(), "pre b".to_string()]);
    assert_eq!(docs.post, vec!["post x".to_string()]);
}

#[test]
fn blank_line_breaks_pre_attachment() {
    let text = "//| pre\n\nmodule foo\n";
    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let module = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::ModuleDecl)
        .expect("expected ModuleDecl");

    let docs = attached_doc_comments(&module);
    assert!(docs.pre.is_empty());
}

#[test]
fn pre_docs_attach_across_attributes() {
    let text = "//| pre\n[[async]] module foo\n";
    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let module = root
        .descendants()
        .find(|n| n.kind() == SyntaxKind::ModuleDecl)
        .expect("expected ModuleDecl");

    let docs = attached_doc_comments(&module);
    assert_eq!(docs.pre, vec!["pre".to_string()]);
}
