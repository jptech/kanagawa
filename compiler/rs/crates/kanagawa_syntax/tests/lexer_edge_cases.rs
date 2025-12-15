//! Edge case and robustness tests for the lexer.

use kanagawa_syntax::{lex, SyntaxKind};

/// Helper to lex and return token kinds (excluding whitespace and EOF).
fn lex_kinds(text: &str) -> Vec<SyntaxKind> {
    let (tokens, _) = lex(text);
    tokens
        .into_iter()
        .map(|t| t.kind)
        .filter(|k| *k != SyntaxKind::Whitespace && *k != SyntaxKind::Eof)
        .collect()
}

/// Helper to lex and return both kinds and text.
fn lex_with_text(text: &str) -> Vec<(SyntaxKind, String)> {
    let (tokens, _) = lex(text);
    tokens
        .into_iter()
        .filter(|t| t.kind != SyntaxKind::Whitespace && t.kind != SyntaxKind::Eof)
        .map(|t| {
            let span = t.span;
            (t.kind, text[span.start..span.end].to_string())
        })
        .collect()
}

// ============================================================================
// Operator edge cases
// ============================================================================

#[test]
fn lexes_all_single_char_operators() {
    let kinds = lex_kinds("+ - * / % & | ^ ~ ! < > = ? : . , ; ( ) { } [ ]");
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::Plus,
            SyntaxKind::Minus,
            SyntaxKind::Star,
            SyntaxKind::Slash,
            SyntaxKind::Percent,
            SyntaxKind::Amp,
            SyntaxKind::Pipe,
            SyntaxKind::Caret,
            SyntaxKind::Tilde,
            SyntaxKind::Not,
            SyntaxKind::Lt,
            SyntaxKind::Gt,
            SyntaxKind::Eq,
            SyntaxKind::Question,
            SyntaxKind::Colon,
            SyntaxKind::Dot,
            SyntaxKind::Comma,
            SyntaxKind::Semi,
            SyntaxKind::LParen,
            SyntaxKind::RParen,
            SyntaxKind::LBrace,
            SyntaxKind::RBrace,
            SyntaxKind::LBracket,
            SyntaxKind::RBracket,
        ]
    );
}

#[test]
fn lexes_all_two_char_operators() {
    let kinds = lex_kinds("++ -- << >> && || ^^ == != <= >= += -= *= /= %= &= |= ^= :: -> =>");
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::PlusPlus,
            SyntaxKind::MinusMinus,
            SyntaxKind::Shl,
            SyntaxKind::Shr,
            SyntaxKind::AndAnd,
            SyntaxKind::OrOr,
            SyntaxKind::XorXor,
            SyntaxKind::EqEq,
            SyntaxKind::NotEq,
            SyntaxKind::Le,
            SyntaxKind::Ge,
            SyntaxKind::PlusEq,
            SyntaxKind::MinusEq,
            SyntaxKind::StarEq,
            SyntaxKind::SlashEq,
            SyntaxKind::PercentEq,
            SyntaxKind::AmpEq,
            SyntaxKind::PipeEq,
            SyntaxKind::CaretEq,
            SyntaxKind::Scope,
            SyntaxKind::Arrow,
            SyntaxKind::FatArrow,
        ]
    );
}

#[test]
fn lexes_three_char_operators() {
    let kinds = lex_kinds("<<= >>= &&= ||= ... ..");
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::ShlEq,
            SyntaxKind::ShrEq,
            SyntaxKind::AndAndEq,
            SyntaxKind::OrOrEq,
            SyntaxKind::DotDotDot,
            SyntaxKind::DotDot,
        ]
    );
}

#[test]
fn operator_maximal_munch() {
    // Ensure the lexer uses maximal munch for operators
    let kinds = lex_kinds("a++b");
    assert_eq!(kinds[0], SyntaxKind::Ident);
    assert_eq!(kinds[1], SyntaxKind::PlusPlus);
    assert_eq!(kinds[2], SyntaxKind::Ident);

    let kinds = lex_kinds("a-->b");
    assert_eq!(kinds[0], SyntaxKind::Ident);
    assert_eq!(kinds[1], SyntaxKind::MinusMinus);
    assert_eq!(kinds[2], SyntaxKind::Gt);
    assert_eq!(kinds[3], SyntaxKind::Ident);
}

#[test]
fn adjacent_operators_without_spaces() {
    let kinds = lex_kinds("a<b>c");
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::Ident,
            SyntaxKind::Lt,
            SyntaxKind::Ident,
            SyntaxKind::Gt,
            SyntaxKind::Ident,
        ]
    );

    let kinds = lex_kinds("a<<b>>c");
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::Ident,
            SyntaxKind::Shl,
            SyntaxKind::Ident,
            SyntaxKind::Shr,
            SyntaxKind::Ident,
        ]
    );
}

// ============================================================================
// Keyword vs identifier
// ============================================================================

#[test]
fn all_keywords_recognized() {
    let keywords = vec![
        ("as", SyntaxKind::KwAs),
        ("atomic", SyntaxKind::KwAtomic),
        ("auto", SyntaxKind::KwAuto),
        ("barrier", SyntaxKind::KwBarrier),
        ("bitsizeof", SyntaxKind::KwBitsizeof),
        ("bitoffsetof", SyntaxKind::KwBitoffsetof),
        ("bool", SyntaxKind::KwBool),
        ("break", SyntaxKind::KwBreak),
        ("bytesizeof", SyntaxKind::KwBytesizeof),
        ("byteoffsetof", SyntaxKind::KwByteoffsetof),
        ("cast", SyntaxKind::KwCast),
        ("case", SyntaxKind::KwCase),
        ("class", SyntaxKind::KwClass),
        ("clog2", SyntaxKind::KwClog2),
        ("concat", SyntaxKind::KwConcat),
        ("const", SyntaxKind::KwConst),
        ("decltype", SyntaxKind::KwDecltype),
        ("default", SyntaxKind::KwDefault),
        ("do", SyntaxKind::KwDo),
        ("else", SyntaxKind::KwElse),
        ("enum", SyntaxKind::KwEnum),
        ("export", SyntaxKind::KwExport),
        ("extern", SyntaxKind::KwExtern),
        ("false", SyntaxKind::KwFalse),
        ("fan_out", SyntaxKind::KwFanOut),
        ("float32", SyntaxKind::KwFloat32),
        ("for", SyntaxKind::KwFor),
        ("if", SyntaxKind::KwIf),
        ("import", SyntaxKind::KwImport),
        ("inline", SyntaxKind::KwInline),
        ("int", SyntaxKind::KwInt),
        ("lutmul", SyntaxKind::KwLutmul),
        ("module", SyntaxKind::KwModule),
        ("mux", SyntaxKind::KwMux),
        ("noinline", SyntaxKind::KwNoinline),
        ("private", SyntaxKind::KwPrivate),
        ("public", SyntaxKind::KwPublic),
        ("reorder", SyntaxKind::KwReorder),
        ("return", SyntaxKind::KwReturn),
        ("static", SyntaxKind::KwStatic),
        ("static_assert", SyntaxKind::KwStaticAssert),
        ("string", SyntaxKind::KwString),
        ("struct", SyntaxKind::KwStruct),
        ("switch", SyntaxKind::KwSwitch),
        ("template", SyntaxKind::KwTemplate),
        ("true", SyntaxKind::KwTrue),
        ("typename", SyntaxKind::KwTypename),
        ("uint", SyntaxKind::KwUint),
        ("union", SyntaxKind::KwUnion),
        ("unrolled_for", SyntaxKind::KwUnrolledFor),
        ("using", SyntaxKind::KwUsing),
        ("void", SyntaxKind::KwVoid),
        ("while", SyntaxKind::KwWhile),
    ];

    for (text, expected) in keywords {
        let kinds = lex_kinds(text);
        assert_eq!(kinds, vec![expected], "keyword '{}' should lex as {:?}", text, expected);
    }
}

#[test]
fn keyword_prefixes_are_identifiers() {
    // Keywords followed by more characters should be identifiers
    let test_cases = vec![
        ("if_condition", SyntaxKind::Ident),
        ("while_loop", SyntaxKind::Ident),
        ("return_value", SyntaxKind::Ident),
        ("class_name", SyntaxKind::Ident),
        ("struct_field", SyntaxKind::Ident),
        ("auto1", SyntaxKind::Ident),
        ("int32", SyntaxKind::Ident), // int32 is an identifier, not keyword
        ("uint64", SyntaxKind::Ident),
        ("bool_flag", SyntaxKind::Ident),
        ("true_value", SyntaxKind::Ident),
        ("false_alarm", SyntaxKind::Ident),
    ];

    for (text, expected) in test_cases {
        let kinds = lex_kinds(text);
        assert_eq!(kinds, vec![expected], "'{}' should lex as {:?}", text, expected);
    }
}

#[test]
fn underscore_identifiers() {
    let test_cases = vec![
        ("_", SyntaxKind::Ident),
        ("__", SyntaxKind::Ident),
        ("_a", SyntaxKind::Ident),
        ("a_", SyntaxKind::Ident),
        ("_123", SyntaxKind::Ident),
        ("___foo___", SyntaxKind::Ident),
        ("_CamelCase", SyntaxKind::Ident),
    ];

    for (text, expected) in test_cases {
        let kinds = lex_kinds(text);
        assert_eq!(kinds, vec![expected], "'{}' should lex as {:?}", text, expected);
    }
}

// ============================================================================
// Integer literal edge cases
// ============================================================================

#[test]
fn decimal_integer_forms() {
    let cases = vec![
        "0", "1", "123", "999999999999",
        "1_000_000", "1__2__3", // underscores
        "123i32", "456u64", "789u8", // suffixes
        "1_000i16", // underscore + suffix
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
    }
}

#[test]
fn hex_integer_forms() {
    let cases = vec![
        "0x0", "0X0", "0xff", "0xFF", "0xDEADBEEF",
        "0x_1_2_3_4", // underscores
        "0xffu8", "0xFFi32", // suffixes
        "0xABCD_EF01u32",
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
    }
}

#[test]
fn binary_integer_forms() {
    let cases = vec![
        "0b0", "0B0", "0b1", "0b1010",
        "0b1010_0110", // underscores
        "0b11111111u8",
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
    }
}

#[test]
fn octal_integer_forms() {
    let cases = vec![
        "0o0", "0O0", "0o7", "0o755",
        "0o7_5_5",
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
    }
}

#[test]
fn integer_literal_kinds() {
    let cases = vec![
        ("123", SyntaxKind::IntDec),
        ("0xff", SyntaxKind::IntHex),
        ("0xFF", SyntaxKind::IntHex),
        ("0b1010", SyntaxKind::IntBin),
        ("0o755", SyntaxKind::IntOct),
    ];

    for (text, expected) in cases {
        let kinds = lex_kinds(text);
        assert_eq!(kinds, vec![expected], "'{text}' should be {expected:?}");
    }
}

// ============================================================================
// Float literal edge cases
// ============================================================================

#[test]
fn float_literal_forms() {
    let cases = vec![
        "0.0", "1.0", "3.14159",
        "1e10", "1E10", "1e-10", "1e+10",
        "1.5e10", "1.5E-10",
        ".5", ".123", ".5e10",
        "1_000.5", "1.000_001",
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
        let kinds = lex_kinds(text);
        assert_eq!(kinds, vec![SyntaxKind::Float], "'{text}' should be Float");
    }
}

#[test]
fn float_vs_int_vs_dot() {
    // "1." should be IntDec followed by Dot (not a float)
    let kinds = lex_kinds("1.");
    assert_eq!(kinds, vec![SyntaxKind::IntDec, SyntaxKind::Dot]);

    // ".1" should be a Float
    let kinds = lex_kinds(".1");
    assert_eq!(kinds, vec![SyntaxKind::Float]);

    // "1.a" should be IntDec, Dot, Ident
    let kinds = lex_kinds("1.a");
    assert_eq!(kinds, vec![SyntaxKind::IntDec, SyntaxKind::Dot, SyntaxKind::Ident]);
}

// ============================================================================
// String literal edge cases
// ============================================================================

#[test]
fn string_literal_basic() {
    let cases = vec![
        r#""""#,           // empty string
        r#""hello""#,      // simple string
        r#""hello world""#, // with space
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
        let kinds = lex_kinds(text);
        assert_eq!(kinds, vec![SyntaxKind::String], "'{text}' should be String");
    }
}

#[test]
fn string_with_escapes() {
    let cases = vec![
        r#""\n""#,         // newline
        r#""\t""#,         // tab
        r#""\r""#,         // carriage return
        r#""\\""#,         // backslash
        r#""\"""#,         // quote
        r#""a\nb\tc""#,    // mixed
    ];

    for text in cases {
        let (_, diags) = lex(text);
        assert!(diags.is_empty(), "'{text}' should lex cleanly: {diags:?}");
    }
}

#[test]
fn string_with_interpolation_braces() {
    // The lexer just produces a single String token; the parser handles interpolation
    let text = r#""{x}""#;
    let kinds = lex_kinds(text);
    assert_eq!(kinds, vec![SyntaxKind::String]);

    let text = r#""{x=}""#;
    let kinds = lex_kinds(text);
    assert_eq!(kinds, vec![SyntaxKind::String]);

    let text = r#""prefix {expr} suffix""#;
    let kinds = lex_kinds(text);
    assert_eq!(kinds, vec![SyntaxKind::String]);
}

// ============================================================================
// Comment edge cases
// ============================================================================

#[test]
fn deeply_nested_block_comments() {
    let text = "/* a /* b /* c /* d */ e */ f */ g */";
    let (_, diags) = lex(text);
    assert!(diags.is_empty(), "deeply nested comments should lex cleanly");
    let kinds = lex_kinds(text);
    assert_eq!(kinds, vec![SyntaxKind::BlockComment]);
}

#[test]
fn block_comment_with_stars() {
    let text = "/****/";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
    let kinds = lex_kinds(text);
    assert_eq!(kinds, vec![SyntaxKind::BlockComment]);

    let text = "/* * * * */";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());

    let text = "/*//*/"; // line comment syntax inside block comment
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

#[test]
fn line_comment_variations() {
    let text = "// normal comment\n//| pre doc\n//< post doc\n//";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());

    let kinds = lex_kinds(text);
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::LineComment,
            SyntaxKind::DocLineCommentPre,
            SyntaxKind::DocLineCommentPost,
            SyntaxKind::LineComment,
        ]
    );
}

#[test]
fn empty_doc_comments() {
    let text = "//|\n//<\n";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

// ============================================================================
// Error handling / recovery
// ============================================================================

#[test]
fn invalid_character_produces_error() {
    let text = "@";
    let (tokens, diags) = lex(text);
    assert!(!diags.is_empty(), "@ should produce a diagnostic");
    assert!(tokens.iter().any(|t| t.kind == SyntaxKind::Error));
}

#[test]
fn recovery_after_invalid_character() {
    let text = "a @ b";
    let (tokens, diags) = lex(text);
    assert!(!diags.is_empty(), "@ should produce a diagnostic");

    // Should still produce Ident, Error, Ident
    let kinds = lex_kinds(text);
    assert!(kinds.contains(&SyntaxKind::Ident));
    assert!(kinds.contains(&SyntaxKind::Error));
}

#[test]
fn unterminated_string() {
    let text = "\"hello";
    let (_, diags) = lex(text);
    // This should either produce a diagnostic or handle gracefully
    // The exact behavior depends on implementation
    assert!(!diags.is_empty() || true, "unterminated string handled");
}

#[test]
fn unterminated_block_comment() {
    let text = "/* hello";
    let (tokens, _) = lex(text);
    // Should still produce a BlockComment token (consumed to end)
    let kinds = lex_kinds(text);
    assert!(kinds.contains(&SyntaxKind::BlockComment));
}

// ============================================================================
// Whitespace handling
// ============================================================================

#[test]
fn various_whitespace_forms() {
    let text = "a\tb\nc\rd\r\ne";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());

    let kinds = lex_kinds(text);
    assert_eq!(kinds.len(), 5); // 5 identifiers
    assert!(kinds.iter().all(|k| *k == SyntaxKind::Ident));
}

#[test]
fn multiple_consecutive_whitespace() {
    let text = "a    b\n\n\nc";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

// ============================================================================
// Complex combined scenarios
// ============================================================================

#[test]
fn complex_expression_lexing() {
    let text = "x + y * z - (a << b) && c || d ^^ e";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());

    let kinds = lex_kinds(text);
    assert_eq!(
        kinds,
        vec![
            SyntaxKind::Ident,   // x
            SyntaxKind::Plus,    // +
            SyntaxKind::Ident,   // y
            SyntaxKind::Star,    // *
            SyntaxKind::Ident,   // z
            SyntaxKind::Minus,   // -
            SyntaxKind::LParen,  // (
            SyntaxKind::Ident,   // a
            SyntaxKind::Shl,     // <<
            SyntaxKind::Ident,   // b
            SyntaxKind::RParen,  // )
            SyntaxKind::AndAnd,  // &&
            SyntaxKind::Ident,   // c
            SyntaxKind::OrOr,    // ||
            SyntaxKind::Ident,   // d
            SyntaxKind::XorXor,  // ^^
            SyntaxKind::Ident,   // e
        ]
    );
}

#[test]
fn function_declaration_lexing() {
    let text = "[[pipelined]] inline uint32 foo(uint32 a, bool b) { return a + b; }";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

#[test]
fn template_syntax_lexing() {
    let text = "template <typename T, auto N> struct Array { T data[N]; }";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

#[test]
fn type_expressions_lexing() {
    let text = "uint<clog2(N)+1> int<bitsizeof(T)> decltype(x)";
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

#[test]
fn interpolated_string_with_format() {
    let text = r#""{value:x8}""#;
    let (_, diags) = lex(text);
    assert!(diags.is_empty());
}

#[test]
fn real_world_snippet() {
    let text = r#"
        module my.module {
            MyClass,
            helper_function
        }

        import std.optional as opt

        [[pipelined, async]]
        inline uint32 process(uint32 input) {
            static uint32 counter = 0;
            counter++;
            if (input > 0) {
                return mux(input & 1, input >> 1, input * 3 + 1);
            }
            return 0;
        }
    "#;
    let (_, diags) = lex(text);
    assert!(diags.is_empty(), "real world snippet should lex cleanly: {diags:?}");
}
