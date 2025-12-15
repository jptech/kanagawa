//! Integration tests that run real .k files through the full pipeline.
//!
//! This test suite validates the Rust frontend by running actual Kanagawa source
//! files from the repository through CST parsing, AST lowering, and HIR lowering.

use kanagawa_ast::lower_file as lower_to_ast;
use kanagawa_hir::lower_file as lower_to_hir;
use kanagawa_syntax::parse_file;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Timeout for processing a single file (in seconds).
const FILE_TIMEOUT_SECS: u64 = 5;

/// Result of testing a single file at each pipeline stage.
#[derive(Debug, Clone)]
struct FileResult {
    path: PathBuf,
    cst_result: StageResult,
    ast_result: StageResult,
    hir_result: StageResult,
}

#[derive(Debug, Clone)]
enum StageResult {
    Success,
    Failed(String),
    Skipped, // Skipped because previous stage failed
}

impl StageResult {
    fn is_success(&self) -> bool {
        matches!(self, StageResult::Success)
    }

    fn is_failed(&self) -> bool {
        matches!(self, StageResult::Failed(_))
    }
}

/// Test a single file through the full pipeline (internal, without timeout).
fn test_file_internal(path: &Path) -> FileResult {
    let src = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return FileResult {
                path: path.to_path_buf(),
                cst_result: StageResult::Failed(format!("Failed to read file: {}", e)),
                ast_result: StageResult::Skipped,
                hir_result: StageResult::Skipped,
            };
        }
    };

    // Stage 1: CST parsing
    let parse = parse_file(&src);
    let cst_result = if parse.diagnostics.is_empty() {
        StageResult::Success
    } else {
        StageResult::Failed(format!(
            "{} diagnostic(s): {:?}",
            parse.diagnostics.len(),
            parse.diagnostics.iter().take(3).collect::<Vec<_>>()
        ))
    };

    if !cst_result.is_success() {
        return FileResult {
            path: path.to_path_buf(),
            cst_result,
            ast_result: StageResult::Skipped,
            hir_result: StageResult::Skipped,
        };
    }

    // Stage 2: AST lowering
    let root = parse.syntax_node();
    let ast_result = match lower_to_ast(&root) {
        Ok(_ast) => StageResult::Success,
        Err(e) => StageResult::Failed(format!("{:?}", e)),
    };

    if !ast_result.is_success() {
        return FileResult {
            path: path.to_path_buf(),
            cst_result,
            ast_result,
            hir_result: StageResult::Skipped,
        };
    }

    // Stage 3: HIR lowering
    let ast = lower_to_ast(&root).unwrap();
    let hir_result = match lower_to_hir(&ast) {
        Ok(_hir) => StageResult::Success,
        Err(e) => StageResult::Failed(format!("{:?}", e)),
    };

    FileResult {
        path: path.to_path_buf(),
        cst_result,
        ast_result,
        hir_result,
    }
}

/// Test a single file with a timeout.
fn test_file(path: &Path) -> FileResult {
    let path_owned = path.to_path_buf();
    let (tx, rx) = mpsc::channel();

    let path_clone = path_owned.clone();
    thread::spawn(move || {
        let result = test_file_internal(&path_clone);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(FILE_TIMEOUT_SECS)) {
        Ok(result) => result,
        Err(_) => {
            eprintln!("  TIMEOUT: {}", path.display());
            FileResult {
                path: path_owned,
                cst_result: StageResult::Failed(format!("Timeout after {}s", FILE_TIMEOUT_SECS)),
                ast_result: StageResult::Skipped,
                hir_result: StageResult::Skipped,
            }
        }
    }
}

/// Find all .k files under a directory.
fn find_k_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !dir.exists() {
        return files;
    }

    fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, files);
                } else if path.extension().map_or(false, |ext| ext == "k") {
                    files.push(path);
                }
            }
        }
    }

    walk(dir, &mut files);
    files.sort();
    files
}

/// Categorize a path into a directory group for reporting.
fn categorize_path(path: &Path, repo_root: &Path) -> String {
    let relative = path.strip_prefix(repo_root).unwrap_or(path);
    let components: Vec<_> = relative.components().take(3).collect();

    if components.len() >= 2 {
        format!(
            "{}/{}",
            components[0].as_os_str().to_string_lossy(),
            components[1].as_os_str().to_string_lossy()
        )
    } else if !components.is_empty() {
        components[0].as_os_str().to_string_lossy().to_string()
    } else {
        "unknown".to_string()
    }
}

/// Run all integration tests and generate a report.
fn run_integration_tests() -> (Vec<FileResult>, String) {
    // Find the repository root (4 levels up from CARGO_MANIFEST_DIR)
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent() // crates
        .and_then(|p| p.parent()) // rs
        .and_then(|p| p.parent()) // compiler
        .and_then(|p| p.parent()) // repo root
        .expect("Failed to find repository root");

    let library_dir = repo_root.join("library");
    let test_dir = repo_root.join("test");

    // Collect all .k files
    let mut all_files = Vec::new();
    all_files.extend(find_k_files(&library_dir));
    all_files.extend(find_k_files(&test_dir));

    eprintln!("Found {} .k files to test", all_files.len());

    // Test each file
    let results: Vec<FileResult> = all_files.iter().map(|p| test_file(p)).collect();

    // Generate report
    let report = generate_report(&results, repo_root);

    (results, report)
}

fn generate_report(results: &[FileResult], repo_root: &Path) -> String {
    let mut report = String::new();

    // Overall statistics
    let total = results.len();
    let cst_pass = results.iter().filter(|r| r.cst_result.is_success()).count();
    let ast_pass = results.iter().filter(|r| r.ast_result.is_success()).count();
    let hir_pass = results.iter().filter(|r| r.hir_result.is_success()).count();

    report.push_str("# Integration Test Report\n\n");
    report.push_str("## Overall Summary\n\n");
    report.push_str(&format!("| Stage | Passed | Failed | Rate |\n"));
    report.push_str(&format!("|-------|--------|--------|------|\n"));
    report.push_str(&format!(
        "| CST Parse | {} | {} | {:.1}% |\n",
        cst_pass,
        total - cst_pass,
        100.0 * cst_pass as f64 / total as f64
    ));
    report.push_str(&format!(
        "| AST Lower | {} | {} | {:.1}% |\n",
        ast_pass,
        cst_pass - ast_pass,
        if cst_pass > 0 {
            100.0 * ast_pass as f64 / cst_pass as f64
        } else {
            0.0
        }
    ));
    report.push_str(&format!(
        "| HIR Lower | {} | {} | {:.1}% |\n",
        hir_pass,
        ast_pass - hir_pass,
        if ast_pass > 0 {
            100.0 * hir_pass as f64 / ast_pass as f64
        } else {
            0.0
        }
    ));
    report.push_str(&format!(
        "| **Full Pipeline** | **{}** | **{}** | **{:.1}%** |\n\n",
        hir_pass,
        total - hir_pass,
        100.0 * hir_pass as f64 / total as f64
    ));

    // Group by directory
    let mut by_category: BTreeMap<String, Vec<&FileResult>> = BTreeMap::new();
    for result in results {
        let cat = categorize_path(&result.path, repo_root);
        by_category.entry(cat).or_default().push(result);
    }

    report.push_str("## Results by Directory\n\n");
    report.push_str("| Directory | Total | CST | AST | HIR |\n");
    report.push_str("|-----------|-------|-----|-----|-----|\n");

    for (cat, cat_results) in &by_category {
        let cat_total = cat_results.len();
        let cat_cst = cat_results
            .iter()
            .filter(|r| r.cst_result.is_success())
            .count();
        let cat_ast = cat_results
            .iter()
            .filter(|r| r.ast_result.is_success())
            .count();
        let cat_hir = cat_results
            .iter()
            .filter(|r| r.hir_result.is_success())
            .count();

        report.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            cat, cat_total, cat_cst, cat_ast, cat_hir
        ));
    }
    report.push('\n');

    // List failures (grouped by stage and error type)
    let cst_failures: Vec<_> = results.iter().filter(|r| r.cst_result.is_failed()).collect();
    let ast_failures: Vec<_> = results.iter().filter(|r| r.ast_result.is_failed()).collect();
    let hir_failures: Vec<_> = results.iter().filter(|r| r.hir_result.is_failed()).collect();

    if !cst_failures.is_empty() {
        report.push_str(&format!("## CST Parse Failures ({} files)\n\n", cst_failures.len()));
        for result in cst_failures.iter().take(20) {
            let relative = result.path.strip_prefix(repo_root).unwrap_or(&result.path);
            if let StageResult::Failed(msg) = &result.cst_result {
                report.push_str(&format!("- `{}`: {}\n", relative.display(), msg));
            }
        }
        if cst_failures.len() > 20 {
            report.push_str(&format!("- ... and {} more\n", cst_failures.len() - 20));
        }
        report.push('\n');
    }

    if !ast_failures.is_empty() {
        report.push_str(&format!("## AST Lowering Failures ({} files)\n\n", ast_failures.len()));
        for result in ast_failures.iter().take(20) {
            let relative = result.path.strip_prefix(repo_root).unwrap_or(&result.path);
            if let StageResult::Failed(msg) = &result.ast_result {
                report.push_str(&format!("- `{}`: {}\n", relative.display(), msg));
            }
        }
        if ast_failures.len() > 20 {
            report.push_str(&format!("- ... and {} more\n", ast_failures.len() - 20));
        }
        report.push('\n');
    }

    if !hir_failures.is_empty() {
        report.push_str(&format!("## HIR Lowering Failures ({} files)\n\n", hir_failures.len()));
        for result in hir_failures.iter().take(20) {
            let relative = result.path.strip_prefix(repo_root).unwrap_or(&result.path);
            if let StageResult::Failed(msg) = &result.hir_result {
                report.push_str(&format!("- `{}`: {}\n", relative.display(), msg));
            }
        }
        if hir_failures.len() > 20 {
            report.push_str(&format!("- ... and {} more\n", hir_failures.len() - 20));
        }
        report.push('\n');
    }

    report
}

#[test]
fn integration_test_full_pipeline() {
    let (results, report) = run_integration_tests();

    // Print the report
    eprintln!("\n{}", report);

    // Calculate pass rates
    let total = results.len();
    let hir_pass = results.iter().filter(|r| r.hir_result.is_success()).count();
    let pass_rate = 100.0 * hir_pass as f64 / total as f64;

    // For now, we just report results. Once we achieve a good pass rate,
    // we can add assertions to prevent regressions.
    eprintln!(
        "Full pipeline pass rate: {:.1}% ({}/{})",
        pass_rate, hir_pass, total
    );

    // Optionally write report to file
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let report_path = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("integration-test-report.md"));

    if let Some(path) = report_path {
        if let Err(e) = std::fs::write(&path, &report) {
            eprintln!("Warning: Failed to write report to {}: {}", path.display(), e);
        } else {
            eprintln!("Report written to: {}", path.display());
        }
    }
}

/// Test just the library files (smaller, faster iteration).
#[test]
fn integration_test_library_only() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .expect("Failed to find repository root");

    let library_dir = repo_root.join("library");
    let files = find_k_files(&library_dir);

    eprintln!("Testing {} library files", files.len());

    let results: Vec<FileResult> = files.iter().map(|p| test_file(p)).collect();

    let total = results.len();
    let cst_pass = results.iter().filter(|r| r.cst_result.is_success()).count();
    let ast_pass = results.iter().filter(|r| r.ast_result.is_success()).count();
    let hir_pass = results.iter().filter(|r| r.hir_result.is_success()).count();

    eprintln!("\nLibrary files summary:");
    eprintln!("  CST Parse: {}/{} ({:.1}%)", cst_pass, total, 100.0 * cst_pass as f64 / total as f64);
    eprintln!("  AST Lower: {}/{} ({:.1}%)", ast_pass, cst_pass, if cst_pass > 0 { 100.0 * ast_pass as f64 / cst_pass as f64 } else { 0.0 });
    eprintln!("  HIR Lower: {}/{} ({:.1}%)", hir_pass, ast_pass, if ast_pass > 0 { 100.0 * hir_pass as f64 / ast_pass as f64 } else { 0.0 });

    // List any failures
    for result in &results {
        if result.cst_result.is_failed() {
            let relative = result.path.strip_prefix(&repo_root).unwrap_or(&result.path);
            if let StageResult::Failed(msg) = &result.cst_result {
                eprintln!("  CST FAIL: {}: {}", relative.display(), msg);
            }
        } else if result.ast_result.is_failed() {
            let relative = result.path.strip_prefix(&repo_root).unwrap_or(&result.path);
            if let StageResult::Failed(msg) = &result.ast_result {
                eprintln!("  AST FAIL: {}: {}", relative.display(), msg);
            }
        } else if result.hir_result.is_failed() {
            let relative = result.path.strip_prefix(&repo_root).unwrap_or(&result.path);
            if let StageResult::Failed(msg) = &result.hir_result {
                eprintln!("  HIR FAIL: {}: {}", relative.display(), msg);
            }
        }
    }
}

/// Test just the syntax test files.
#[test]
fn integration_test_syntax_only() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .expect("Failed to find repository root");

    let syntax_dir = repo_root.join("test").join("syntax");
    let files = find_k_files(&syntax_dir);

    eprintln!("Testing {} syntax test files", files.len());

    let results: Vec<FileResult> = files.iter().map(|p| test_file(p)).collect();

    let total = results.len();
    let cst_pass = results.iter().filter(|r| r.cst_result.is_success()).count();
    let ast_pass = results.iter().filter(|r| r.ast_result.is_success()).count();
    let hir_pass = results.iter().filter(|r| r.hir_result.is_success()).count();

    eprintln!("\nSyntax test files summary:");
    eprintln!("  CST Parse: {}/{} ({:.1}%)", cst_pass, total, 100.0 * cst_pass as f64 / total as f64);
    eprintln!("  AST Lower: {}/{} ({:.1}%)", ast_pass, cst_pass, if cst_pass > 0 { 100.0 * ast_pass as f64 / cst_pass as f64 } else { 0.0 });
    eprintln!("  HIR Lower: {}/{} ({:.1}%)", hir_pass, ast_pass, if ast_pass > 0 { 100.0 * hir_pass as f64 / ast_pass as f64 } else { 0.0 });
}
