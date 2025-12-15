//! Integration tests for HIR lowering.
//!
//! These tests verify the full pipeline: parse → CST → AST → HIR.

use kanagawa_ast as ast;
use kanagawa_hir::{
    lower_file, DefKind, HirBinaryOp, HirExprKind, HirItem, HirStmt, HirUnaryOp, Ty,
};
use kanagawa_syntax::{parse_file, SyntaxNode};

/// Helper to parse source code and lower it to HIR.
fn parse_and_lower(src: &str) -> (kanagawa_hir::HirFile, kanagawa_hir::SymbolTable) {
    let parse_result = parse_file(src);
    let root = SyntaxNode::new_root(parse_result.green);
    let ast_file = ast::lower_file(&root).expect("AST lowering should succeed");
    lower_file(&ast_file).expect("HIR lowering should succeed")
}

// ============================================================================
// Function tests
// ============================================================================

#[test]
fn test_lower_empty_function() {
    let (hir, symbols) = parse_and_lower("void foo() {}");

    assert_eq!(hir.items.len(), 1);
    match &hir.items[0] {
        HirItem::Function(func) => {
            assert_eq!(func.name, "foo");
            assert!(matches!(func.return_ty, Ty::Void));
            assert!(func.params.is_empty());
            assert!(func.body.is_some());
        }
        _ => panic!("Expected function"),
    }

    // Check symbol table has the function
    let def_id = symbols.lookup("foo").expect("foo should be defined");
    let def = symbols.definition(def_id).expect("should have definition");
    assert_eq!(def.name, "foo");
    assert_eq!(def.kind, DefKind::Function);
}

#[test]
fn test_lower_function_with_params() {
    let (hir, symbols) = parse_and_lower("uint32 add(uint32 a, uint32 b) { return a + b; }");

    match &hir.items[0] {
        HirItem::Function(func) => {
            assert_eq!(func.name, "add");
            assert!(matches!(func.return_ty, Ty::Unsigned(32)));
            assert_eq!(func.params.len(), 2);
            assert_eq!(func.params[0].name, "a");
            assert_eq!(func.params[1].name, "b");

            // Check body has return statement
            let body = func.body.as_ref().expect("body should exist");
            assert_eq!(body.stmts.len(), 1);
            match &body.stmts[0] {
                HirStmt::Return(ret) => {
                    let value = ret.value.as_ref().expect("return should have value");
                    match &value.kind {
                        HirExprKind::Binary { op, .. } => {
                            assert_eq!(*op, HirBinaryOp::Add);
                        }
                        _ => panic!("Expected binary expression"),
                    }
                }
                _ => panic!("Expected return statement"),
            }
        }
        _ => panic!("Expected function"),
    }

    // Check parameters are in symbol table
    // Note: params are defined in function scope which we've exited,
    // so we check the function definition instead
    assert!(symbols.lookup("add").is_some());
}

#[test]
#[ignore] // Parser doesn't capture default parameter values in AST
fn test_lower_function_with_default_param() {
    let (hir, _) = parse_and_lower("void greet(uint32 times = 1) {}");

    match &hir.items[0] {
        HirItem::Function(func) => {
            assert_eq!(func.params.len(), 1);
            let param = &func.params[0];
            assert_eq!(param.name, "times");
            assert!(param.default.is_some());
        }
        _ => panic!("Expected function"),
    }
}

// ============================================================================
// Variable tests
// ============================================================================

#[test]
fn test_lower_variable_declaration() {
    let (hir, symbols) = parse_and_lower("uint32 x = 42;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            assert_eq!(var.name, "x");
            assert!(matches!(var.ty, Ty::Unsigned(32)));
            assert!(var.init.is_some());
            let init = var.init.as_ref().unwrap();
            match &init.kind {
                HirExprKind::IntLiteral { value, .. } => {
                    assert_eq!(*value, 42);
                }
                _ => panic!("Expected int literal"),
            }
        }
        _ => panic!("Expected variable"),
    }

    assert!(symbols.lookup("x").is_some());
}

#[test]
fn test_lower_const_variable() {
    // Note: In Kanagawa, `const` is a type modifier, so the constness is in the type, not flags
    let (hir, _) = parse_and_lower("const uint32 PI_APPROX = 3;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            // Const is in the type
            assert!(matches!(var.ty, Ty::Const(_)));
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
#[ignore] // Parser doesn't fully support top-level static declarations yet
fn test_lower_static_variable() {
    let (hir, _) = parse_and_lower("static uint32 counter = 0;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            assert!(var.flags.is_static);
        }
        _ => panic!("Expected variable"),
    }
}

// ============================================================================
// Struct tests
// ============================================================================

#[test]
fn test_lower_struct() {
    let (hir, symbols) = parse_and_lower("struct Point { uint32 x; uint32 y; }");

    match &hir.items[0] {
        HirItem::Struct(s) => {
            assert_eq!(s.name, "Point");
            assert_eq!(s.members.len(), 2);
            assert_eq!(s.members[0].name, "x");
            assert_eq!(s.members[1].name, "y");
        }
        _ => panic!("Expected struct"),
    }

    let def_id = symbols.lookup("Point").expect("Point should be defined");
    let def = symbols.definition(def_id).unwrap();
    assert_eq!(def.kind, DefKind::Type);
}

#[test]
fn test_lower_struct_with_initializers() {
    let (hir, _) = parse_and_lower("struct Config { uint32 timeout = 100; bool enabled = true; }");

    match &hir.items[0] {
        HirItem::Struct(s) => {
            assert_eq!(s.members.len(), 2);
            assert!(s.members[0].init.is_some());
            assert!(s.members[1].init.is_some());
        }
        _ => panic!("Expected struct"),
    }
}

// ============================================================================
// Enum tests
// ============================================================================

#[test]
fn test_lower_enum() {
    let (hir, symbols) = parse_and_lower("enum Color { Red, Green, Blue }");

    match &hir.items[0] {
        HirItem::Enum(e) => {
            assert_eq!(e.name, "Color");
            assert_eq!(e.variants.len(), 3);
            assert_eq!(e.variants[0].name, "Red");
            assert_eq!(e.variants[1].name, "Green");
            assert_eq!(e.variants[2].name, "Blue");
        }
        _ => panic!("Expected enum"),
    }

    assert!(symbols.lookup("Color").is_some());
}

#[test]
#[ignore] // Parser doesn't create Type node for enum base type (just bumps tokens)
fn test_lower_enum_with_values() {
    let (hir, _) = parse_and_lower("enum Status : uint8 { Off = 0, On = 1, Error = 255 }");

    match &hir.items[0] {
        HirItem::Enum(e) => {
            // Base type should be uint8
            assert!(
                matches!(e.base_ty, Ty::Unsigned(8)),
                "Expected Ty::Unsigned(8), got: {:?}",
                e.base_ty
            );
            assert_eq!(e.variants.len(), 3);
            // Check that variants have explicit values
            assert!(e.variants[0].value.is_some());
            assert!(e.variants[2].value.is_some());
        }
        _ => panic!("Expected enum"),
    }
}

// ============================================================================
// Class tests
// ============================================================================

#[test]
#[ignore] // Parser/AST issue: assignment inside method body causes MissingChild("assignment lhs")
fn test_lower_class() {
    let (hir, symbols) = parse_and_lower(
        r#"
        class Counter {
        public:
            uint32 value;
            void increment() { value = value + 1; }
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Class(c) => {
            assert_eq!(c.name, "Counter");
            assert!(!c.members.is_empty());
        }
        _ => panic!("Expected class"),
    }

    assert!(symbols.lookup("Counter").is_some());
}

// ============================================================================
// Union tests
// ============================================================================

#[test]
fn test_lower_union() {
    let (hir, _) = parse_and_lower("union Data { uint32 asInt; float asFloat; }");

    match &hir.items[0] {
        HirItem::Union(u) => {
            assert_eq!(u.name, "Data");
            assert_eq!(u.members.len(), 2);
        }
        _ => panic!("Expected union"),
    }
}

// ============================================================================
// Using (type alias) tests
// ============================================================================

#[test]
fn test_lower_using() {
    let (hir, symbols) = parse_and_lower("using Byte = uint8;");

    match &hir.items[0] {
        HirItem::Using(u) => {
            assert_eq!(u.name, "Byte");
            assert!(matches!(u.ty, Ty::Unsigned(8)));
        }
        _ => panic!("Expected using"),
    }

    assert!(symbols.lookup("Byte").is_some());
}

// ============================================================================
// Expression tests
// ============================================================================

#[test]
fn test_lower_binary_expressions() {
    let (hir, _) = parse_and_lower("uint32 x = 1 + 2 * 3;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            // Should parse as 1 + (2 * 3) due to precedence
            match &init.kind {
                HirExprKind::Binary { op: HirBinaryOp::Add, .. } => {}
                _ => panic!("Expected binary add"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_comparison_expressions() {
    let (hir, _) = parse_and_lower("bool x = 1 < 2;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Binary { op: HirBinaryOp::Lt, .. } => {}
                _ => panic!("Expected less-than comparison"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_unary_expressions() {
    let (hir, _) = parse_and_lower("int32 x = -42;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Unary { op: HirUnaryOp::Neg, .. } => {}
                _ => panic!("Expected unary negation"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_logical_not() {
    let (hir, _) = parse_and_lower("bool x = !true;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Unary { op: HirUnaryOp::Not, .. } => {}
                _ => panic!("Expected logical not"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_bitwise_invert() {
    let (hir, _) = parse_and_lower("uint32 x = ~0;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Unary { op: HirUnaryOp::Invert, .. } => {}
                _ => panic!("Expected bitwise invert"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_ternary_expression() {
    let (hir, _) = parse_and_lower("uint32 x = true ? 1 : 0;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Ternary { .. } => {}
                _ => panic!("Expected ternary expression"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_function_call() {
    let (hir, _) = parse_and_lower(
        r#"
        uint32 foo() { return 42; }
        uint32 x = foo();
        "#,
    );

    // Second item should be the variable
    match &hir.items[1] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Call { callee, args, .. } => {
                    match &callee.kind {
                        HirExprKind::Ident { name, .. } => {
                            assert_eq!(name, "foo");
                        }
                        _ => panic!("Expected identifier"),
                    }
                    assert!(args.is_empty());
                }
                _ => panic!("Expected function call"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_member_access() {
    let (hir, _) = parse_and_lower(
        r#"
        struct Point { uint32 x; uint32 y; }
        Point p;
        uint32 x = p.x;
        "#,
    );

    // Third item should be the variable x
    match &hir.items[2] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Member { member, .. } => {
                    assert_eq!(member, "x");
                }
                _ => panic!("Expected member access"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_subscript() {
    let (hir, _) = parse_and_lower(
        r#"
        uint32[10] arr;
        uint32 x = arr[0];
        "#,
    );

    match &hir.items[1] {
        HirItem::Variable(var) => {
            let init = var.init.as_ref().expect("should have init");
            match &init.kind {
                HirExprKind::Subscript { .. } => {}
                _ => panic!("Expected subscript"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

// ============================================================================
// Statement tests
// ============================================================================

#[test]
fn test_lower_if_statement() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo() {
            if (true) {
                return;
            }
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            match &body.stmts[0] {
                HirStmt::If(if_stmt) => {
                    assert!(if_stmt.else_branch.is_none());
                }
                _ => panic!("Expected if statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

#[test]
fn test_lower_if_else_statement() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo() {
            if (false) {
                return;
            } else {
                return;
            }
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            match &body.stmts[0] {
                HirStmt::If(if_stmt) => {
                    assert!(if_stmt.else_branch.is_some());
                }
                _ => panic!("Expected if statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

#[test]
#[ignore] // Parser doesn't properly create SwitchCase nodes in AST
fn test_lower_switch_statement() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo(uint32 x) {
            switch (x) {
                case 0: return;
                case 1: return;
                default: return;
            }
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            match &body.stmts[0] {
                HirStmt::Switch(switch) => {
                    assert_eq!(switch.cases.len(), 3);
                }
                _ => panic!("Expected switch statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

#[test]
fn test_lower_do_while() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo() {
            do {
                break;
            } while (false);
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            match &body.stmts[0] {
                HirStmt::DoWhile(_) => {}
                _ => panic!("Expected do-while statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

#[test]
fn test_lower_range_for() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo() {
            for (uint32 i : 10) {
                return;
            }
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            match &body.stmts[0] {
                HirStmt::RangeFor(range_for) => {
                    assert_eq!(range_for.var_name, "i");
                }
                _ => panic!("Expected range-for statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

#[test]
#[ignore] // Parser doesn't create AssignExpr inside AssignStmt
fn test_lower_assignment() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo() {
            uint32 x = 0;
            x = 1;
            x += 2;
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            // Third statement should be compound assignment
            match &body.stmts[2] {
                HirStmt::Assign(assign) => {
                    assert_eq!(assign.op, kanagawa_hir::HirAssignOp::AddAssign);
                }
                _ => panic!("Expected assignment statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

// ============================================================================
// Type tests
// ============================================================================

#[test]
#[ignore] // Parser bug: array dimensions not properly wrapped in TypeArray node
fn test_lower_array_type() {
    let (hir, _) = parse_and_lower("uint8[16] buffer;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            match &var.ty {
                Ty::Array { element, dims, .. } => {
                    assert!(matches!(element.as_ref(), Ty::Unsigned(8)));
                    assert_eq!(dims, &vec![16]);
                }
                other => panic!("Expected array type, got: {:?}", other),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
#[ignore] // Parser bug: array dimensions not properly wrapped in TypeArray node
fn test_lower_multi_dim_array() {
    let (hir, _) = parse_and_lower("uint32[4][4] matrix;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            match &var.ty {
                Ty::Array { dims, .. } => {
                    assert_eq!(dims.len(), 2);
                }
                _ => panic!("Expected array type"),
            }
        }
        _ => panic!("Expected variable"),
    }
}

#[test]
fn test_lower_const_type() {
    // Note: In Kanagawa, `const` is a type modifier, so the constness is in the type
    let (hir, _) = parse_and_lower("const uint32 x = 42;");

    match &hir.items[0] {
        HirItem::Variable(var) => {
            assert!(matches!(var.ty, Ty::Const(_)));
        }
        _ => panic!("Expected variable"),
    }
}

// ============================================================================
// Module tests
// ============================================================================

#[test]
fn test_lower_module_declaration() {
    let (hir, _) = parse_and_lower("module data.optional;");

    assert!(hir.module.is_some());
    let module = hir.module.as_ref().unwrap();
    assert_eq!(module.namespace, "@data@optional");
}

#[test]
fn test_lower_import() {
    let (hir, _) = parse_and_lower(
        r#"
        import data.optional;
        "#,
    );

    assert_eq!(hir.imports.len(), 1);
    assert_eq!(hir.imports[0].namespace, "@data@optional");
}

// ============================================================================
// Template tests
// ============================================================================

#[test]
#[ignore] // Parser doesn't populate template parameters in AST
fn test_lower_template_function() {
    let (hir, _) = parse_and_lower(
        r#"
        template<typename T>
        T identity(T x) { return x; }
        "#,
    );

    match &hir.items[0] {
        HirItem::Template(t) => {
            assert_eq!(t.params.len(), 1);
            match &*t.item {
                HirItem::Function(func) => {
                    assert_eq!(func.name, "identity");
                }
                _ => panic!("Expected function in template"),
            }
        }
        _ => panic!("Expected template"),
    }
}

// ============================================================================
// Symbol table tests
// ============================================================================

#[test]
fn test_symbol_resolution() {
    let (_, symbols) = parse_and_lower(
        r#"
        uint32 global_var = 0;

        void use_it() {
            uint32 local = global_var;
        }
        "#,
    );

    // Global variable should be in symbol table
    let global_def = symbols.lookup("global_var").expect("global_var should exist");
    let def = symbols.definition(global_def).unwrap();
    assert_eq!(def.kind, DefKind::Variable);
}

#[test]
fn test_qualified_name_lookup() {
    let (_, symbols) = parse_and_lower(
        r#"
        struct Foo {
            uint32 x;
        }
        "#,
    );

    // Foo should be accessible by simple name
    assert!(symbols.lookup("Foo").is_some());
}

// ============================================================================
// Edge cases
// ============================================================================

#[test]
fn test_lower_empty_file() {
    let (hir, _) = parse_and_lower("");
    assert!(hir.items.is_empty());
    assert!(hir.module.is_none());
    assert!(hir.imports.is_empty());
}

#[test]
fn test_lower_nested_blocks() {
    let (hir, _) = parse_and_lower(
        r#"
        void foo() {
            {
                {
                    return;
                }
            }
        }
        "#,
    );

    match &hir.items[0] {
        HirItem::Function(func) => {
            let body = func.body.as_ref().expect("body should exist");
            match &body.stmts[0] {
                HirStmt::Block(inner) => {
                    match &inner.stmts[0] {
                        HirStmt::Block(innermost) => {
                            assert!(!innermost.stmts.is_empty());
                        }
                        _ => panic!("Expected inner block"),
                    }
                }
                _ => panic!("Expected block statement"),
            }
        }
        _ => panic!("Expected function"),
    }
}

#[test]
fn test_lower_multiple_declarations() {
    let (hir, symbols) = parse_and_lower(
        r#"
        uint32 a;
        uint32 b;
        uint32 c;
        void foo() {}
        struct Bar {}
        "#,
    );

    assert_eq!(hir.items.len(), 5);
    assert!(symbols.lookup("a").is_some());
    assert!(symbols.lookup("b").is_some());
    assert!(symbols.lookup("c").is_some());
    assert!(symbols.lookup("foo").is_some());
    assert!(symbols.lookup("Bar").is_some());
}
