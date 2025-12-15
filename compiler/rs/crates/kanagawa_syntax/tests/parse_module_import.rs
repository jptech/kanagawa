use kanagawa_syntax::{parse_file, SyntaxKind};

fn kinds_preorder(node: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>) -> Vec<SyntaxKind> {
    let mut out = Vec::new();
    for event in node.preorder_with_tokens() {
        match event {
            rowan::WalkEvent::Enter(it) => {
                if let Some(n) = it.as_node() {
                    out.push(n.kind());
                }
            }
            rowan::WalkEvent::Leave(_) => {}
        }
    }
    out
}

#[test]
fn parses_module_decl_with_exports() {
    let text = "module foo.bar { x, module .options, module a.b \\ c.d }";
    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let kinds = kinds_preorder(&root);
    assert!(kinds.contains(&SyntaxKind::ModuleDecl));
    assert!(kinds.contains(&SyntaxKind::ModuleName));
    assert!(kinds.contains(&SyntaxKind::ModuleExports));
    assert!(kinds.contains(&SyntaxKind::ExportItem));
}

#[test]
fn parses_import_decl_with_alias() {
    let text = "import foo.bar as baz";
    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let kinds = kinds_preorder(&root);
    assert!(kinds.contains(&SyntaxKind::ImportDecl));
    assert!(kinds.contains(&SyntaxKind::ModuleName));
}

#[test]
fn parses_import_with_keyword_segment() {
    let text = "import sync.atomic\n";
    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(root
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ImportDecl));
    assert!(root
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ModuleName));
    assert!(root
        .descendants()
        .any(|n| n.kind() == SyntaxKind::ModuleNameSegment));
}

#[test]
fn doc_comments_are_preserved_as_trivia_tokens() {
    let text = "//| doc pre\nmodule foo\n//< doc post\nimport a.b";
    let parse = parse_file(text);
    // We haven't attached doc comments to nodes yet; they should simply survive lex+parse.
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    let mut saw_pre = false;
    let mut saw_post = false;
    for t in root.descendants_with_tokens() {
        if let Some(tok) = t.as_token() {
            match tok.kind() {
                SyntaxKind::DocLineCommentPre => saw_pre = true,
                SyntaxKind::DocLineCommentPost => saw_post = true,
                _ => {}
            }
        }
    }
    assert!(saw_pre);
    assert!(saw_post);
}
