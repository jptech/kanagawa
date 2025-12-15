//! Integration tests for kanagawa_typeck.
//!
//! These tests verify the type checking system works correctly
//! with various HIR constructs and type scenarios.

use kanagawa_hir::*;
use kanagawa_typeck::*;

/// Helper to create a minimal HIR file with the given items.
fn make_hir_file(items: Vec<HirItem>) -> HirFile {
    HirFile {
        span: Span::default(),
        module: None,
        imports: Vec::new(),
        items,
    }
}

/// Helper to create an empty symbol table.
fn empty_symbols() -> SymbolTable {
    SymbolTable::new()
}

/// Helper to create a simple integer literal expression.
fn int_lit(value: i128) -> HirExpr {
    HirExpr {
        span: Span::default(),
        ty: Ty::Unresolved,
        kind: HirExprKind::IntLiteral { value, suffix: None },
    }
}

/// Helper to create a typed integer literal expression.
fn typed_int_lit(value: i128, ty: Ty) -> HirExpr {
    HirExpr {
        span: Span::default(),
        ty,
        kind: HirExprKind::IntLiteral { value, suffix: None },
    }
}

/// Helper to create a boolean literal expression.
fn bool_lit(value: bool) -> HirExpr {
    HirExpr {
        span: Span::default(),
        ty: Ty::Bool,
        kind: HirExprKind::BoolLiteral(value),
    }
}

/// Helper to create a binary expression.
fn binary(op: HirBinaryOp, lhs: HirExpr, rhs: HirExpr) -> HirExpr {
    HirExpr {
        span: Span::default(),
        ty: Ty::Unresolved,
        kind: HirExprKind::Binary {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        },
    }
}

/// Helper to create a unary expression.
fn unary(op: HirUnaryOp, operand: HirExpr) -> HirExpr {
    HirExpr {
        span: Span::default(),
        ty: Ty::Unresolved,
        kind: HirExprKind::Unary {
            op,
            operand: Box::new(operand),
        },
    }
}

// ============================================================================
// Type Rules Tests
// ============================================================================

mod rules_tests {
    use super::*;

    #[test]
    fn test_types_equal_primitives() {
        assert!(types_equal(&Ty::Void, &Ty::Void));
        assert!(types_equal(&Ty::Bool, &Ty::Bool));
        assert!(types_equal(&Ty::Float, &Ty::Float));
        assert!(types_equal(&Ty::String, &Ty::String));

        assert!(!types_equal(&Ty::Void, &Ty::Bool));
        assert!(!types_equal(&Ty::Bool, &Ty::Float));
    }

    #[test]
    fn test_types_equal_integers() {
        assert!(types_equal(&Ty::Unsigned(8), &Ty::Unsigned(8)));
        assert!(types_equal(&Ty::Signed(16), &Ty::Signed(16)));

        assert!(!types_equal(&Ty::Unsigned(8), &Ty::Unsigned(16)));
        assert!(!types_equal(&Ty::Signed(8), &Ty::Unsigned(8)));
    }

    #[test]
    fn test_types_equal_arrays() {
        let arr1 = Ty::Array {
            attrs: Vec::new(),
            element: Box::new(Ty::Unsigned(8)),
            dims: vec![10],
        };
        let arr2 = Ty::Array {
            attrs: Vec::new(),
            element: Box::new(Ty::Unsigned(8)),
            dims: vec![10],
        };
        let arr3 = Ty::Array {
            attrs: Vec::new(),
            element: Box::new(Ty::Unsigned(16)),
            dims: vec![10],
        };

        assert!(types_equal(&arr1, &arr2));
        assert!(!types_equal(&arr1, &arr3));
    }

    #[test]
    fn test_assignment_compatibility_identical() {
        let result = check_assignment_compatibility(
            &Ty::Unsigned(32),
            &Ty::Unsigned(32),
        );
        assert_eq!(result, Compatibility::Identical);
    }

    #[test]
    fn test_assignment_compatibility_widening() {
        // u16 -> u32 is widening
        let result = check_assignment_compatibility(
            &Ty::Unsigned(32),
            &Ty::Unsigned(16),
        );
        assert_eq!(result, Compatibility::ImplicitWidening);

        // i8 -> i32 is widening
        let result = check_assignment_compatibility(
            &Ty::Signed(32),
            &Ty::Signed(8),
        );
        assert_eq!(result, Compatibility::ImplicitWidening);
    }

    #[test]
    fn test_assignment_compatibility_narrowing() {
        // u32 -> u16 requires cast
        let result = check_assignment_compatibility(
            &Ty::Unsigned(16),
            &Ty::Unsigned(32),
        );
        assert_eq!(result, Compatibility::ExplicitCastRequired);
    }

    #[test]
    fn test_assignment_compatibility_signed_unsigned() {
        // signed -> unsigned requires cast
        let result = check_assignment_compatibility(
            &Ty::Unsigned(32),
            &Ty::Signed(32),
        );
        assert_eq!(result, Compatibility::ExplicitCastRequired);

        // unsigned -> signed with room for sign is widening
        let result = check_assignment_compatibility(
            &Ty::Signed(32),
            &Ty::Unsigned(16),
        );
        assert_eq!(result, Compatibility::ImplicitWidening);
    }

    #[test]
    fn test_assignment_compatibility_bool_to_int() {
        // bool -> u8 is widening
        let result = check_assignment_compatibility(
            &Ty::Unsigned(8),
            &Ty::Bool,
        );
        assert_eq!(result, Compatibility::ImplicitWidening);
    }

    #[test]
    fn test_assignment_incompatible() {
        // struct -> int is incompatible
        let struct_ty = Ty::Struct {
            name: vec!["Foo".to_string()],
            fields: Vec::new(),
        };
        let result = check_assignment_compatibility(
            &Ty::Unsigned(32),
            &struct_ty,
        );
        assert_eq!(result, Compatibility::Incompatible);
    }

    #[test]
    fn test_binary_add_types() {
        // u8 + u8 = u9
        let result = binary_arithmetic_result_type(
            BinaryOp::Add,
            &Ty::Unsigned(8),
            &Ty::Unsigned(8),
        );
        assert_eq!(result, Some(Ty::Unsigned(9)));

        // u8 + u16 = u17
        let result = binary_arithmetic_result_type(
            BinaryOp::Add,
            &Ty::Unsigned(8),
            &Ty::Unsigned(16),
        );
        assert_eq!(result, Some(Ty::Unsigned(17)));

        // i8 + u8 = i9 (mixed -> signed)
        let result = binary_arithmetic_result_type(
            BinaryOp::Add,
            &Ty::Signed(8),
            &Ty::Unsigned(8),
        );
        assert_eq!(result, Some(Ty::Signed(9)));
    }

    #[test]
    fn test_binary_sub_types() {
        // u8 - u8 = i10 (subtraction can be negative)
        let result = binary_arithmetic_result_type(
            BinaryOp::Sub,
            &Ty::Unsigned(8),
            &Ty::Unsigned(8),
        );
        assert_eq!(result, Some(Ty::Signed(10)));
    }

    #[test]
    fn test_binary_mul_types() {
        // u8 * u8 = u16
        let result = binary_arithmetic_result_type(
            BinaryOp::Mul,
            &Ty::Unsigned(8),
            &Ty::Unsigned(8),
        );
        assert_eq!(result, Some(Ty::Unsigned(16)));

        // u8 * u16 = u24
        let result = binary_arithmetic_result_type(
            BinaryOp::Mul,
            &Ty::Unsigned(8),
            &Ty::Unsigned(16),
        );
        assert_eq!(result, Some(Ty::Unsigned(24)));
    }

    #[test]
    fn test_binary_comparison_types() {
        // Comparisons return bool
        let result = binary_arithmetic_result_type(
            BinaryOp::Eq,
            &Ty::Unsigned(32),
            &Ty::Unsigned(32),
        );
        assert_eq!(result, Some(Ty::Bool));

        let result = binary_arithmetic_result_type(
            BinaryOp::Lt,
            &Ty::Signed(16),
            &Ty::Signed(16),
        );
        assert_eq!(result, Some(Ty::Bool));
    }

    #[test]
    fn test_binary_logical_types() {
        // Logical ops return bool
        let result = binary_arithmetic_result_type(
            BinaryOp::LogAnd,
            &Ty::Bool,
            &Ty::Bool,
        );
        assert_eq!(result, Some(Ty::Bool));
    }

    #[test]
    fn test_binary_bitwise_types() {
        // Bitwise ops: max width
        let result = binary_arithmetic_result_type(
            BinaryOp::BitAnd,
            &Ty::Unsigned(8),
            &Ty::Unsigned(16),
        );
        assert_eq!(result, Some(Ty::Unsigned(16)));
    }
}

// ============================================================================
// Integer Literal Inference Tests
// ============================================================================

mod literal_inference_tests {
    use super::*;

    #[test]
    fn test_small_unsigned_literals() {
        assert_eq!(infer_integer_literal_type(0), Ty::Unsigned(1));
        assert_eq!(infer_integer_literal_type(1), Ty::Unsigned(1));
        assert_eq!(infer_integer_literal_type(2), Ty::Unsigned(2));
        assert_eq!(infer_integer_literal_type(3), Ty::Unsigned(2));
        assert_eq!(infer_integer_literal_type(255), Ty::Unsigned(8));
        assert_eq!(infer_integer_literal_type(256), Ty::Unsigned(9));
    }

    #[test]
    fn test_large_unsigned_literals() {
        assert_eq!(infer_integer_literal_type(65535), Ty::Unsigned(16));
        assert_eq!(infer_integer_literal_type(65536), Ty::Unsigned(17));
        assert_eq!(infer_integer_literal_type(0xFFFFFFFF_u64 as i128), Ty::Unsigned(32));
    }

    #[test]
    fn test_negative_literals() {
        assert_eq!(infer_integer_literal_type(-1), Ty::Signed(2));
        assert_eq!(infer_integer_literal_type(-2), Ty::Signed(2));
        assert_eq!(infer_integer_literal_type(-3), Ty::Signed(3));
        assert_eq!(infer_integer_literal_type(-4), Ty::Signed(3));
        assert_eq!(infer_integer_literal_type(-127), Ty::Signed(8));
        assert_eq!(infer_integer_literal_type(-128), Ty::Signed(8));
        assert_eq!(infer_integer_literal_type(-129), Ty::Signed(9));
    }

    #[test]
    fn test_can_represent_unsigned() {
        assert!(can_represent(&Ty::Unsigned(8), 0));
        assert!(can_represent(&Ty::Unsigned(8), 255));
        assert!(!can_represent(&Ty::Unsigned(8), 256));
        assert!(!can_represent(&Ty::Unsigned(8), -1));
    }

    #[test]
    fn test_can_represent_signed() {
        assert!(can_represent(&Ty::Signed(8), 0));
        assert!(can_represent(&Ty::Signed(8), 127));
        assert!(can_represent(&Ty::Signed(8), -128));
        assert!(!can_represent(&Ty::Signed(8), 128));
        assert!(!can_represent(&Ty::Signed(8), -129));
    }

    #[test]
    fn test_can_represent_bool() {
        assert!(can_represent(&Ty::Bool, 0));
        assert!(can_represent(&Ty::Bool, 1));
        assert!(!can_represent(&Ty::Bool, 2));
        assert!(!can_represent(&Ty::Bool, -1));
    }
}

// ============================================================================
// Type Inference Context Tests
// ============================================================================

mod infer_context_tests {
    use super::*;

    #[test]
    fn test_fresh_vars_unique() {
        let mut ctx = InferContext::new();
        let v1 = ctx.fresh_var();
        let v2 = ctx.fresh_var();
        let v3 = ctx.fresh_var();

        assert_ne!(v1, v2);
        assert_ne!(v2, v3);
        assert_ne!(v1, v3);
    }

    #[test]
    fn test_constraint_equal_concrete() {
        let mut ctx = InferContext::new();
        ctx.constrain_equal(
            InferTy::Concrete(Ty::Unsigned(32)),
            InferTy::Concrete(Ty::Unsigned(32)),
            Span::default(),
        );
        assert!(ctx.solve());
        assert!(!ctx.has_errors());
    }

    #[test]
    fn test_constraint_equal_mismatch() {
        let mut ctx = InferContext::new();
        ctx.constrain_equal(
            InferTy::Concrete(Ty::Unsigned(32)),
            InferTy::Concrete(Ty::Signed(32)),
            Span::default(),
        );
        assert!(!ctx.solve());
        assert!(ctx.has_errors());
    }

    #[test]
    fn test_constraint_variable_binding() {
        let mut ctx = InferContext::new();
        let var = ctx.fresh_var();
        ctx.constrain_equal(
            InferTy::Var(var),
            InferTy::Concrete(Ty::Unsigned(16)),
            Span::default(),
        );
        assert!(ctx.solve());

        let resolved = ctx.finalize(&InferTy::Var(var));
        assert_eq!(resolved, Ty::Unsigned(16));
    }

    #[test]
    fn test_constraint_transitive() {
        let mut ctx = InferContext::new();
        let v1 = ctx.fresh_var();
        let v2 = ctx.fresh_var();

        // v1 = v2, v2 = u8 => v1 = u8
        ctx.constrain_equal(InferTy::Var(v1), InferTy::Var(v2), Span::default());
        ctx.constrain_equal(
            InferTy::Var(v2),
            InferTy::Concrete(Ty::Unsigned(8)),
            Span::default(),
        );

        assert!(ctx.solve());

        let resolved1 = ctx.finalize(&InferTy::Var(v1));
        let resolved2 = ctx.finalize(&InferTy::Var(v2));
        assert_eq!(resolved1, Ty::Unsigned(8));
        assert_eq!(resolved2, Ty::Unsigned(8));
    }

    #[test]
    fn test_assignable_widening() {
        let mut ctx = InferContext::new();
        ctx.constrain_assignable(
            InferTy::Concrete(Ty::Unsigned(8)),
            InferTy::Concrete(Ty::Unsigned(16)),
            Span::default(),
        );
        assert!(ctx.solve());
        assert!(!ctx.has_errors());
    }

    #[test]
    fn test_assignable_narrowing_error() {
        let mut ctx = InferContext::new();
        ctx.constrain_assignable(
            InferTy::Concrete(Ty::Unsigned(32)),
            InferTy::Concrete(Ty::Unsigned(16)),
            Span::default(),
        );
        assert!(!ctx.solve());
        assert!(ctx.has_errors());
    }

    #[test]
    fn test_int_var_binds_to_unsigned() {
        let mut ctx = InferContext::new();
        let int_var = ctx.fresh_int_var(Some(false)); // unsigned
        ctx.constrain_equal(
            int_var.clone(),
            InferTy::Concrete(Ty::Unsigned(32)),
            Span::default(),
        );
        assert!(ctx.solve());

        let resolved = ctx.finalize(&int_var);
        assert_eq!(resolved, Ty::Unsigned(32));
    }

    #[test]
    fn test_int_var_signedness_conflict() {
        let mut ctx = InferContext::new();
        let int_var = ctx.fresh_int_var(Some(true)); // signed
        ctx.constrain_equal(
            int_var.clone(),
            InferTy::Concrete(Ty::Unsigned(32)),
            Span::default(),
        );
        assert!(!ctx.solve());
        assert!(ctx.has_errors());
    }
}

// ============================================================================
// Type Checker Integration Tests
// ============================================================================

mod type_checker_tests {
    use super::*;

    fn make_simple_function(return_ty: Ty, body: HirBlock) -> HirItem {
        HirItem::Function(HirFunction {
            span: Span::default(),
            def_id: DefId(0),
            ty: Ty::Function {
                kind: FunctionKind::Free,
                attrs: Vec::new(),
                return_ty: Box::new(return_ty.clone()),
                params: Vec::new(),
            },
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            modifier: None,
            return_ty,
            name: "test".to_string(),
            params: Vec::new(),
            body: Some(body),
        })
    }

    fn make_return_stmt(value: Option<HirExpr>) -> HirStmt {
        HirStmt::Return(HirReturn {
            span: Span::default(),
            value,
        })
    }

    fn make_if_stmt(condition: HirExpr, then_branch: HirStmt) -> HirStmt {
        HirStmt::If(HirIf {
            span: Span::default(),
            condition,
            then_branch: Box::new(then_branch),
            else_branch: None,
        })
    }

    fn make_block(stmts: Vec<HirStmt>) -> HirBlock {
        HirBlock {
            span: Span::default(),
            stmts,
        }
    }

    #[test]
    fn test_void_function_no_return() {
        let func = make_simple_function(
            Ty::Void,
            make_block(vec![make_return_stmt(None)]),
        );
        let hir = make_hir_file(vec![func]);
        let result = check_types(&hir, &empty_symbols());

        assert!(result.success, "Void function with no return value should succeed");
    }

    #[test]
    fn test_void_function_unexpected_return() {
        let func = make_simple_function(
            Ty::Void,
            make_block(vec![make_return_stmt(Some(int_lit(42)))]),
        );
        let hir = make_hir_file(vec![func]);
        let result = check_types(&hir, &empty_symbols());

        assert!(!result.success, "Void function with return value should fail");
    }

    #[test]
    fn test_int_function_with_return() {
        let func = make_simple_function(
            Ty::Unsigned(32),
            make_block(vec![make_return_stmt(Some(typed_int_lit(42, Ty::Unsigned(32))))]),
        );
        let hir = make_hir_file(vec![func]);
        let result = check_types(&hir, &empty_symbols());

        assert!(result.success, "Int function with matching return should succeed");
    }

    #[test]
    fn test_int_function_missing_return() {
        let func = make_simple_function(
            Ty::Unsigned(32),
            make_block(vec![make_return_stmt(None)]),
        );
        let hir = make_hir_file(vec![func]);
        let result = check_types(&hir, &empty_symbols());

        assert!(!result.success, "Int function with missing return should fail");
    }

    #[test]
    fn test_if_with_bool_condition() {
        let func = make_simple_function(
            Ty::Void,
            make_block(vec![
                make_if_stmt(
                    bool_lit(true),
                    HirStmt::Block(make_block(vec![])),
                ),
            ]),
        );
        let hir = make_hir_file(vec![func]);
        let result = check_types(&hir, &empty_symbols());

        assert!(result.success, "If with bool condition should succeed");
    }

    #[test]
    fn test_if_with_int_condition() {
        let func = make_simple_function(
            Ty::Void,
            make_block(vec![
                make_if_stmt(
                    typed_int_lit(1, Ty::Unsigned(32)),
                    HirStmt::Block(make_block(vec![])),
                ),
            ]),
        );
        let hir = make_hir_file(vec![func]);
        let result = check_types(&hir, &empty_symbols());

        assert!(!result.success, "If with int condition should fail");
    }

    #[test]
    fn test_struct_field_validation() {
        let struct_item = HirItem::Struct(HirStruct {
            span: Span::default(),
            def_id: DefId(0),
            ty: Ty::Struct {
                name: vec!["TestStruct".to_string()],
                fields: vec![("x".to_string(), Ty::Unsigned(32))],
            },
            name: "TestStruct".to_string(),
            members: vec![HirStructMember {
                span: Span::default(),
                def_id: DefId(1),
                ty: Ty::Unsigned(32),
                name: "x".to_string(),
                init: None,
            }],
        });

        let hir = make_hir_file(vec![struct_item]);
        let result = check_types(&hir, &empty_symbols());

        assert!(result.success, "Valid struct should pass type checking");
    }

    #[test]
    fn test_struct_with_init() {
        let struct_item = HirItem::Struct(HirStruct {
            span: Span::default(),
            def_id: DefId(0),
            ty: Ty::Struct {
                name: vec!["TestStruct".to_string()],
                fields: vec![("x".to_string(), Ty::Unsigned(32))],
            },
            name: "TestStruct".to_string(),
            members: vec![HirStructMember {
                span: Span::default(),
                def_id: DefId(1),
                ty: Ty::Unsigned(32),
                name: "x".to_string(),
                init: Some(typed_int_lit(0, Ty::Unsigned(32))),
            }],
        });

        let hir = make_hir_file(vec![struct_item]);
        let result = check_types(&hir, &empty_symbols());

        assert!(result.success, "Struct with matching init should pass");
    }

    #[test]
    fn test_enum_variant_values() {
        let enum_item = HirItem::Enum(HirEnum {
            span: Span::default(),
            def_id: DefId(0),
            ty: Ty::Enum {
                name: vec!["TestEnum".to_string()],
                base: Box::new(Ty::Unsigned(8)),
            },
            name: "TestEnum".to_string(),
            base_ty: Ty::Unsigned(8),
            variants: vec![
                HirEnumVariant {
                    span: Span::default(),
                    def_id: DefId(1),
                    name: "A".to_string(),
                    value: Some(typed_int_lit(0, Ty::Unsigned(8))),
                },
                HirEnumVariant {
                    span: Span::default(),
                    def_id: DefId(2),
                    name: "B".to_string(),
                    value: Some(typed_int_lit(1, Ty::Unsigned(8))),
                },
            ],
        });

        let hir = make_hir_file(vec![enum_item]);
        let result = check_types(&hir, &empty_symbols());

        assert!(result.success, "Enum with valid variant values should pass");
    }
}

// ============================================================================
// Diagnostic Tests
// ============================================================================

mod diagnostic_tests {
    use super::*;

    #[test]
    fn test_diagnostic_severity() {
        let error = Diagnostic::error(
            DiagnosticCode::TypeMismatch,
            "test error",
            Span::default(),
        );
        assert!(error.is_error());

        let warning = Diagnostic::warning(
            DiagnosticCode::TypeMismatch,
            "test warning",
            Span::default(),
        );
        assert!(!warning.is_error());
    }

    #[test]
    fn test_diagnostics_collection() {
        let mut diags = Diagnostics::new();
        assert!(diags.is_empty());
        assert!(!diags.has_errors());

        diags.error(DiagnosticCode::TypeMismatch, "error 1", Span::default());
        diags.warning(DiagnosticCode::TypeMismatch, "warning 1", Span::default());

        assert!(!diags.is_empty());
        assert!(diags.has_errors());
        assert_eq!(diags.error_count(), 1);
        assert_eq!(diags.len(), 2);
    }

    #[test]
    fn test_diagnostic_with_label() {
        let diag = Diagnostic::error(
            DiagnosticCode::TypeMismatch,
            "main error",
            Span::default(),
        )
        .with_label(Span::default(), "related context");

        assert_eq!(diag.labels.len(), 1);
    }

    #[test]
    fn test_diagnostic_with_note() {
        let diag = Diagnostic::error(
            DiagnosticCode::TypeMismatch,
            "main error",
            Span::default(),
        )
        .with_note("helpful suggestion");

        assert_eq!(diag.notes.len(), 1);
    }

    #[test]
    fn test_diagnostic_code_display() {
        assert_eq!(format!("{}", DiagnosticCode::TypeMismatch), "E001");
        assert_eq!(format!("{}", DiagnosticCode::CannotInfer), "E100");
        assert_eq!(format!("{}", DiagnosticCode::IntegerWidthMismatch), "E200");
    }
}

// ============================================================================
// Common Type Tests
// ============================================================================

mod common_type_tests {
    use super::*;

    #[test]
    fn test_common_type_same() {
        let result = common_type(&Ty::Unsigned(32), &Ty::Unsigned(32));
        assert_eq!(result, Some(Ty::Unsigned(32)));
    }

    #[test]
    fn test_common_type_widening() {
        let result = common_type(&Ty::Unsigned(8), &Ty::Unsigned(32));
        assert_eq!(result, Some(Ty::Unsigned(32)));
    }

    #[test]
    fn test_common_type_signed_unsigned() {
        // Mixed signed/unsigned promotes to signed
        let result = common_type(&Ty::Unsigned(16), &Ty::Signed(16));
        assert_eq!(result, Some(Ty::Signed(16)));
    }

    #[test]
    fn test_common_type_bool_int() {
        // Bool (1-bit) + int promotes to int
        let result = common_type(&Ty::Bool, &Ty::Unsigned(8));
        assert_eq!(result, Some(Ty::Unsigned(8)));
    }
}

// ============================================================================
// Cast Validation Tests
// ============================================================================

mod cast_tests {
    use super::*;

    #[test]
    fn test_int_to_int_cast() {
        assert!(is_valid_cast(&Ty::Unsigned(32), &Ty::Unsigned(16)));
        assert!(is_valid_cast(&Ty::Unsigned(16), &Ty::Unsigned(32)));
        assert!(is_valid_cast(&Ty::Unsigned(32), &Ty::Signed(32)));
        assert!(is_valid_cast(&Ty::Signed(32), &Ty::Unsigned(32)));
    }

    #[test]
    fn test_float_int_cast() {
        assert!(is_valid_cast(&Ty::Float, &Ty::Unsigned(32)));
        assert!(is_valid_cast(&Ty::Float, &Ty::Signed(32)));
        assert!(is_valid_cast(&Ty::Unsigned(32), &Ty::Float));
        assert!(is_valid_cast(&Ty::Signed(32), &Ty::Float));
    }

    #[test]
    fn test_bool_int_cast() {
        assert!(is_valid_cast(&Ty::Bool, &Ty::Unsigned(8)));
        assert!(is_valid_cast(&Ty::Unsigned(32), &Ty::Bool));
    }

    #[test]
    fn test_invalid_cast() {
        let struct_ty = Ty::Struct {
            name: vec!["Foo".to_string()],
            fields: Vec::new(),
        };

        assert!(!is_valid_cast(&struct_ty, &Ty::Unsigned(32)));
        assert!(!is_valid_cast(&Ty::Unsigned(32), &struct_ty));
        assert!(!is_valid_cast(&Ty::String, &Ty::Unsigned(32)));
    }
}
