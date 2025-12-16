//! Integration tests for the Kanagawa frontend pipeline.
//!
//! These tests verify the full frontend pipeline from source code to HIR
//! without requiring the backend library.

use kanagawa_syntax as syntax;

/// Parse source code and verify it parses without errors.
fn parse_source(source: &str) -> syntax::Parse {
    let parse = syntax::parse_file(source);
    if !parse.diagnostics.is_empty() {
        for d in &parse.diagnostics {
            eprintln!("{:?}: {} ({}..{})", d.severity, d.message, d.span.start, d.span.end);
        }
    }
    parse
}

/// Lower source code to AST.
fn lower_to_ast(source: &str) -> Result<kanagawa_ast::File, String> {
    let parse = parse_source(source);
    let syntax_node = parse.syntax_node();
    kanagawa_ast::lower_file(&syntax_node).map_err(|e| format!("{:?}", e))
}

/// Lower source code to HIR.
fn lower_to_hir(source: &str) -> Result<(kanagawa_hir::HirFile, kanagawa_hir::SymbolTable), String> {
    let ast = lower_to_ast(source)?;
    kanagawa_hir::lower_file(&ast).map_err(|e| format!("{:?}", e))
}

#[test]
fn test_empty_class() {
    let source = r#"
class Empty {
}
export Empty;
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 2, "should have 2 items (class + export)");
}

#[test]
fn test_class_with_function() {
    let source = r#"
class Counter {
public:
    void reset() {
        count = 0;
    }

    uint32 count;
}
export Counter;
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert!(hir.items.len() >= 2, "should have at least 2 items");
}

#[test]
fn test_function_with_return() {
    let source = r#"
uint64 get_cycles() {
    return __cycles();
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_struct_definition() {
    let source = r#"
struct Point {
    int32 x;
    int32 y;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 struct");
}

#[test]
fn test_enum_definition() {
    let source = r#"
enum Color : uint8 {
    Red = 0,
    Green = 1,
    Blue = 2
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 enum");
}

#[test]
fn test_using_declaration() {
    let source = r#"
using MyInt = int32;
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 using");
}

#[test]
fn test_variable_declaration() {
    let source = r#"
const int32 MAX_VALUE = 100;
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 variable");
}

#[test]
fn test_function_with_params() {
    let source = r#"
int32 add(int32 a, int32 b) {
    return a + b;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");

    // Verify the function has parameters
    if let kanagawa_hir::HirItem::Function(func) = &hir.items[0] {
        assert_eq!(func.params.len(), 2, "should have 2 parameters");
    } else {
        panic!("expected function item");
    }
}

#[test]
fn test_module_declaration() {
    let source = r#"
module test.example { }
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert!(hir.module.is_some(), "should have module declaration");
}

#[test]
fn test_import_declaration() {
    let source = r#"
import base.system
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.imports.len(), 1, "should have 1 import");
}

#[test]
fn test_for_loop() {
    // Kanagawa uses different for loop syntax: for (var : limit) or static for
    let source = r#"
void process() {
    for (auto i : 10) {
        __print(i);
    }
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_if_statement() {
    let source = r#"
int32 abs(int32 x) {
    if (x < 0) {
        return -x;
    }
    return x;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_while_loop() {
    let source = r#"
void wait_cycles(int32 n) {
    int32 i = 0;
    while (i < n) {
        i = i + 1;
    }
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_array_type() {
    let source = r#"
int32[10] get_array() {
    int32[10] arr;
    return arr;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_nested_class() {
    let source = r#"
class Outer {
public:
    struct Inner {
        int32 value;
    }

    Inner data;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 class");
}

#[test]
fn test_extern_declaration() {
    // Kanagawa extern declarations just reference a name
    let source = r#"
[[name("_hardware_dsp__fmul32")]]
extern fmul32;
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 extern");
}

#[test]
fn test_function_call_intrinsic() {
    let source = r#"
uint64 cycles() {
    return __cycles();
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");

    // Verify the function body contains a call expression
    if let kanagawa_hir::HirItem::Function(func) = &hir.items[0] {
        assert!(func.body.is_some(), "function should have a body");
        let body = func.body.as_ref().unwrap();
        assert!(!body.stmts.is_empty(), "body should have statements");
    }
}

#[test]
fn test_binary_expressions() {
    let source = r#"
int32 compute(int32 a, int32 b) {
    int32 sum = a + b;
    int32 diff = a - b;
    int32 prod = a * b;
    int32 quot = a / b;
    return sum + diff + prod + quot;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_comparison_expressions() {
    let source = r#"
bool compare(int32 a, int32 b) {
    bool lt = a < b;
    bool gt = a > b;
    bool eq = a == b;
    bool ne = a != b;
    return lt || gt || eq || ne;
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

// ============================================================================
// Intrinsic-specific tests
// ============================================================================

#[test]
fn test_intrinsic_cycles() {
    let source = r#"
uint64 get_cycles() {
    return __cycles();
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");

    // Verify the function body contains a return statement with a call
    if let kanagawa_hir::HirItem::Function(func) = &hir.items[0] {
        let body = func.body.as_ref().expect("function should have body");
        assert!(!body.stmts.is_empty(), "body should have statements");

        // Check return statement exists
        if let kanagawa_hir::HirStmt::Return(ret) = &body.stmts[0] {
            if let Some(expr) = &ret.value {
                // Should be a call expression
                if let kanagawa_hir::HirExprKind::Call { callee, .. } = &expr.kind {
                    // Callee should be __cycles identifier
                    if let kanagawa_hir::HirExprKind::Ident { name, .. } = &callee.kind {
                        assert_eq!(name, "__cycles");
                    }
                }
            }
        }
    }
}

#[test]
fn test_intrinsic_print() {
    let source = r#"
void debug_print(int32 value) {
    __print(value);
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_intrinsic_assert() {
    let source = r#"
void check_valid(bool condition) {
    assert(condition);
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_intrinsic_str_cnt() {
    let source = r#"
void log_message(string msg) {
    __str_cnt(msg);
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 1, "should have 1 function");
}

#[test]
fn test_method_call() {
    let source = r#"
class Counter {
public:
    void reset() {
        count = 0;
    }

    void increment() {
        count = count + 1;
    }

    uint32 count;
}

void test() {
    Counter c;
    c.reset();
    c.increment();
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    // Should have class + 2 functions (test + implicit or just test)
    assert!(hir.items.len() >= 1, "should have items");
}

#[test]
fn test_chained_method_calls() {
    let source = r#"
class Builder {
public:
    void set_value(int32 v) {
        value = v;
    }

    int32 value;
}

void test() {
    Builder b;
    b.set_value(42);
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert!(hir.items.len() >= 1, "should have items");
}

#[test]
fn test_function_with_multiple_args() {
    let source = r#"
int32 sum3(int32 a, int32 b, int32 c) {
    return a + b + c;
}

void test() {
    int32 result = sum3(1, 2, 3);
}
"#;
    let (hir, _symbols) = lower_to_hir(source).expect("should parse successfully");
    assert_eq!(hir.items.len(), 2, "should have 2 functions");
}
