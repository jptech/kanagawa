//! Basic tests for CST→AST lowering.

use kanagawa_ast::{lower_file, Decl, Expr, File, Stmt, Type};
use kanagawa_syntax::parse_file;

/// Helper to parse and lower source code.
fn lower(src: &str) -> Result<File, kanagawa_ast::LowerError> {
    let parse = parse_file(src);
    assert!(
        parse.diagnostics.is_empty(),
        "CST parse errors: {:?}",
        parse.diagnostics
    );
    let root = parse.syntax_node();
    lower_file(&root)
}

#[test]
fn lowers_empty_file() {
    let file = lower("").unwrap();
    assert!(file.module.is_none());
    assert!(file.imports.is_empty());
    assert!(file.decls.is_empty());
}

#[test]
fn lowers_module_declaration() {
    let src = r#"
        module foo.bar {
            baz,
            qux
        }
    "#;

    let file = lower(src).unwrap();
    let module = file.module.expect("expected module declaration");

    // Module name should have segments "foo" and "bar"
    assert_eq!(module.name.segments.len(), 2);
    assert_eq!(module.name.segments[0].text, "foo");
    assert_eq!(module.name.segments[1].text, "bar");

    // Should have exports
    assert!(!module.exports.is_empty());
}

#[test]
fn lowers_import_declaration() {
    let src = r#"
        import some.module
        import other.module as alias
    "#;

    let file = lower(src).unwrap();

    assert_eq!(file.imports.len(), 2);

    // First import has no alias
    assert_eq!(file.imports[0].name.segments.len(), 2);
    assert!(file.imports[0].alias.is_none());

    // Second import has alias
    assert!(file.imports[1].alias.is_some());
    assert_eq!(file.imports[1].alias.as_ref().unwrap().text, "alias");
}

#[test]
fn lowers_simple_function_def() {
    let src = r#"
        inline void foo() {
            return;
        }
    "#;

    let file = lower(src).unwrap();

    assert_eq!(file.decls.len(), 1);
    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function declaration");
    };

    assert_eq!(func.name.text, "foo");
    assert!(func.body.is_some());

    // Check return type is void
    match &func.return_type {
        Type::Primitive(p) => {
            assert_eq!(p.kind, kanagawa_ast::PrimitiveKind::Void);
        }
        _ => panic!("expected void return type"),
    }
}

#[test]
fn lowers_function_with_params() {
    let src = r#"
        inline uint32 add(uint32 a, uint32 b) {
            return a + b;
        }
    "#;

    // Debug: print CST structure
    let parse = parse_file(src);
    eprintln!("CST diagnostics: {:?}", parse.diagnostics);
    let root = parse.syntax_node();
    for d in root.descendants() {
        let text = d.text().to_string();
        let truncated: String = text.chars().take(40).collect();
        eprintln!("{:?} @ {:?}: {:?}", d.kind(), d.text_range(), truncated);
    }

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function declaration");
    };

    assert_eq!(func.name.text, "add");
    assert_eq!(func.params.len(), 2);
    assert_eq!(func.params[0].name.text, "a");
    assert_eq!(func.params[1].name.text, "b");

    // Check body has return statement
    let body = func.body.as_ref().expect("expected function body");
    assert!(
        !body.stmts.is_empty(),
        "expected non-empty body, got {:?}",
        body
    );

    let Stmt::Return(ret) = &body.stmts[0] else {
        panic!(
            "expected return statement, got {:?} (of {} stmts)",
            &body.stmts[0],
            body.stmts.len()
        );
    };
    assert!(ret.value.is_some());
}

#[test]
fn lowers_struct_declaration() {
    let src = r#"
        struct Point {
            uint32 x;
            uint32 y;
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Struct(s) = &file.decls[0] else {
        panic!("expected struct declaration");
    };

    assert_eq!(s.name.text, "Point");
    assert_eq!(s.members.len(), 2);
    assert_eq!(s.members[0].name.text, "x");
    assert_eq!(s.members[1].name.text, "y");
}

#[test]
fn lowers_enum_declaration() {
    let src = r#"
        enum State : uint2 {
            Idle = 0,
            Running = 1,
            Done = 2,
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Enum(e) = &file.decls[0] else {
        panic!("expected enum declaration");
    };

    assert_eq!(e.name.text, "State");
    assert_eq!(e.variants.len(), 3);
    assert_eq!(e.variants[0].name.text, "Idle");
    assert_eq!(e.variants[1].name.text, "Running");
    assert_eq!(e.variants[2].name.text, "Done");
}

#[test]
fn lowers_using_declaration() {
    let src = r#"
        using Int = int32;
    "#;

    let file = lower(src).unwrap();

    let Decl::Using(u) = &file.decls[0] else {
        panic!("expected using declaration");
    };

    assert_eq!(u.name.text, "Int");
}

#[test]
fn lowers_if_statement() {
    let src = r#"
        inline void test() {
            if (x) {
                return;
            } else {
                barrier;
            }
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::If(if_stmt) = &body.stmts[0] else {
        panic!("expected if statement");
    };

    assert!(if_stmt.else_branch.is_some());
}

#[test]
fn lowers_do_while_loop() {
    let src = r#"
        inline void test() {
            do {
                x++;
            } while (cond);
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::DoWhile(_) = &body.stmts[0] else {
        panic!("expected do-while loop");
    };
}

#[test]
fn lowers_range_for_loop() {
    let src = r#"
        inline void test() {
            for (const uint32 i : 10) {
                barrier;
            }
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::RangeFor(range_for) = &body.stmts[0] else {
        panic!("expected range-for loop");
    };

    assert_eq!(range_for.var_name.text, "i");
}

#[test]
fn lowers_binary_expressions() {
    let src = r#"
        inline uint32 test() {
            return 1 + 2 * 3;
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Return(ret) = &body.stmts[0] else {
        panic!("expected return");
    };

    let value = ret.value.as_ref().expect("expected return value");

    // The expression should be structured (Binary)
    match value {
        Expr::Binary(bin) => {
            assert_eq!(bin.op, kanagawa_ast::BinaryOp::Add);
        }
        _ => panic!("expected binary expression, got {:?}", value),
    }
}

#[test]
fn lowers_call_expression() {
    let src = r#"
        inline void test() {
            foo(1, 2, 3);
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expression statement");
    };

    let Expr::Call(call) = &expr_stmt.expr else {
        panic!("expected call expression");
    };

    assert_eq!(call.args.len(), 3);
}

#[test]
fn lowers_class_declaration() {
    let src = r#"
        class Counter {
        public:
            uint32 value;
            inline void increment() {
                value++;
            }
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Class(cls) = &file.decls[0] else {
        panic!("expected class declaration");
    };

    assert_eq!(cls.name.text, "Counter");
    assert!(!cls.members.is_empty());
}

#[test]
fn lowers_integer_types() {
    let src = r#"
        inline int32 test() {
            uint8 a;
            int16 b;
            uint64 c;
            return 0;
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    // Return type should be int32
    match &func.return_type {
        Type::Integer(int_ty) => {
            assert!(int_ty.signed);
            match &int_ty.width {
                kanagawa_ast::IntWidth::Fixed(w) => assert_eq!(*w, 32),
                _ => panic!("expected fixed width"),
            }
        }
        _ => panic!("expected integer type"),
    }
}

#[test]
fn lowers_static_assert() {
    let src = r#"
        static_assert(true);
    "#;

    let file = lower(src).unwrap();

    let Decl::StaticAssert(sa) = &file.decls[0] else {
        panic!("expected static assert");
    };

    // Condition should be present
    match &sa.condition {
        Expr::BoolLiteral(b) => assert!(b.value),
        _ => panic!("expected bool literal"),
    }
}

#[test]
fn lowers_real_library_file() {
    // Try lowering a real file from the repository
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../library/data/optional.k");

    if !path.exists() {
        eprintln!("Skipping test: optional.k not found at {:?}", path);
        return;
    }

    let src = std::fs::read_to_string(&path)
        .expect("failed to read optional.k");

    let parse = parse_file(&src);
    if !parse.diagnostics.is_empty() {
        eprintln!("CST diagnostics: {:?}", parse.diagnostics);
    }

    let root = parse.syntax_node();
    let result = lower_file(&root);

    // We don't require all features to lower perfectly, but it should not panic
    match result {
        Ok(file) => {
            // Should have module and declarations
            assert!(file.module.is_some() || !file.decls.is_empty());
        }
        Err(e) => {
            // Some errors are acceptable for now, but we should be able to lower most things
            eprintln!("Lowering error (may be expected): {:?}", e);
        }
    }
}

// ============================================================================
// Built-in expression tests
// ============================================================================

#[test]
fn lowers_mux_expression() {
    let src = r#"
        inline void test() {
            mux(sel, a, b);
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expression statement");
    };

    let Expr::Mux(mux) = &expr_stmt.expr else {
        panic!("expected mux expression, got: {:?}", expr_stmt.expr);
    };

    assert_eq!(mux.args.len(), 2); // Two alternatives (a, b)
}

#[test]
fn lowers_concat_expression() {
    let src = r#"
        inline void test() {
            concat(a, b, c);
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expression statement");
    };

    let Expr::Concat(concat) = &expr_stmt.expr else {
        panic!("expected concat expression, got: {:?}", expr_stmt.expr);
    };

    assert_eq!(concat.args.len(), 3);
}

#[test]
fn lowers_static_expression() {
    let src = r#"
        inline void test() {
            static(42);
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expression statement");
    };

    let Expr::Static(_) = &expr_stmt.expr else {
        panic!("expected static expression, got: {:?}", expr_stmt.expr);
    };
}

#[test]
fn lowers_bitsizeof_expression() {
    let src = r#"
        inline void test() {
            bitsizeof(x);
        }
    "#;

    let file = lower(src).unwrap();

    let Decl::Function(func) = &file.decls[0] else {
        panic!("expected function");
    };

    let body = func.body.as_ref().unwrap();
    let Stmt::Expr(expr_stmt) = &body.stmts[0] else {
        panic!("expected expression statement");
    };

    let Expr::Sizeof(sizeof) = &expr_stmt.expr else {
        panic!("expected sizeof expression, got: {:?}", expr_stmt.expr);
    };

    assert_eq!(sizeof.kind, kanagawa_ast::SizeofKind::Bits);
}
