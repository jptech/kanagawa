//! Check AST lowering on all library files.

use kanagawa_ast::lower_file;
use kanagawa_syntax::parse_file;
use std::collections::HashMap;
use std::path::Path;

fn collect_k_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(collect_k_files(&path));
            } else if path.extension().is_some_and(|e| e == "k") {
                files.push(path);
            }
        }
    }
    files
}

#[test]
fn check_library_ast() {
    // CARGO_MANIFEST_DIR = /Users/parker/experiments/kanagawa/compiler/rs/crates/kanagawa_ast
    // We need to go up to /Users/parker/experiments/kanagawa and then into library
    let library_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent() // crates
        .unwrap()
        .parent() // rs
        .unwrap()
        .parent() // compiler
        .unwrap()
        .parent() // kanagawa
        .unwrap()
        .join("library");

    let files = collect_k_files(&library_dir);

    let mut cst_ok = 0;
    let mut cst_fail = 0;
    let mut ast_ok = 0;
    let mut ast_fail = 0;
    let mut errors: HashMap<String, Vec<String>> = HashMap::new();

    for path in &files {
        let src = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let parse = parse_file(&src);
        if !parse.diagnostics.is_empty() {
            cst_fail += 1;
            continue;
        }
        cst_ok += 1;

        match lower_file(&parse.syntax_node()) {
            Ok(_) => {
                ast_ok += 1;
            }
            Err(e) => {
                ast_fail += 1;
                let err_str = format!("{:?}", e);
                let short_path = path.strip_prefix(&library_dir)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| path.display().to_string());
                errors.entry(err_str).or_default().push(short_path);
            }
        }
    }

    eprintln!("\n=== Library AST Check Results ===");
    eprintln!("Total files: {}", files.len());
    eprintln!("CST Parse: {}/{} ({:.1}%)", cst_ok, files.len(), 100.0 * cst_ok as f64 / files.len() as f64);
    eprintln!("AST Lower: {}/{} ({:.1}%)", ast_ok, cst_ok, 100.0 * ast_ok as f64 / cst_ok as f64);

    eprintln!("\n=== Errors by type ===");
    let mut err_vec: Vec<_> = errors.iter().collect();
    err_vec.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    for (err, paths) in err_vec {
        eprintln!("\n{} ({} files):", err, paths.len());
        for p in paths.iter().take(5) {
            eprintln!("  - {}", p);
        }
        if paths.len() > 5 {
            eprintln!("  ... and {} more", paths.len() - 5);
        }
    }

    // Don't fail the test, just report
    eprintln!("\n");
}
