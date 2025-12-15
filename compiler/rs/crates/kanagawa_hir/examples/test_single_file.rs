//! Test a single .k file through the pipeline.

use kanagawa_ast::lower_file as lower_to_ast;
use kanagawa_hir::lower_file as lower_to_hir;
use kanagawa_syntax::parse_file;

fn main() {
    let file_path = std::env::args().nth(1).expect("Usage: cargo run --example test_single_file <file.k>");
    let src = std::fs::read_to_string(&file_path).expect("Failed to read file");

    let start = std::time::Instant::now();

    // Stage 1: CST
    let parse = parse_file(&src);
    let cst_time = start.elapsed();
    println!("CST: {:?}, diagnostics: {}", cst_time, parse.diagnostics.len());

    if !parse.diagnostics.is_empty() {
        for d in parse.diagnostics.iter().take(3) {
            println!("  {:?}", d);
        }
        return;
    }

    // Stage 2: AST
    let ast_start = std::time::Instant::now();
    let root = parse.syntax_node();
    let ast_result = lower_to_ast(&root);
    let ast_time = ast_start.elapsed();

    match ast_result {
        Ok(ast) => {
            println!("AST: {:?}", ast_time);

            // Stage 3: HIR
            let hir_start = std::time::Instant::now();
            let hir_result = lower_to_hir(&ast);
            let hir_time = hir_start.elapsed();

            match hir_result {
                Ok(_) => println!("HIR: {:?}", hir_time),
                Err(e) => println!("HIR FAILED: {:?}: {:?}", hir_time, e),
            }
        }
        Err(e) => println!("AST FAILED: {:?}: {:?}", ast_time, e),
    }

    println!("Total: {:?}", start.elapsed());
}
