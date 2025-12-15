//! Binary search to find what context triggers the bug

use kanagawa_syntax::{parse_file, SyntaxKind};

fn test_segment(start_line: usize, end_line: usize) -> bool {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/data/vector.k");

    let full_src = std::fs::read_to_string(&path).expect("read vector.k");
    let lines: Vec<&str> = full_src.lines().collect();
    let segment = lines[start_line..end_line.min(lines.len())].join("\n");

    let parse = parse_file(&segment);

    // Find what kind of node we get for per_shard_results
    let root = parse.syntax_node();
    for node in root.descendants() {
        let text = node.text().to_string();
        if text.contains("per_shard_results") && (node.kind() == SyntaxKind::LocalVarDecl || node.kind() == SyntaxKind::AssignStmt) {
            return node.kind() == SyntaxKind::LocalVarDecl;
        }
    }
    true // If not found, return true (not a problem)
}

#[test]
fn debug_exact_1110_segment() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/data/vector.k");

    let full_src = std::fs::read_to_string(&path).expect("read vector.k");
    let lines: Vec<&str> = full_src.lines().collect();

    // Print lines 1110-1115 (0-indexed: 1109-1114) with length info
    eprintln!("=== Lines 1110-1115 from vector.k ===");
    for i in 1109..1115 {
        let line = lines.get(i).unwrap_or(&"<EOF>");
        eprintln!("{} (len {}): {:?}", i + 1, line.len(), line);
    }

    // Parse lines 1110-1199 (0-indexed: 1109-1198)
    let segment = lines[1109..1199].join("\n");

    // Print first 500 chars as hex for debugging
    eprintln!("\n=== First 300 bytes as hex ===");
    for (i, b) in segment.bytes().take(300).enumerate() {
        if i % 50 == 0 && i > 0 {
            eprintln!();
        }
        if b == b'\n' {
            eprint!("\\n");
        } else if b >= 0x20 && b < 0x7F {
            eprint!("{}", b as char);
        } else {
            eprint!("[{:02x}]", b);
        }
    }
    eprintln!();

    let parse = parse_file(&segment);
    eprintln!("\nDiagnostics: {:?}", parse.diagnostics);

    // Print the whole CST tree structure (limited depth)
    fn print_cst(node: &kanagawa_syntax::SyntaxNode, depth: usize, max_depth: usize) {
        if depth > max_depth {
            return;
        }
        let text: String = node.text().to_string().chars().take(50).collect();
        eprintln!("{}{:?}: {:?}", "  ".repeat(depth), node.kind(), text.replace('\n', "\\n"));
        for child in node.children() {
            print_cst(&child, depth + 1, max_depth);
        }
    }

    eprintln!("\n=== CST Tree ===");
    print_cst(&parse.syntax_node(), 0, 6);

    let root = parse.syntax_node();
    for node in root.descendants() {
        let text = node.text().to_string();
        if text.contains("per_shard_results") && (node.kind() == SyntaxKind::LocalVarDecl || node.kind() == SyntaxKind::AssignStmt) {
            let short: String = text.chars().take(60).collect();
            eprintln!("\nFound {:?}: {}", node.kind(), short.replace('\n', "\\n"));
        }
    }
}

#[test]
fn binary_search_bug() {
    // Line 1125 has per_shard_results
    // We know 1099-1199 works (LocalVarDecl)
    // We know 0-1199 fails (AssignStmt)
    // Let's find the cutoff

    let target = 1125;

    // Test different starting points
    let tests = [
        (0, 1200, "0-1199 (full)"),
        (1104, 1200, "1104-1199 (starts at 'template')"),
        (1105, 1200, "1105-1199 (starts after template)"),
        (1110, 1200, "1110-1199 (middle of template, unbalanced >)"),
        (1111, 1200, "1111-1199 (starts at >)"),
        (1112, 1200, "1112-1199 (starts at inline)"),
        (1115, 1200, "1115-1199 (starts at , vector)"),
        (1116, 1200, "1116-1199 (starts at ))"),
        (1117, 1200, "1117-1199 (starts at {)"),
    ];

    eprintln!("Testing different segments to find when bug appears:");
    for (start, end, name) in tests {
        let ok = test_segment(start, end);
        eprintln!("  Lines {}: {}", name, if ok { "OK (LocalVarDecl)" } else { "BUG (AssignStmt)" });
    }
}
