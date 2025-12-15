//! Test CST parsing only for a single .k file.

use kanagawa_syntax::parse_file;

fn main() {
    let file_path = std::env::args().nth(1).expect("Usage: cargo run --example test_cst_only <file.k>");
    let src = std::fs::read_to_string(&file_path).expect("Failed to read file");

    eprintln!("File size: {} bytes", src.len());

    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();

    println!("CST: {:?}, diagnostics: {}", elapsed, parse.diagnostics.len());

    if !parse.diagnostics.is_empty() {
        for d in parse.diagnostics.iter().take(3) {
            println!("  {:?}", d);
        }
    }
}
