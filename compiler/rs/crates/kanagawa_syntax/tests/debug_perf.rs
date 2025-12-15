//! Performance tests for large initializer lists.

use kanagawa_syntax::{parse_file, SyntaxKind};
use std::time::Instant;

fn generate_source(size: usize) -> String {
    let mut src = String::from("const memory<uint32, ");
    src.push_str(&size.to_string());
    src.push_str("> table = {\n");
    for i in 0..size {
        if i > 0 {
            src.push_str(", ");
            if i % 16 == 0 {
                src.push('\n');
            }
        }
        src.push_str(&i.to_string());
    }
    src.push_str("\n};\n");
    src
}

#[test]
fn test_cst_correctness() {
    for size in [10, 100, 500, 1000] {
        let src = generate_source(size);
        let parse = parse_file(&src);

        assert!(
            parse.diagnostics.is_empty(),
            "Parse errors at size {}: {:?}",
            size,
            parse.diagnostics
        );

        let root = parse.syntax_node();
        let global_vars: Vec<_> = root
            .children()
            .filter(|n| n.kind() == SyntaxKind::GlobalVarDecl)
            .collect();

        assert_eq!(
            global_vars.len(),
            1,
            "Should have exactly 1 GlobalVarDecl at size {}",
            size
        );

        // Check that the InitializerListExpr has the correct number of elements
        if let Some(gv) = global_vars.first() {
            let init_list = gv
                .descendants()
                .find(|n| n.kind() == SyntaxKind::InitializerListExpr);
            assert!(init_list.is_some(), "Should have InitializerListExpr");

            if let Some(il) = init_list {
                let expr_count = il.children().filter(|n| n.kind() == SyntaxKind::Expr).count();
                assert_eq!(
                    expr_count, size,
                    "Should have {} expressions in initializer list",
                    size
                );
            }
        }
    }
}

#[test]
fn test_performance_linear() {
    eprintln!("Size | Time (ms) | Time/Element (µs)");
    eprintln!("-----|-----------|------------------");
    for size in [100, 200, 500, 1000, 2000] {
        let src = generate_source(size);
        let start = Instant::now();
        let parse = parse_file(&src);
        let elapsed = start.elapsed();
        let per_element = elapsed.as_micros() as f64 / size as f64;
        eprintln!(
            "{:4} | {:9.3} | {:17.2}",
            size,
            elapsed.as_millis() as f64,
            per_element
        );
        assert!(
            parse.diagnostics.is_empty(),
            "Parse errors at size {}: {:?}",
            size,
            parse.diagnostics
        );
        // Ensure reasonable time - should be under 100µs per element on average
        assert!(
            per_element < 100.0,
            "Too slow: {} µs per element at size {}",
            per_element,
            size
        );
    }
}
