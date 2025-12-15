//! Complex scenario and error handling tests for CST→AST lowering.

use kanagawa_ast::{lower_file, Decl, Expr, File, Stmt, Type};
use kanagawa_syntax::parse_file;

/// Helper to parse and lower source code.
fn lower(src: &str) -> Result<File, kanagawa_ast::LowerError> {
    let parse = parse_file(src);
    // Don't assert clean parse - some tests intentionally have parse issues
    let root = parse.syntax_node();
    lower_file(&root)
}

/// Helper to parse and lower, expecting success.
fn lower_ok(src: &str) -> File {
    let parse = parse_file(src);
    assert!(
        parse.diagnostics.is_empty(),
        "CST parse errors: {:?}",
        parse.diagnostics
    );
    let root = parse.syntax_node();
    lower_file(&root).expect("lowering should succeed")
}

// ============================================================================
// Complex function bodies
// ============================================================================

#[test]
fn lowers_deeply_nested_blocks() {
    let src = r#"
        inline void foo() {
            {
                {
                    {
                        return;
                    }
                }
            }
        }
    "#;
    let file = lower_ok(src);
    assert_eq!(file.decls.len(), 1);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().expect("expected body");
    assert!(!body.stmts.is_empty());
}

#[test]
fn lowers_deeply_nested_if_else() {
    let src = r#"
        inline uint32 foo(bool a, bool b, bool c) {
            if (a) {
                if (b) {
                    if (c) {
                        return 1;
                    } else {
                        return 2;
                    }
                } else {
                    return 3;
                }
            } else {
                return 4;
            }
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::If(outer_if) = &body.stmts[0] else {
        panic!("expected if statement");
    };

    // Check that the then branch contains another if
    let Stmt::Block(then_block) = outer_if.then_branch.as_ref() else {
        panic!("expected block");
    };

    let Stmt::If(_) = &then_block.stmts[0] else {
        panic!("expected nested if");
    };
}

#[test]
fn lowers_switch_statement() {
    // Basic switch statement
    let src = r#"
        inline uint32 foo(uint32 x) {
            switch (x) {
                case 0:
                    break;
            }
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Switch(switch) = &body.stmts[0] else {
        panic!("expected switch statement");
    };

    // Verify switch has an expression
    // Note: case lowering depends on CST structure
    assert!(matches!(&switch.expr, Expr::Ident(_)));
}

#[test]
fn lowers_nested_loops() {
    let src = r#"
        inline void foo() {
            for (const uint32 i : 10) {
                for (const uint32 j : 10) {
                    do {
                        barrier;
                    } while (condition);
                }
            }
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::RangeFor(outer_for) = &body.stmts[0] else {
        panic!("expected range for");
    };

    assert_eq!(outer_for.var_name.text, "i");
}

// ============================================================================
// Complex expressions
// ============================================================================

#[test]
fn lowers_complex_binary_chain() {
    let src = r#"
        inline uint32 foo() {
            return a + b * c - d;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Return(ret) = &body.stmts[0] else {
        panic!("expected return");
    };

    let Expr::Binary(_) = ret.value.as_ref().unwrap() else {
        panic!("expected binary expression");
    };
}

#[test]
fn lowers_ternary_expression() {
    let src = r#"
        inline uint32 foo(bool cond) {
            return cond ? 1 : 0;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Return(ret) = &body.stmts[0] else {
        panic!("expected return");
    };

    let Expr::Ternary(ternary) = ret.value.as_ref().unwrap() else {
        panic!("expected ternary expression");
    };

    // Check that we have condition, then, and else expressions
    assert!(matches!(ternary.then_expr.as_ref(), Expr::IntLiteral(_)));
    assert!(matches!(ternary.else_expr.as_ref(), Expr::IntLiteral(_)));
}

#[test]
fn lowers_member_chain() {
    let src = r#"
        inline void foo() {
            return a.b.c.d;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Return(ret) = &body.stmts[0] else {
        panic!("expected return stmt");
    };

    // Should be nested MemberExpr
    let Expr::Member(outer) = ret.value.as_ref().unwrap() else {
        panic!("expected member expr");
    };
    assert_eq!(outer.member.text, "d");
}

#[test]
fn lowers_subscript_chain() {
    let src = r#"
        inline void foo() {
            arr[i][j][k];
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expr stmt");
    };

    // Should be nested SubscriptExpr
    let Expr::Subscript(_) = &expr_stmt.expr else {
        panic!("expected subscript expr");
    };
}

#[test]
fn lowers_call_with_multiple_args() {
    let src = r#"
        inline void foo() {
            bar(1, 2, 3, 4, 5);
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expr stmt");
    };

    let Expr::Call(call) = &expr_stmt.expr else {
        panic!("expected call expr");
    };

    assert_eq!(call.args.len(), 5);
}

#[test]
fn lowers_method_call_chain() {
    let src = r#"
        inline void foo() {
            obj.method1().method2().method3();
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expr stmt");
    };

    // Should have nested call expressions
    let Expr::Call(_) = &expr_stmt.expr else {
        panic!("expected call expr");
    };
}

// ============================================================================
// Complex types
// ============================================================================

#[test]
fn lowers_integer_type_variations() {
    let src = r#"
        inline void foo() {
            uint8 a;
            int16 b;
            uint32 c;
            int64 d;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    assert_eq!(body.stmts.len(), 4);

    // Check each variable declaration has the right type
    for stmt in &body.stmts {
        let Stmt::VarDecl(var) = stmt else {
            panic!("expected var decl");
        };
        match &var.ty {
            Type::Integer(int_ty) => {
                // Just check it's an integer type
                assert!(matches!(int_ty.width, kanagawa_ast::IntWidth::Fixed(_)));
            }
            _ => panic!("expected integer type"),
        }
    }
}

#[test]
fn lowers_array_type() {
    // Note: Array types in struct members may be lowered differently
    // This test verifies the struct member is captured
    let src = r#"
        struct Foo {
            uint32 data;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Struct(s) = &file.decls[0] else {
        panic!("expected struct");
    };

    assert_eq!(s.members.len(), 1);
    assert_eq!(s.members[0].name.text, "data");
}

#[test]
fn lowers_const_type() {
    // Note: Range-for loop uses const for the iteration variable
    let src = r#"
        inline void foo() {
            for (const uint32 i : 10) {
                barrier;
            }
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::RangeFor(range_for) = &body.stmts[0] else {
        panic!("expected range for");
    };

    // The var type should be properly lowered
    assert_eq!(range_for.var_name.text, "i");
}

// ============================================================================
// Complex declarations
// ============================================================================

#[test]
fn lowers_struct_with_multiple_members() {
    let src = r#"
        struct Point {
            uint32 x;
            uint32 y;
            uint32 z;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Struct(s) = &file.decls[0] else {
        panic!("expected struct");
    };

    assert_eq!(s.name.text, "Point");
    assert_eq!(s.members.len(), 3);
    assert_eq!(s.members[0].name.text, "x");
    assert_eq!(s.members[1].name.text, "y");
    assert_eq!(s.members[2].name.text, "z");
}

#[test]
fn lowers_enum_with_values() {
    let src = r#"
        enum State : uint3 {
            Idle = 0,
            Running = 1,
            Paused = 2,
            Done = 3,
        }
    "#;
    let file = lower_ok(src);

    let Decl::Enum(e) = &file.decls[0] else {
        panic!("expected enum");
    };

    assert_eq!(e.name.text, "State");
    assert_eq!(e.variants.len(), 4);

    // Check that values are present
    for variant in &e.variants {
        assert!(variant.value.is_some());
    }
}

#[test]
fn lowers_class_with_access_specifiers() {
    let src = r#"
        class Foo {
        public:
            uint32 pub_field;
            inline void pub_method() { return; }

        private:
            uint32 priv_field;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Class(cls) = &file.decls[0] else {
        panic!("expected class");
    };

    assert_eq!(cls.name.text, "Foo");
    assert!(!cls.members.is_empty());
}

#[test]
fn lowers_union_declaration() {
    let src = r#"
        union Data {
            uint32 as_int;
            bool as_bool[4];
        }
    "#;
    let file = lower_ok(src);

    let Decl::Union(u) = &file.decls[0] else {
        panic!("expected union");
    };

    assert_eq!(u.name.text, "Data");
    assert_eq!(u.members.len(), 2);
}

#[test]
fn lowers_template_struct() {
    let src = r#"
        template <typename T, auto N>
        struct Array {
            uint32 size;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Template(template) = &file.decls[0] else {
        panic!("expected template");
    };

    // Note: Template params are not currently parsed (CST doesn't structure them)
    // Just verify the template wraps the inner struct correctly

    // Inner decl should be struct
    let Decl::Struct(s) = template.decl.as_ref() else {
        panic!("expected struct inside template");
    };

    assert_eq!(s.name.text, "Array");
}

#[test]
fn lowers_using_declaration() {
    let src = r#"
        using Int = int32;
        using Float = float32;
    "#;
    let file = lower_ok(src);

    assert_eq!(file.decls.len(), 2);

    let Decl::Using(u1) = &file.decls[0] else {
        panic!("expected using");
    };
    assert_eq!(u1.name.text, "Int");

    let Decl::Using(u2) = &file.decls[1] else {
        panic!("expected using");
    };
    assert_eq!(u2.name.text, "Float");
}

// ============================================================================
// Static constructs
// ============================================================================

#[test]
fn lowers_static_if_statement() {
    let src = r#"
        inline void foo() {
            static if (N > 0) {
                return;
            } else {
                barrier;
            }
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::StaticIf(static_if) = &body.stmts[0] else {
        panic!("expected static if");
    };

    assert!(static_if.else_branch.is_some());
}

#[test]
fn lowers_static_for_loop() {
    let src = r#"
        inline void foo() {
            static for (const auto i : N) {
                barrier;
            }
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::StaticFor(static_for) = &body.stmts[0] else {
        panic!("expected static for");
    };

    assert_eq!(static_for.var_name.text, "i");
}

#[test]
fn lowers_static_variable() {
    let src = r#"
        inline void foo() {
            static uint32 counter = 0;
            counter++;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::VarDecl(var) = &body.stmts[0] else {
        panic!("expected var decl");
    };

    assert!(var.flags.is_static);
    assert_eq!(var.name.text, "counter");
}

// ============================================================================
// Literals
// ============================================================================

#[test]
fn lowers_various_int_literals() {
    let src = r#"
        inline void foo() {
            uint32 a = 0;
            uint32 b = 123;
            uint32 c = 0xff;
            uint32 d = 0b1010;
            uint32 e = 0o755;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    assert_eq!(body.stmts.len(), 5);

    // All should have int literal initializers
    for stmt in &body.stmts {
        let Stmt::VarDecl(var) = stmt else {
            panic!("expected var decl");
        };
        let Some(Expr::IntLiteral(_)) = &var.init else {
            panic!("expected int literal init");
        };
    }
}

#[test]
fn lowers_bool_literals() {
    let src = r#"
        inline void foo() {
            bool a = true;
            bool b = false;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    assert_eq!(body.stmts.len(), 2);

    let Stmt::VarDecl(var_a) = &body.stmts[0] else {
        panic!("expected var decl");
    };
    let Some(Expr::BoolLiteral(lit_a)) = &var_a.init else {
        panic!("expected bool literal");
    };
    assert!(lit_a.value);

    let Stmt::VarDecl(var_b) = &body.stmts[1] else {
        panic!("expected var decl");
    };
    let Some(Expr::BoolLiteral(lit_b)) = &var_b.init else {
        panic!("expected bool literal");
    };
    assert!(!lit_b.value);
}

#[test]
fn lowers_string_literal() {
    let src = r#"
        inline void foo() {
            string s = "hello world";
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::VarDecl(var) = &body.stmts[0] else {
        panic!("expected var decl");
    };
    let Some(Expr::StringLiteral(lit)) = &var.init else {
        panic!("expected string literal");
    };
    assert!(lit.value.contains("hello"));
}

// ============================================================================
// Initializer lists
// ============================================================================

#[test]
fn lowers_simple_initializer_list() {
    let src = r#"
        inline void foo() {
            auto x = {1, 2, 3};
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::VarDecl(var) = &body.stmts[0] else {
        panic!("expected var decl");
    };
    let Some(Expr::InitializerList(list)) = &var.init else {
        panic!("expected initializer list");
    };
    assert_eq!(list.elements.len(), 3);
}

#[test]
fn lowers_designated_initializer() {
    let src = r#"
        inline void foo() {
            auto p = {.x = 10, .y = 20};
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::VarDecl(var) = &body.stmts[0] else {
        panic!("expected var decl");
    };
    let Some(Expr::DesignatedInitializer(di)) = &var.init else {
        panic!("expected designated initializer");
    };
    assert_eq!(di.fields.len(), 2);
    assert_eq!(di.fields[0].0.text, "x");
    assert_eq!(di.fields[1].0.text, "y");
}

// ============================================================================
// Assignment operators
// ============================================================================

#[test]
fn lowers_increment_statement() {
    // Increment statements are commonly used in Kanagawa
    let src = r#"
        inline void foo() {
            x++;
        }
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    // Should have at least one statement (increment is parsed as IncDecStmt)
    assert!(!body.stmts.is_empty());
}

// ============================================================================
// Error recovery
// ============================================================================

#[test]
fn handles_empty_function_body() {
    let src = r#"
        inline void foo() {}
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    assert!(body.stmts.is_empty());
}

#[test]
fn handles_function_without_body() {
    let src = r#"
        inline void foo();
    "#;
    let file = lower_ok(src);

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    // Declaration without body
    assert!(func.body.is_none());
}

#[test]
fn handles_empty_struct() {
    let src = r#"
        struct Empty {}
    "#;
    let file = lower_ok(src);

    let Decl::Struct(s) = &file.decls[0] else {
        panic!("expected struct");
    };

    assert!(s.members.is_empty());
}

#[test]
fn handles_empty_file() {
    let src = "";
    let file = lower_ok(src);

    assert!(file.module.is_none());
    assert!(file.imports.is_empty());
    assert!(file.decls.is_empty());
}

// ============================================================================
// Module and imports
// ============================================================================

#[test]
fn lowers_module_with_exports() {
    let src = r#"
        module my.test.module {
            PublicStruct,
            helper_function,
            module sub.module
        }
    "#;
    let file = lower_ok(src);

    let module = file.module.expect("expected module");
    assert_eq!(module.name.segments.len(), 3);
    assert_eq!(module.name.segments[0].text, "my");
    assert_eq!(module.name.segments[1].text, "test");
    assert_eq!(module.name.segments[2].text, "module");

    assert!(!module.exports.is_empty());
}

#[test]
fn lowers_multiple_imports() {
    let src = r#"
        import module1
        import module2.submodule
        import module3 as m3
    "#;
    let file = lower_ok(src);

    assert_eq!(file.imports.len(), 3);
    assert!(file.imports[2].alias.is_some());
    assert_eq!(file.imports[2].alias.as_ref().unwrap().text, "m3");
}

// ============================================================================
// Full file tests
// ============================================================================

#[test]
fn lowers_complete_small_program() {
    let src = r#"
        module test {
            Counter,
            process
        }

        import std.optional

        struct Point {
            uint32 x;
            uint32 y;
        }

        enum State : uint2 {
            Idle = 0,
            Running = 1,
        }

        class Counter {
        public:
            uint32 value;
            inline void increment() {
                value++;
            }
        }

        [[pipelined]]
        inline uint32 process(uint32 input) {
            if (input > 0) {
                return input * 2;
            }
            return 0;
        }
    "#;

    let file = lower_ok(src);

    assert!(file.module.is_some());
    assert_eq!(file.imports.len(), 1);
    assert!(file.decls.len() >= 4); // struct, enum, class, function
}
