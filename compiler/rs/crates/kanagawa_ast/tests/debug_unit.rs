//! Debug test for parenthesized expression error in test/unit.k

use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};
use kanagawa_ast::lower_file;

fn print_tree(node: &SyntaxNode, src: &str, indent: usize, max_depth: usize) {
    if indent > max_depth {
        return;
    }
    let offset: usize = node.text_range().start().into();
    let line = src[..offset].matches('\n').count() + 1;
    let text: String = node.text().to_string().chars().take(60).collect();
    eprintln!(
        "{}L{} {:?} {:?}",
        "  ".repeat(indent),
        line,
        node.kind(),
        text.replace('\n', "\\n")
    );
    for child in node.children() {
        print_tree(&child, src, indent + 1, max_depth);
    }
}

#[test]
fn debug_unit_k() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/test/unit.k");

    let src = std::fs::read_to_string(&path).expect("read file");
    let parse = parse_file(&src);

    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    // Find ParenExpr nodes and check their children
    for node in parse.syntax_node().descendants() {
        if node.kind() == SyntaxKind::ParenExpr {
            let children: Vec<_> = node.children().collect();
            if children.is_empty() || !children.iter().any(|c| c.kind() == SyntaxKind::Expr) {
                let offset: usize = node.text_range().start().into();
                let line = src[..offset].matches('\n').count() + 1;
                let text: String = node.text().to_string().chars().take(60).collect();
                eprintln!("\nParenExpr without Expr child at line {}", line);
                eprintln!("Text: {}", text.replace('\n', "\\n"));
                eprintln!("Children: {:?}", children.iter().map(|c| c.kind()).collect::<Vec<_>>());
            }
        }
    }

    match lower_file(&parse.syntax_node()) {
        Ok(_) => eprintln!("\nAST lowering succeeded!"),
        Err(e) => eprintln!("\nAST lowering failed: {:?}", e),
    }
}
