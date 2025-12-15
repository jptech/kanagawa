//! Test lambda assignment patterns.

use kanagawa_syntax::parse_file;
use kanagawa_ast::lower_file;

#[test]
fn test_lambda_with_assignment() {
    let src = r#"
function test() {
    auto result = [](T l, T r) {
        l = make_call(true, 1);
        return l;
    };
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    match lower_file(&parse.syntax_node()) {
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
fn test_member_assign_in_if() {
    // From fixed.k pattern
    let src = r#"
function test() {
    if (l.is_valid && r.is_valid)
        l = make_call(true);
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    match lower_file(&parse.syntax_node()) {
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
fn test_subscript_assign_in_static_for() {
    let src = r#"
function test() {
    static for(const auto i : N)
        values[i] = make_optional(i < v.size, v.data[i]);
}
"#;
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    match lower_file(&parse.syntax_node()) {
        Ok(ast) => {
            eprintln!("AST lowering succeeded!");
            eprintln!("Declarations: {}", ast.decls.len());
        }
        Err(e) => {
            panic!("AST lowering failed: {:?}", e);
        }
    }
}
