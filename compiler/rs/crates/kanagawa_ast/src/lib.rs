//! Typed AST for the Kanagawa language.
//!
//! This crate provides a typed AST representation that is lowered from the CST
//! (concrete syntax tree) produced by `kanagawa_syntax`. The AST is designed to
//! be suitable for further semantic analysis and eventual emission to the
//! ParseTree C ABI for the C++ backend.
//!
//! # Architecture
//!
//! The AST is organized into separate node types for clarity:
//! - [`File`]: Top-level file structure (module, imports, declarations)
//! - [`Decl`]: Declarations (functions, structs, classes, etc.)
//! - [`Stmt`]: Statements (return, if, loops, blocks, etc.)
//! - [`Expr`]: Expressions (literals, identifiers, operators, calls)
//! - [`Type`]: Type expressions (primitives, named, arrays, function types)
//!
//! Each node carries a [`Span`] for source location tracking.

mod lower;
mod span;
mod types;

pub use lower::{lower_file, LowerError};
pub use span::Span;
pub use types::*;

/// Result type for AST lowering operations.
pub type LowerResult<T> = Result<T, LowerError>;
