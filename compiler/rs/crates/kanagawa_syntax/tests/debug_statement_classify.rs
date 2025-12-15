//! Debug statement classification in the failing context

use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn print_token_children(node: &SyntaxNode) {
    use rowan::NodeOrToken;
    for item in node.children_with_tokens() {
        match item {
            NodeOrToken::Token(t) if !t.kind().is_trivia() => {
                eprintln!("  TOKEN {:?} {:?}", t.kind(), t.text());
            }
            NodeOrToken::Node(n) => {
                let text: String = n.text().to_string().chars().take(40).collect();
                eprintln!("  NODE {:?} {:?}", n.kind(), text.replace('\n', "\\n"));
            }
            _ => {}
        }
    }
}

#[test]
fn test_exact_file_segment() {
    // Read exact bytes from the file
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("library/data/vector.k");

    let full_src = std::fs::read_to_string(&path).expect("read vector.k");
    let lines: Vec<&str> = full_src.lines().collect();

    // Print line 1125 (0-indexed: 1124) in hex
    eprintln!("=== Line 1125 bytes ===");
    let line1125 = lines[1124];
    for (i, b) in line1125.bytes().enumerate() {
        if i % 60 == 0 && i > 0 {
            eprintln!();
        }
        if b >= 0x20 && b < 0x7F {
            eprint!("{}", b as char);
        } else {
            eprint!("[{:02x}]", b);
        }
    }
    eprintln!();

    // Test just the problem statement in isolation
    let stmt = "optional<R>[Shards][N] per_shard_results = parallel_map<Shards, optional<R>[N], MaxCallerThreads>(x);";
    eprintln!("\n=== Synthetic statement ===");
    let synthetic = format!("function test() {{ {} }}", stmt);
    let parse = parse_file(&synthetic);
    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    for node in parse.syntax_node().descendants() {
        if node.text().to_string().contains("per_shard_results")
            && matches!(node.kind(), SyntaxKind::LocalVarDecl | SyntaxKind::AssignStmt)
        {
            eprintln!("Found {:?}", node.kind());
            break;
        }
    }

    // Test with multi-line lambda like in the actual file
    eprintln!("\n=== Multi-line with lambda ===");
    let multi = r#"function test() {
    optional<R>[Shards][N] per_shard_results = parallel_map<Shards, optional<R>[N], MaxCallerThreads>(
        Shards,
        [f, shard_ids, x](index_t<Shards> shard_idx)
        {
            return x;
        }
    );
}"#;
    let parse = parse_file(multi);
    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    for node in parse.syntax_node().descendants() {
        if node.text().to_string().contains("per_shard_results")
            && matches!(node.kind(), SyntaxKind::LocalVarDecl | SyntaxKind::AssignStmt)
        {
            eprintln!("Found {:?}", node.kind());
            break;
        }
    }

    // Test with extra content in lambda like actual file
    eprintln!("\n=== Multi-line with more lambda content ===");
    let multi2 = r#"function test() {
    optional<R>[Shards][N] per_shard_results = parallel_map<Shards, optional<R>[N], MaxCallerThreads>(
        Shards,
        [f, shard_ids, x](index_t<Shards> shard_idx)
        {
            // Determine which inputs are assigned to this shard
            vector<index_t<N>, N> gathered_indices = gather_shard_indices(shard_ids, shard_idx, x);
            return gathered_indices;
        }
    );
}"#;
    let parse = parse_file(multi2);
    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    for node in parse.syntax_node().descendants() {
        if node.text().to_string().contains("per_shard_results")
            && matches!(node.kind(), SyntaxKind::LocalVarDecl | SyntaxKind::AssignStmt)
        {
            eprintln!("Found {:?}", node.kind());
            break;
        }
    }

    // Test with actual lines from the file
    eprintln!("\n=== Actual file lines 1125-1171 ===");
    let actual_lines = lines[1124..1171].join("\n");
    let actual_func = format!("function test() {{\n{}\n}}", actual_lines);

    // Count tokens in the statement
    let (tokens, _) = kanagawa_syntax::lex(&actual_lines);
    let non_trivia_count = tokens.iter().filter(|t| !t.kind.is_trivia()).count();
    eprintln!("Non-trivia tokens in statement: {} (limit is 128)", non_trivia_count);

    let parse = parse_file(&actual_func);
    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    for node in parse.syntax_node().descendants() {
        if node.text().to_string().contains("per_shard_results")
            && matches!(node.kind(), SyntaxKind::LocalVarDecl | SyntaxKind::AssignStmt)
        {
            eprintln!("Found {:?}", node.kind());
            break;
        }
    }
}
