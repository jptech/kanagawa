use kanagawa_syntax::{lex, parse_file, SyntaxKind};

#[test]
fn parses_block_scope_declarations_shape_first() {
    fn assert_ok(name: &str, src: &str) {
        let parse = parse_file(src);
        if !parse.diagnostics.is_empty() {
            let (tokens, _diags) = lex(src);
            let mut tail = Vec::new();
            for t in tokens.iter().rev() {
                if t.kind.is_trivia() {
                    continue;
                }
                tail.push(format!("{:?}@{}..{}", t.kind, t.span.start, t.span.end));
                if tail.len() >= 32 {
                    break;
                }
            }
            tail.reverse();

            panic!(
                "{name}: unexpected diagnostics: {:?}\n--- token tail ---\n{}\n--- src ---\n{src}\n--- end src ---",
                parse.diagnostics,
                tail.join("\n")
            );
        }
    }

    assert_ok("empty", "inline void main() { }\n");
    assert_ok("using", "inline void main() { using foo = uint32; }\n");
    assert_ok("struct", "inline void main() { struct S { uint32 x; }; }\n");
    assert_ok("enum", "inline void main() { enum E { A, B, C }; }\n");
    assert_ok(
        "union",
        "inline void main() { union U { uint32 x; uint32 y; }; }\n",
    );
    assert_ok(
        "template_struct",
        "inline void main() { template <auto N> struct T { uint32 x; }; }\n",
    );
    assert_ok(
        "local_class_with_members",
        "inline void main() { class C { public: uint32 Do() { return 10; } uint32 x; }; }\n",
    );
    assert_ok(
        "local_fn_def",
        "inline void main() { inline void LocalFn() { return; } LocalFn(); }\n",
    );

    let src = r#"
inline void main() {
    using foo = uint32;

    struct S { uint32 x; };
    enum E { A, B, C };
    union U { uint32 x; uint32 y; };

    template <auto N>
    struct T { uint32 x; };

    class C {
    public:
        inline uint32 Do() { return 10; }
        uint32 x;
    };

    static if (true) {
        inline void Nested() { return; }
    }

    inline void LocalFn() {
        return;
    }

    LocalFn();
}
"#;

    assert_ok("combined", src);

    // Spot-check that we actually built the intended nodes (not strictly necessary for
    // diagnostic-freeness, but useful to ensure the new dispatch paths are exercised).
    let root = parse_file(src).syntax_node();
    let mut saw_fn_def = false;
    let mut saw_class = false;
    let mut saw_using = false;

    for ev in root.descendants() {
        match ev.kind() {
            SyntaxKind::FunctionDef => saw_fn_def = true,
            SyntaxKind::ClassDecl => saw_class = true,
            SyntaxKind::UsingDecl => saw_using = true,
            _ => {}
        }
    }

    assert!(saw_fn_def, "expected at least one FunctionDef node");
    assert!(saw_class, "expected at least one ClassDecl node");
    assert!(saw_using, "expected at least one UsingDecl node");
}
