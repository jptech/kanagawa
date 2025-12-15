use std::{fs, path::Path, path::PathBuf};

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

fn parse_expected_zero_blocks(path: &Path, max_blocks: Option<usize>) -> usize {
    let text = fs::read_to_string(path).unwrap();

    let mut block = String::new();
    let mut parsed: usize = 0;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("expected:") {
            let expected = rest.trim().parse::<i64>().unwrap_or(-1);
            if expected == 0 {
                let parse = parse_file(&block);
                assert!(
                    parse.diagnostics.is_empty(),
                    "unexpected diagnostics for {} (expected:0 block): {:?}\n--- block ---\n{}\n--- end block ---",
                    path.display(),
                    parse.diagnostics,
                    block
                );
                parsed += 1;
                if let Some(max) = max_blocks {
                    if parsed >= max {
                        break;
                    }
                }
            }
            block.clear();
            continue;
        }

        block.push_str(line);
        block.push('\n');
    }

    // Some harness files may not end with an expected line; ignore trailing text in that case.
    parsed
}

fn parse_all_syntax_harness_files(max_blocks_per_file: Option<usize>) -> (usize, usize) {
    // These files contain multiple independent programs separated by `expected:<code>` directives.
    // We parse each `expected:0` block as its own file.
    let dir = repo_root().join("test").join("syntax");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "k"))
        .collect();
    files.sort();

    let mut total_parsed: usize = 0;
    let mut files_with_blocks: usize = 0;

    for path in files {
        let parsed = parse_expected_zero_blocks(&path, max_blocks_per_file);
        if parsed > 0 {
            total_parsed += parsed;
            files_with_blocks += 1;
        }
    }

    (total_parsed, files_with_blocks)
}

#[test]
fn parses_expected_zero_syntax_harness_blocks_smoke() {
    // Keep the default unit test suite fast while still covering a broad cross-section
    // of the syntax harness corpus.

    // Core statement/loop forms.
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/static-for.k"), None) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/unrolled-for.k"), None) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/atomic.k"), None) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/loops.k"), Some(25)) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/statement.k"), Some(25)) > 0);

    // Expressions/types/templates.
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/function-type.k"), None) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/decltype.k"), None) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/template.k"), Some(25)) > 0);
    assert!(
        parse_expected_zero_blocks(
            &repo_root().join("test/syntax/nested-templates.k"),
            Some(25)
        ) > 0
    );

    // Strings/initializers/closures.
    assert!(
        parse_expected_zero_blocks(
            &repo_root().join("test/syntax/interpolated-string.k"),
            Some(25)
        ) > 0
    );
    assert!(
        parse_expected_zero_blocks(
            &repo_root().join("test/syntax/initializer-list.k"),
            Some(25)
        ) > 0
    );
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/lambdas.k"), Some(25)) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/closures.k"), Some(25)) > 0);

    // Decls.
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/using.k"), Some(25)) > 0);
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/struct.k"), Some(25)) > 0);
    assert!(
        parse_expected_zero_blocks(
            &repo_root().join("test/syntax/function-template.k"),
            Some(25)
        ) > 0
    );
    assert!(
        parse_expected_zero_blocks(&repo_root().join("test/syntax/extern-class.k"), Some(25)) > 0
    );

    // Attributes + memory intent.
    assert!(
        parse_expected_zero_blocks(&repo_root().join("test/syntax/doc-comments.k"), Some(25)) > 0
    );
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/memory.k"), Some(25)) > 0);

    // Huge corpus: cap to keep unit tests fast while still getting broad coverage.
    assert!(parse_expected_zero_blocks(&repo_root().join("test/syntax/basics.k"), Some(60)) > 0);
}

#[test]
#[ignore = "exhaustive syntax harness parsing (run with: cargo test -p kanagawa_syntax -- --ignored)"]
fn parses_expected_zero_syntax_harness_blocks_exhaustive() {
    let (total_parsed, files_with_blocks) = parse_all_syntax_harness_files(None);

    assert!(
        total_parsed > 0,
        "expected to parse at least one expected:0 block"
    );
    assert!(
        files_with_blocks > 0,
        "expected at least one syntax harness file with expected:0 blocks"
    );
}
