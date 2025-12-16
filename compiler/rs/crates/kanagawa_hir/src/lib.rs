//! High-level Intermediate Representation (HIR) for Kanagawa.
//!
//! HIR is the first semantic representation where:
//! - Names are resolved to definitions
//! - Types carry full semantic information
//! - Module namespaces are explicitly encoded
//!
//! HIR is produced by lowering the AST and performing name resolution.

mod builtin;
pub mod consteval;
mod def;
mod hir;
mod lower;
mod namespace;
mod resolve;
mod symbol;
pub mod template;
pub mod typeck;
mod ty;

pub use consteval::{ConstEvaluator, ConstEvalError, ConstValue};
pub use def::{DefId, DefKind, Definition, Visibility};
pub use hir::*;
pub use lower::{lower_file, LowerError};
pub use namespace::{encode_module_namespace, decode_module_namespace, display_module_namespace};
pub use resolve::{resolve, ResolveError};
pub use symbol::{Scope, ScopeId, ScopeKind, SymbolTable};
pub use template::{TemplateArgs, TemplateDeducer, TemplateError, TemplateInstantiator, TemplateSubstitution};
pub use typeck::{TypeChecker, TypeError, InferenceResult, TypeVarId};
pub use ty::*;

/// Re-export Span from kanagawa_ast for convenience.
pub use kanagawa_ast::Span;
