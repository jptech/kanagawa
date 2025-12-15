//! Debug test for complex type declarations vs assignments.

use kanagawa_syntax::{parse_file, SyntaxNode, SyntaxKind};

fn print_tree(node: &SyntaxNode, indent: usize, max_depth: usize) {
    if indent > max_depth {
        return;
    }
    let text: String = node.text().to_string().chars().take(80).collect();
    eprintln!(
        "{}{:?} {:?}",
        " ".repeat(indent * 2),
        node.kind(),
        text.replace('\n', "\\n")
    );
    for child in node.children() {
        print_tree(&child, indent + 1, max_depth);
    }
}

#[test]
fn debug_template_array_decl() {
    let src = r#"
function test() {
    optional<R>[Shards][N] per_shard_results = parallel_map<Shards, R[N], T>(Shards, [](auto x) { return x; });
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    eprintln!("\n=== CST ===");
    print_tree(&parse.syntax_node(), 0, 10);

    // Find what kind of statement this is
    let root = parse.syntax_node();
    for node in root.descendants() {
        if node.kind() == SyntaxKind::LocalVarDecl {
            eprintln!("\nFound LocalVarDecl: {}", node.text().to_string().chars().take(100).collect::<String>());
        }
        if node.kind() == SyntaxKind::AssignStmt {
            eprintln!("\nFound AssignStmt: {}", node.text().to_string().chars().take(100).collect::<String>());
        }
    }
}

#[test]
fn debug_simple_template_array_decl() {
    // Simpler version
    let src = r#"
function test() {
    T<R>[N][M] x = f();
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    eprintln!("\n=== CST ===");
    print_tree(&parse.syntax_node(), 0, 10);
}

#[test]
fn debug_array_after_template() {
    // Even simpler
    let src = r#"
function test() {
    optional<R>[N] x = f();
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    for node in root.descendants() {
        if node.kind() == SyntaxKind::LocalVarDecl {
            eprintln!("\nFound LocalVarDecl");
        }
        if node.kind() == SyntaxKind::AssignStmt {
            eprintln!("\nFound AssignStmt");
        }
    }
}

#[test]
fn debug_exact_vector_pattern() {
    // Exact pattern from vector.k line 1125
    let src = r#"
function test() {
    optional<R>[Shards][N] per_shard_results = parallel_map<Shards, optional<R>[N], MaxCallerThreads>(
        Shards,
        [f, shard_ids, x](index_t<Shards> shard_idx)
        {
            optional<R>[N] results = {};
            return results;
        }
    );
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

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
fn debug_with_using_context() {
    // Include the using declaration before like in vector.k
    let src = r#"
function test() {
    using R = decltype(f(0, {}));
    vector<index_t<Shards>, N> shard_ids = map(get_shard_idx, x);
    optional<R>[Shards][N] per_shard_results = parallel_map<Shards, optional<R>[N], MaxCallerThreads>(
        Shards,
        [f, shard_ids, x](index_t<Shards> shard_idx)
        {
            optional<R>[N] results = {};
            return results;
        }
    );
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

    let root = parse.syntax_node();
    for node in root.descendants() {
        if node.kind() == SyntaxKind::LocalVarDecl {
            let text: String = node.text().to_string().chars().take(60).collect();
            eprintln!("\nFound LocalVarDecl: {}", text.replace('\n', "\\n"));
        }
        if node.kind() == SyntaxKind::AssignStmt {
            let text: String = node.text().to_string().chars().take(60).collect();
            eprintln!("\nFound AssignStmt: {}", text.replace('\n', "\\n"));
            // Print children for debugging
            eprintln!("  Children: {:?}", node.children().map(|c| c.kind()).collect::<Vec<_>>());
        }
    }
}

#[test]
fn debug_exact_vector_function() {
    // Exact copy of sharded_map function from vector.k
    let src = r#"
template
    < auto Shards
    , auto N
    , typename T
    , auto MaxCallerThreads = opt::max_threads_limit
    >
inline auto sharded_map
    ( (index_t<Shards>, T)->auto f
    , (T)->index_t<Shards> get_shard_idx
    , vector<T, N> x
    )
{
    // Type alias for the return type
    using R = decltype(f(0, {}));

    // Determine which input each shard is assigned to
    vector<index_t<Shards>, N> shard_ids = map(get_shard_idx, x);

    // Broadcast inputs to all replicas
    optional<R>[Shards][N] per_shard_results = parallel_map<Shards, optional<R>[N], MaxCallerThreads>(
        Shards,
        [f, shard_ids, x](index_t<Shards> shard_idx)
        {
            optional<R>[N] results = {};
            return results;
        });
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

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
fn debug_minimal_function_type_params() {
    // Minimal case with function-type parameters
    let src = r#"
inline auto foo
    ( (T)->auto f
    , (T)->index_t<S> g
    , vector<T, N> x
    )
{
    optional<R>[S][N] per_shard_results = call();
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

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
fn debug_with_doc_comments() {
    // Try with doc comments like the real file
    let src = r#"
template
    < auto Shards                                       //< Number of replicas
    , auto N                                            //< Maximum elements
    , typename T                                        //< Element type
    , auto MaxCallerThreads = opt::max_threads_limit    //< Max threads
                                                        // Caller must ensure
    >
inline auto sharded_map
    ( (index_t<Shards>, T)->auto f                      //< Transform function
    , (T)->index_t<Shards> get_shard_idx                //< Shard function
    , vector<T, N> x                                    //< Input data
    )
{
    optional<R>[Shards][N] per_shard_results = call();
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

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
fn debug_stray_gt_at_start() {
    // Just the > and then the function - simulates broken parse context
    let src = r#"
    >
inline auto sharded_map
    ( (index_t<Shards>, T)->auto f
    , (T)->index_t<Shards> get_shard_idx
    , vector<T, N> x
    )
{
    optional<R>[Shards][N] per_shard_results = call();
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

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
fn debug_comment_then_gt() {
    // Comment line then > - this is what line 1110-1111 looks like
    let src = r#"
                                                        // Caller must ensure this limit is not exceeded.
    >
inline auto sharded_map
    ( (index_t<Shards>, T)->auto f
    , (T)->index_t<Shards> get_shard_idx
    , vector<T, N> x
    )
{
    optional<R>[Shards][N] per_shard_results = call();
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);

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
