use std::{
    fs,
    path::{Path, PathBuf},
};

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

fn collect_k_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() {
            collect_k_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("k") {
            out.push(path);
        }
    }
}

fn assert_lexes_clean(path: &Path) {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let Ok(text) = std::str::from_utf8(&bytes) else {
        // Some tests include non-text fixtures with a `.k` extension.
        // The Rust lexer is defined over UTF-8 source text.
        return;
    };
    let (_tokens, diags) = kanagawa_syntax::lex(&text);
    if diags.is_empty() {
        return;
    }

    let d = &diags[0];
    let start = d.span.start.saturating_sub(40);
    let end = (d.span.end + 40).min(text.len());
    let snippet = text[start..end].replace('\n', "\\n");
    panic!(
        "lexer diagnostics for {}: {} ({}..{}), snippet: {}",
        path.display(),
        d.message,
        d.span.start,
        d.span.end,
        snippet
    );
}

#[test]
fn lexes_library_and_tests_cleanly() {
    let root = repo_root();
    let mut files = Vec::new();

    collect_k_files(&root.join("library"), &mut files);
    collect_k_files(&root.join("test"), &mut files);

    assert!(!files.is_empty(), "expected some .k files");

    for f in files {
        assert_lexes_clean(&f);
    }
}

#[test]
fn nested_block_comments_are_single_token() {
    let text = "/* a /* b */ c */";
    let (tokens, diags) = kanagawa_syntax::lex(text);
    assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");

    let kinds: Vec<_> = tokens.into_iter().map(|t| t.kind).collect();
    assert!(kinds.contains(&kanagawa_syntax::SyntaxKind::BlockComment));
    assert!(!kinds.contains(&kanagawa_syntax::SyntaxKind::Error));
}

#[test]
fn numeric_literal_forms() {
    let text = "0xffu16 0b1010_0110u8 0o755 1_000_000 3.14 1e-3 .5";
    let (_tokens, diags) = kanagawa_syntax::lex(text);
    assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");
}

#[test]
fn doc_comments_are_distinct_tokens() {
    let text = "//| pre doc\n//< post doc\n// normal\n";
    let (tokens, diags) = kanagawa_syntax::lex(text);
    assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");

    let mut kinds = tokens.into_iter().map(|t| t.kind);
    // First token should be doc pre comment.
    assert_eq!(
        kinds.next().unwrap(),
        kanagawa_syntax::SyntaxKind::DocLineCommentPre
    );
    assert_eq!(
        kinds.next().unwrap(),
        kanagawa_syntax::SyntaxKind::Whitespace
    );
    // Then doc post comment.
    assert_eq!(
        kinds.next().unwrap(),
        kanagawa_syntax::SyntaxKind::DocLineCommentPost
    );
    assert_eq!(
        kinds.next().unwrap(),
        kanagawa_syntax::SyntaxKind::Whitespace
    );
    // Then normal line comment.
    assert_eq!(
        kinds.next().unwrap(),
        kanagawa_syntax::SyntaxKind::LineComment
    );
}
