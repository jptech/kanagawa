use std::{fs, path::PathBuf};

use kanagawa_syntax::parse_file;

fn repo_root() -> PathBuf {
    // crates/kanagawa_syntax -> crates -> rs -> compiler -> repo
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.join("..")
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap()
}

fn assert_parses_clean(rel: &str) {
    let path = repo_root().join(rel);
    let text = fs::read_to_string(&path).unwrap();
    let parse = parse_file(&text);
    assert!(
        parse.diagnostics.is_empty(),
        "unexpected diagnostics for {}: {:?}",
        path.display(),
        parse.diagnostics
    );
}

#[test]
fn parses_more_real_repo_files_without_diagnostics() {
    // Curated high-signal files covering:
    // - string interpolation + debug helpers
    // - templates + attributes
    // - extern class + function types + wrapper decls
    // - broader type-check-heavy syntax
    assert_parses_clean("library/debug/print.k");
    assert_parses_clean("library/data/random/toeplitz.k");
    assert_parses_clean("test/interface/external_class.k");
    assert_parses_clean("test/interface/export_class_test_cases_2.k");
}
