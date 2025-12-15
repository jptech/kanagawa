//! Debug test parsing segments of vector.k

use kanagawa_syntax::{parse_file, SyntaxNode, SyntaxKind};

#[test]
fn debug_vector_segment() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/data/vector.k");

    let full_src = std::fs::read_to_string(&path).expect("read vector.k");

    // Try parsing just lines 1100-1200
    let lines: Vec<&str> = full_src.lines().collect();
    let segment = lines[1099..1200.min(lines.len())].join("\n");

    eprintln!("Parsing segment (lines 1100-1200):");
    eprintln!("{}", segment);

    let parse = parse_file(&segment);

    eprintln!("\nDiagnostics: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    for node in root.descendants() {
        if node.kind() == SyntaxKind::LocalVarDecl {
            let text: String = node.text().to_string().chars().take(60).collect();
            eprintln!("\nFound LocalVarDecl: {}", text.replace('\n', "\\n"));
        }
        if node.kind() == SyntaxKind::AssignStmt {
            let text: String = node.text().to_string().chars().take(60).collect();
            eprintln!("\nFound AssignStmt: {}", text.replace('\n', "\\n"));
        }
    }
}

#[test]
fn debug_vector_first_1200_lines() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/data/vector.k");

    let full_src = std::fs::read_to_string(&path).expect("read vector.k");

    // Parse first 1200 lines
    let lines: Vec<&str> = full_src.lines().collect();
    let segment = lines[0..1200.min(lines.len())].join("\n");

    let parse = parse_file(&segment);

    eprintln!("Diagnostics count: {}", parse.diagnostics.len());

    // Find AssignStmt at lines 1120-1130
    let root = parse.syntax_node();
    for node in root.descendants() {
        if node.kind() == SyntaxKind::LocalVarDecl || node.kind() == SyntaxKind::AssignStmt {
            let offset: usize = node.text_range().start().into();
            let line = segment[..offset].matches('\n').count() + 1;
            if line >= 1118 && line <= 1135 {
                let text: String = node.text().to_string().chars().take(60).collect();
                eprintln!("\n{:?} at line {}: {}", node.kind(), line, text.replace('\n', "\\n"));
            }
        }
    }
}
