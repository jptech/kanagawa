//! Builtin symbols for HIR.
//!
//! This module provides registration of compiler builtin symbols that are
//! available in all Kanagawa code without explicit imports.

use crate::def::DefKind;
use crate::symbol::SymbolTable;
use crate::ty::{FunctionKind, Ty, TyFuncParam};
use crate::Span;

/// Register all builtin symbols in the symbol table.
///
/// This should be called during HIR lowering initialization to ensure
/// that builtin symbols like `assert`, `static_cast`, primitive types, etc.
/// are available for name resolution.
pub fn register_builtins(symbols: &mut SymbolTable) {
    // Builtin span (no source location)
    let span = Span::default();

    // ========================================================================
    // Primitive types as values (for use in expressions)
    // ========================================================================

    // void - used in type expressions and as function return type
    symbols.define("void", DefKind::Builtin, Ty::Type(Box::new(Ty::Void)), span);

    // bool - boolean type
    symbols.define("bool", DefKind::Builtin, Ty::Type(Box::new(Ty::Bool)), span);

    // float32 - 32-bit floating point
    symbols.define("float32", DefKind::Builtin, Ty::Type(Box::new(Ty::Float)), span);

    // float64 - 64-bit floating point (represented as Float for now)
    symbols.define("float64", DefKind::Builtin, Ty::Type(Box::new(Ty::Float)), span);

    // string - string type
    symbols.define("string", DefKind::Builtin, Ty::Type(Box::new(Ty::String)), span);

    // ========================================================================
    // Cast functions
    // ========================================================================

    // static_cast<T>(value) - static type conversion
    // Type: T(value) -> T
    symbols.define(
        "static_cast",
        DefKind::Builtin,
        make_cast_type(),
        span,
    );

    // reinterpret_cast<T>(value) - bit-level reinterpretation
    symbols.define(
        "reinterpret_cast",
        DefKind::Builtin,
        make_cast_type(),
        span,
    );

    // checked_cast<T>(value) - checked type conversion
    symbols.define(
        "checked_cast",
        DefKind::Builtin,
        make_cast_type(),
        span,
    );

    // ========================================================================
    // Assertion and debugging
    // ========================================================================

    // assert(condition) - runtime assertion
    symbols.define(
        "assert",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Void),
            params: vec![TyFuncParam {
                attrs: Vec::new(),
                ty: Ty::Bool,
                name: Some("condition".to_string()),
            }],
        },
        span,
    );

    // ========================================================================
    // Type introspection
    // ========================================================================

    // decltype(expr) - get the type of an expression
    symbols.define(
        "decltype",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Type(Box::new(Ty::Auto))),
            params: vec![TyFuncParam {
                attrs: Vec::new(),
                ty: Ty::Auto,
                name: Some("expr".to_string()),
            }],
        },
        span,
    );

    // template - keyword used in template contexts
    symbols.define("template", DefKind::Builtin, Ty::Auto, span);

    // ========================================================================
    // Version/compiler info
    // ========================================================================

    // version - compiler version string
    symbols.define("version", DefKind::Builtin, Ty::String, span);

    // __cycles - cycle counter builtin
    symbols.define("__cycles", DefKind::Builtin, Ty::Unsigned(64), span);

    // cycles - cycle counter function
    symbols.define("cycles", DefKind::Builtin, Ty::Unsigned(64), span);

    // ========================================================================
    // Higher-order functions / functional combinators
    // ========================================================================

    // reduce<T, F>(array, init, f) -> T
    symbols.define("reduce", DefKind::Builtin, make_reduce_type(), span);

    // map<T, F>(array, f) -> array
    symbols.define("map", DefKind::Builtin, make_map_type(), span);

    // zip_with<T, F>(a, b, f) -> array
    symbols.define("zip_with", DefKind::Builtin, make_map_type(), span);

    // and(a, b) -> bool - logical and (used as higher-order function)
    symbols.define(
        "and",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Bool),
            params: vec![
                TyFuncParam { attrs: Vec::new(), ty: Ty::Bool, name: Some("a".to_string()) },
                TyFuncParam { attrs: Vec::new(), ty: Ty::Bool, name: Some("b".to_string()) },
            ],
        },
        span,
    );

    // or(a, b) -> bool - logical or
    symbols.define(
        "or",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Bool),
            params: vec![
                TyFuncParam { attrs: Vec::new(), ty: Ty::Bool, name: Some("a".to_string()) },
                TyFuncParam { attrs: Vec::new(), ty: Ty::Bool, name: Some("b".to_string()) },
            ],
        },
        span,
    );

    // add(a, b) -> T - addition function
    symbols.define("add", DefKind::Builtin, make_binary_op_type(), span);

    // ========================================================================
    // Array/bit manipulation
    // ========================================================================

    symbols.define("reverse", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("tail", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("init", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("take", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("drop", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("rotate_array", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("rotate_array_left", DefKind::Builtin, make_unary_array_type(), span);

    // ========================================================================
    // Bit operations
    // ========================================================================

    symbols.define("pop_count", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("highest_one", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("reduction", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("reduction_xor", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("reduction_and", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("reduction_or", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("binary_op", DefKind::Builtin, make_binary_op_type(), span);

    // ========================================================================
    // Optional/Maybe type operations
    // ========================================================================

    symbols.define("make_optional", DefKind::Builtin, make_unary_type(), span);
    symbols.define("just", DefKind::Builtin, make_unary_type(), span);

    // ========================================================================
    // Mask operations
    // ========================================================================

    symbols.define("mask_less_than", DefKind::Builtin, make_binary_op_type(), span);
    symbols.define("mask_greater_than", DefKind::Builtin, make_binary_op_type(), span);
    symbols.define("mask_greater_equal", DefKind::Builtin, make_binary_op_type(), span);

    // ========================================================================
    // Index/range operations
    // ========================================================================

    symbols.define("indices", DefKind::Builtin, make_unary_type(), span);
    symbols.define("map_indices", DefKind::Builtin, make_unary_type(), span);

    // ========================================================================
    // Scan operations
    // ========================================================================

    symbols.define("inclusive_scan", DefKind::Builtin, make_reduce_type(), span);

    // ========================================================================
    // Search/filter operations
    // ========================================================================

    symbols.define("first_valid", DefKind::Builtin, make_unary_type(), span);
    symbols.define("last_valid", DefKind::Builtin, make_unary_type(), span);
    symbols.define("remove_dups", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("unique_by", DefKind::Builtin, make_unary_array_type(), span);
    symbols.define("equal_by", DefKind::Builtin, make_binary_op_type(), span);

    // ========================================================================
    // Utility functions
    // ========================================================================

    symbols.define("sum", DefKind::Builtin, make_unary_int_type(), span);
    symbols.define("div_mod", DefKind::Builtin, make_binary_op_type(), span);
    symbols.define("repeat", DefKind::Builtin, make_unary_type(), span);
    symbols.define("generate", DefKind::Builtin, make_unary_type(), span);
    symbols.define("id", DefKind::Builtin, make_unary_type(), span);
    symbols.define("unzip_with", DefKind::Builtin, make_map_type(), span);
    symbols.define("map_reduce", DefKind::Builtin, make_reduce_type(), span);
    symbols.define("bitonic_comparator", DefKind::Builtin, make_binary_op_type(), span);
    symbols.define("bitonic_merge", DefKind::Builtin, make_unary_array_type(), span);

    // ========================================================================
    // Concurrency/pipeline operations
    // ========================================================================

    symbols.define("pipelined_for", DefKind::Builtin, make_unary_type(), span);
    symbols.define("pipelined_do", DefKind::Builtin, make_unary_type(), span);
    symbols.define("parallel_for", DefKind::Builtin, make_unary_type(), span);
    symbols.define("async_exec", DefKind::Builtin, make_unary_type(), span);
    symbols.define("async_then", DefKind::Builtin, make_unary_type(), span);
    symbols.define("atomically", DefKind::Builtin, make_unary_type(), span);
    symbols.define("launch", DefKind::Builtin, make_unary_type(), span);
    symbols.define("first", DefKind::Builtin, make_unary_type(), span);
    symbols.define("second", DefKind::Builtin, make_unary_type(), span);

    // ========================================================================
    // Memory/register operations
    // ========================================================================

    symbols.define("reg", DefKind::Builtin, make_unary_type(), span);
}

/// Create a generic cast function type: T(value) -> T
fn make_cast_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![TyFuncParam {
            attrs: Vec::new(),
            ty: Ty::Auto,
            name: Some("value".to_string()),
        }],
    }
}

/// Create a generic reduce function type
fn make_reduce_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("array".to_string()) },
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("init".to_string()) },
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("f".to_string()) },
        ],
    }
}

/// Create a generic map function type
fn make_map_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("array".to_string()) },
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("f".to_string()) },
        ],
    }
}

/// Create a generic binary operation type
fn make_binary_op_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("a".to_string()) },
            TyFuncParam { attrs: Vec::new(), ty: Ty::Auto, name: Some("b".to_string()) },
        ],
    }
}

/// Create a unary function type
fn make_unary_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![TyFuncParam {
            attrs: Vec::new(),
            ty: Ty::Auto,
            name: Some("x".to_string()),
        }],
    }
}

/// Create a unary array function type
fn make_unary_array_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![TyFuncParam {
            attrs: Vec::new(),
            ty: Ty::Auto,
            name: Some("array".to_string()),
        }],
    }
}

/// Create a unary integer function type
fn make_unary_int_type() -> Ty {
    Ty::Function {
        kind: FunctionKind::Free,
        attrs: Vec::new(),
        return_ty: Box::new(Ty::Auto),
        params: vec![TyFuncParam {
            attrs: Vec::new(),
            ty: Ty::Auto,
            name: Some("x".to_string()),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_builtins() {
        let mut symbols = SymbolTable::new();
        register_builtins(&mut symbols);

        // Check that builtins are registered
        assert!(symbols.lookup("void").is_some());
        assert!(symbols.lookup("bool").is_some());
        assert!(symbols.lookup("float32").is_some());
        assert!(symbols.lookup("assert").is_some());
        assert!(symbols.lookup("static_cast").is_some());
        assert!(symbols.lookup("reinterpret_cast").is_some());
        assert!(symbols.lookup("checked_cast").is_some());
        assert!(symbols.lookup("decltype").is_some());
        assert!(symbols.lookup("reduce").is_some());
        assert!(symbols.lookup("map").is_some());
    }

    #[test]
    fn test_builtin_types() {
        let mut symbols = SymbolTable::new();
        register_builtins(&mut symbols);

        // Check that type builtins have the right type
        let void_id = symbols.lookup("void").unwrap();
        let void_ty = symbols.ty(void_id).unwrap();
        assert!(matches!(void_ty, Ty::Type(t) if matches!(t.as_ref(), Ty::Void)));

        let bool_id = symbols.lookup("bool").unwrap();
        let bool_ty = symbols.ty(bool_id).unwrap();
        assert!(matches!(bool_ty, Ty::Type(t) if matches!(t.as_ref(), Ty::Bool)));
    }

    #[test]
    fn test_builtin_functions() {
        let mut symbols = SymbolTable::new();
        register_builtins(&mut symbols);

        // Check that function builtins have function types
        let assert_id = symbols.lookup("assert").unwrap();
        let assert_ty = symbols.ty(assert_id).unwrap();
        assert!(assert_ty.is_function());
    }
}
