//! Builtin symbols for HIR.
//!
//! This module provides registration of compiler builtin symbols that are
//! available in all Kanagawa code without explicit imports.
//!
//! IMPORTANT: Only true compiler intrinsics should be registered here.
//! Library functions (like `cycles`, `reduce`, `map`, etc.) are defined
//! in the standard library and should NOT be registered as builtins.
//!
//! The Haskell frontend only defines these intrinsics:
//! - `__print` - debug print function
//! - `assert` - runtime assertion
//! - `__cycles` - cycle counter intrinsic
//! - `__str_cnt` - string count intrinsic
//! - `__assert_str_eq` - string equality assertion

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
    // These are truly built into the language, not library-defined.
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
    // Cast functions - language-level casts
    // ========================================================================

    // static_cast<T>(value) - static type conversion
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
    // True compiler intrinsics (from Haskell frontend)
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

    // __print(message) - debug print function
    symbols.define(
        "__print",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Void),
            params: vec![TyFuncParam {
                attrs: Vec::new(),
                ty: Ty::String,
                name: Some("message".to_string()),
            }],
        },
        span,
    );

    // __cycles() - cycle counter intrinsic
    symbols.define(
        "__cycles",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Unsigned(64)),
            params: vec![],
        },
        span,
    );

    // __str_cnt() - string count intrinsic
    symbols.define(
        "__str_cnt",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Unsigned(64)),
            params: vec![],
        },
        span,
    );

    // __assert_str_eq(a, b) - string equality assertion
    symbols.define(
        "__assert_str_eq",
        DefKind::Builtin,
        Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Void),
            params: vec![
                TyFuncParam {
                    attrs: Vec::new(),
                    ty: Ty::String,
                    name: Some("a".to_string()),
                },
                TyFuncParam {
                    attrs: Vec::new(),
                    ty: Ty::String,
                    name: Some("b".to_string()),
                },
            ],
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_builtins() {
        let mut symbols = SymbolTable::new();
        register_builtins(&mut symbols);

        // Check that true builtins are registered
        assert!(symbols.lookup("void").is_some());
        assert!(symbols.lookup("bool").is_some());
        assert!(symbols.lookup("float32").is_some());
        assert!(symbols.lookup("assert").is_some());
        assert!(symbols.lookup("static_cast").is_some());
        assert!(symbols.lookup("reinterpret_cast").is_some());
        assert!(symbols.lookup("checked_cast").is_some());
        assert!(symbols.lookup("decltype").is_some());
        assert!(symbols.lookup("__print").is_some());
        assert!(symbols.lookup("__cycles").is_some());
        assert!(symbols.lookup("__str_cnt").is_some());
        assert!(symbols.lookup("__assert_str_eq").is_some());
    }

    #[test]
    fn test_stdlib_not_builtin() {
        let mut symbols = SymbolTable::new();
        register_builtins(&mut symbols);

        // Verify that stdlib functions are NOT registered as builtins
        // These should come from the library, not be built-in
        assert!(symbols.lookup("cycles").is_none(), "cycles should come from stdlib, not builtins");
        assert!(symbols.lookup("reduce").is_none(), "reduce should come from stdlib, not builtins");
        assert!(symbols.lookup("map").is_none(), "map should come from stdlib, not builtins");
        assert!(symbols.lookup("reverse").is_none(), "reverse should come from stdlib, not builtins");
        assert!(symbols.lookup("pop_count").is_none(), "pop_count should come from stdlib, not builtins");
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

        let cycles_id = symbols.lookup("__cycles").unwrap();
        let cycles_ty = symbols.ty(cycles_id).unwrap();
        assert!(cycles_ty.is_function());
    }
}
