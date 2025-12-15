//! Debug test to find the exact failing line in vector.k

use kanagawa_syntax::{parse_file, SyntaxNode, SyntaxKind};
use kanagawa_ast::lower_file;

fn find_nodes_of_kind(node: &SyntaxNode, kind: SyntaxKind) -> Vec<(usize, String)> {
    let mut results = Vec::new();
    if node.kind() == kind {
        let offset = node.text_range().start().into();
        let text: String = node.text().to_string().chars().take(80).collect();
        results.push((offset, text));
    }
    for child in node.children() {
        results.extend(find_nodes_of_kind(&child, kind));
    }
    results
}

fn find_assign_stmts(node: &SyntaxNode) -> Vec<(usize, String, bool)> {
    let mut results = Vec::new();
    if node.kind() == SyntaxKind::AssignStmt {
        let offset = node.text_range().start().into();
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
fn debug_vector_k() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/data/vector.k");

    let src = std::fs::read_to_string(&path).expect("read vector.k");
    let parse = parse_file(&src);

    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    // Find all AssignStmt nodes
    let assigns = find_assign_stmts(&parse.syntax_node());
    eprintln!("Found {} AssignStmt nodes", assigns.len());
    for (offset, text, has_expr) in &assigns {
        // Find line number from offset
        let line = src[..*offset].matches('\n').count() + 1;
        let marker = if *has_expr { "OK" } else { "MISSING" };
        eprintln!("  [{}] Line {}: {}", marker, line, text.replace('\n', "\\n"));
    }

    // Print the ones without AssignExpr more verbosely
    let missing: Vec<_> = assigns.iter().filter(|(_, _, has)| !has).collect();
    if !missing.is_empty() {
        eprintln!("\n=== AssignStmt nodes without AssignExpr ===");
        for (offset, _, _) in missing {
            let line = src[..*offset].matches('\n').count() + 1;
            eprintln!("Line {} full context:", line);
            // Print a few lines of context
            let start = src[..*offset].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let end = src[*offset..].find('\n').map(|i| offset + i).unwrap_or(src.len());
            let context: String = src[start..end.min(start + 200)].to_string();
            eprintln!("{}", context);
        }
    }

    // Check for LocalVarDecl at line 1125
    let local_var_decls = find_nodes_of_kind(&parse.syntax_node(), SyntaxKind::LocalVarDecl);
    for (offset, text) in &local_var_decls {
        let line = src[..*offset].matches('\n').count() + 1;
        if line >= 1120 && line <= 1130 {
            eprintln!("\nLocalVarDecl at line {}: {}", line, text.replace('\n', "\\n"));
        }
    }

    match lower_file(&parse.syntax_node()) {
        Ok(_) => {
            eprintln!("AST lowering succeeded!");
        }
        Err(e) => {
            eprintln!("AST lowering failed: {:?}", e);
        }
    }
}
