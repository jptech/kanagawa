//! Type inference and checking for the Kanagawa compiler.
//!
//! This crate provides comprehensive type analysis for Kanagawa HIR:
//!
//! - **Type inference**: Resolves `auto` declarations and integer literal types
//! - **Type checking**: Validates type compatibility in expressions and declarations
//! - **Diagnostics**: Detailed error messages with source locations
//!
//! # Architecture
//!
//! The type system is organized into several modules:
//!
//! - [`diagnostic`]: Error types and reporting infrastructure
//! - [`rules`]: Type system rules (operators, conversions, compatibility)
//! - [`infer`]: Type inference engine with unification
//! - [`check`]: Main type checking pass over HIR
//!
//! # Usage
//!
//! ```ignore
//! use kanagawa_typeck::check_types;
//! use kanagawa_hir::{HirFile, SymbolTable};
//!
//! let result = check_types(&hir_file, &symbol_table);
//! if result.has_errors() {
//!     for diag in &result.diagnostics {
//!         eprintln!("{}", diag);
//!     }
//! }
//! ```
//!
//! # Type System Overview
//!
//! Kanagawa has an explicit-width type system optimized for hardware:
//!
//! ## Integer Types
//! - `uint<N>`: N-bit unsigned integer (e.g., `uint32`, `uint7`)
//! - `int<N>`: N-bit signed integer (e.g., `int16`, `int1`)
//! - Width is always tracked and propagated through operations
//!
//! ## Type Inference Rules
//! - Addition: `uint<a> + uint<b>` → `uint<max(a,b)+1>` (prevents overflow)
//! - Subtraction: `uint<a> - uint<b>` → `int<max(a,b)+1>` (can be negative)
//! - Multiplication: `uint<a> * uint<b>` → `uint<a+b>` (full precision)
//!
//! ## Conversions
//! - Implicit widening is allowed (smaller to larger)
//! - Narrowing requires explicit `cast<T>(expr)`
//! - Signed/unsigned conversion requires explicit cast

pub mod check;
pub mod diagnostic;
pub mod infer;
pub mod rules;

// Re-export main API
pub use check::{check_types, TypeCheckResult, TypeChecker};
pub use diagnostic::{Diagnostic, DiagnosticCode, Diagnostics, Severity};
pub use infer::{InferContext, InferTy, TypeVar};
pub use rules::{
    binary_arithmetic_result_type, can_represent, check_assignment_compatibility,
    common_type, infer_integer_literal_type, is_valid_cast, types_equal, BinaryOp,
    Compatibility, UnaryOp,
};
