//! Test for empty for body (semicolon) parsing and lowering.

use kanagawa_syntax::parse_file;
use kanagawa_ast::lower_file;

#[test]
fn static_for_with_empty_body() {
    // Test that `static for (x : N);` parses and lowers correctly
    let code = r#"
        inline void test() {
            uint32 x = 0;
            static for (const auto i : 10);
            x = 1;
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no CST errors, got: {:?}", parse.diagnostics);

    // Should lower to AST without error
    let result = lower_file(&parse.syntax_node());
    assert!(result.is_ok(), "Expected AST lowering to succeed, got: {:?}", result.err());
}

#[test]
fn range_for_with_empty_body() {
    // Test that `for (x : N);` parses and lowers correctly
    let code = r#"
        void test() {
            uint32 x = 0;
            for (const uint32 i : 10);
            x = 1;
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no CST errors, got: {:?}", parse.diagnostics);

    // Should lower to AST without error
    let result = lower_file(&parse.syntax_node());
    assert!(result.is_ok(), "Expected AST lowering to succeed, got: {:?}", result.err());
}

#[test]
fn unrolled_for_with_empty_body() {
    // Test that `unroll for (x : N);` parses and lowers correctly
    let code = r#"
        inline void test() {
            uint32 x = 0;
            unroll for (const auto i : 5);
            x = 1;
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no CST errors, got: {:?}", parse.diagnostics);

    // Should lower to AST without error
    let result = lower_file(&parse.syntax_node());
    assert!(result.is_ok(), "Expected AST lowering to succeed, got: {:?}", result.err());
}

#[test]
fn static_for_with_block_body_still_works() {
    // Ensure normal static for with block body still works
    let code = r#"
        inline void test() {
            uint32 sum = 0;
            static for (const auto i : 10) {
                sum += i;
            }
        }
    "#;
    let parse = parse_file(code);

    assert!(parse.diagnostics.is_empty(), "Expected no CST errors, got: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    assert!(result.is_ok(), "Expected AST lowering to succeed, got: {:?}", result.err());
}
