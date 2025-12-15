//! Debug test to find the assignment lhs error in float32/internal.k

use kanagawa_syntax::{parse_file, lex, SyntaxNode, SyntaxKind};
use kanagawa_ast::lower_file;

fn find_assign_stmts(node: &SyntaxNode) -> Vec<(usize, String, bool)> {
    let mut results = Vec::new();
    if node.kind() == SyntaxKind::AssignStmt {
        let offset: usize = node.text_range().start().into();
        let text: String = node.text().to_string().chars().take(100).collect();
        // Check if it has an AssignExpr child (nested or direct)
        let has_assign_expr = node.descendants().any(|n| n.kind() == SyntaxKind::AssignExpr);
        results.push((offset, text, has_assign_expr));
    }
    for child in node.children() {
        results.extend(find_assign_stmts(&child));
    }
    results
}

#[test]
fn debug_float32_internal() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/numeric/float32/internal.k");

    let src = std::fs::read_to_string(&path).expect("read file");
    let parse = parse_file(&src);

    // Find all AssignStmt nodes without AssignExpr
    let assigns = find_assign_stmts(&parse.syntax_node());
    let missing: Vec<_> = assigns.iter().filter(|(_, _, has)| !has).collect();

    eprintln!("Found {} AssignStmt without AssignExpr:", missing.len());
    for (offset, text, _) in &missing {
        let line = src[..*offset].matches('\n').count() + 1;
        eprintln!("  Line {}: {}", line, text.replace('\n', "\\n"));

        // Count tokens in the problematic statement
        // Extract full statement text by finding the semicolon
        let stmt_start = *offset;
        let stmt_end = src[stmt_start..].find(';').map(|i| stmt_start + i + 1).unwrap_or(src.len());
        let stmt_text = &src[stmt_start..stmt_end];
        let (tokens, _) = lex(stmt_text);
        let non_trivia = tokens.iter().filter(|t| !t.kind.is_trivia()).count();
        eprintln!("  Token count: {} (limit is 512)", non_trivia);
    }

    match lower_file(&parse.syntax_node()) {
        Ok(_) => eprintln!("AST lowering succeeded!"),
        Err(e) => eprintln!("AST lowering failed: {:?}", e),
    }
}
