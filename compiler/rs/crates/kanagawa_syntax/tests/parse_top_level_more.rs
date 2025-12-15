use kanagawa_syntax::{parse_file, SyntaxKind};

fn has(node: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> bool {
    node.descendants().any(|n| n.kind() == kind)
}

fn count(node: &rowan::SyntaxNode<kanagawa_syntax::SyntaxLanguage>, kind: SyntaxKind) -> usize {
    node.descendants().filter(|n| n.kind() == kind).count()
}

#[test]
fn parses_attribute_sequences_and_wrappers() {
    let text = r#"
//| docs
[[async, latency(3)]][[pipelined]] extern struct S { int x; };
extern device_schema::schema_version;
//< post
export using Foo = uint32;
static_assert(1);
union U { uint8 a; uint8 b; };
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::Attrs));
    assert!(has(&root, SyntaxKind::AttrBlock));
    assert!(has(&root, SyntaxKind::AttrItem));

    assert!(has(&root, SyntaxKind::ExternDecl));
    assert!(has(&root, SyntaxKind::StructDecl));

    assert!(has(&root, SyntaxKind::ExportDecl));
    assert!(has(&root, SyntaxKind::UsingDecl));

    assert!(has(&root, SyntaxKind::StaticAssertDecl));
    assert!(has(&root, SyntaxKind::UnionDecl));
}

#[test]
fn attribute_items_can_have_comma_arguments() {
    let text = r#"
[[schedule(x, y), latency(3)]]
inline void f() { return; }
"#;

    let parse = parse_file(text);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::Attrs));
    assert_eq!(count(&root, SyntaxKind::AttrItem), 2);
}
