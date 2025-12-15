//! Test cast expression lowering.

use kanagawa_syntax::parse_file;
use kanagawa_ast::lower_file;

#[test]
fn test_cast_lowering() {
    let src = r#"
function test() {
    const auto x = cast<uint32>(1);
}
"#;
    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_with_type_param() {
    let src = r#"
template <typename R, typename T>
function test(T input) {
    const auto x = cast<R>(input);
}
"#;
    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_with_subscript() {
    let src = r#"
function test(uint32[10] input) {
    const auto x = cast<uint32>(input[0]);
}
"#;
    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_in_static_assert() {
    let src = r#"
function test() {
    static assert(cast<uint32>(-1) > 0);
}
"#;
    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_in_template_function() {
    // This mimics the pattern in library/data/array.k
    let src = r#"
template <typename R, typename T, auto N>
inline R[N] inclusive_scan(T[N] input) {
    R[2][N] results;
    static for (const auto i : N) {
        results[0][i] = cast<R>(input[i]);
    }
    return results[0];
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_with_nested_template() {
    // Line 584 in array.k: cast<index_t<N>>(...)
    let src = r#"
template <auto N>
function test() {
    const auto Offset = cast<index_t<N>>((5 - 3) % N);
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_with_decltype() {
    // From fixed.k line 68: cast<decltype(result.value.value)>(...)
    let src = r#"
function test() {
    Result result;
    result.value = cast<decltype(result.value)>(42);
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_with_multi_param_nested_template() {
    // From fixed.k line 632: cast<log2_40_paramPacked<F1, 3, indexWidth>>(fraction)
    let src = r#"
template <auto F1, auto indexWidth>
function test(uint32 fraction) {
    const auto x = cast<log2_40_paramPacked<F1, 3, indexWidth>>(fraction);
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_cast_with_paren_expr_in_template() {
    // From fixed.k line 637: cast<log2_40_paramPacked<F1, 4, (indexWidth - 1)>>(fraction)
    let src = r#"
template <auto F1, auto indexWidth>
function test(uint32 fraction) {
    const auto x = cast<log2_40_paramPacked<F1, 4, (indexWidth - 1)>>(fraction);
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_double_subscript_assign() {
    let src = r#"
function test() {
    results[0][i] = x;
}
"#;
    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}

#[test]
fn test_member_subscript_assign() {
    let src = r#"
function test() {
    result.data[i] = x;
}
"#;
    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "CST parse errors: {:?}", parse.diagnostics);

    let result = lower_file(&parse.syntax_node());
    match result {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}
