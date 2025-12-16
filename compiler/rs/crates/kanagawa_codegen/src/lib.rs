//! Code generation from HIR to ParseTree.
//!
//! This crate takes typed HIR and emits ParseTree nodes that can be
//! passed to the C++ backend for compilation.

mod decl;
mod emit;
mod expr;
mod stmt;
mod ty;

pub use emit::{CodeGen, CodeGenError, CodeGenResult};

use kanagawa_hir::HirFile;
use kanagawa_parsetree_sys::ParseTreeNodePtr;

/// Generate ParseTree from a HIR file.
///
/// This is the main entry point for code generation.
pub fn generate(file: &HirFile) -> CodeGenResult<ParseTreeNodePtr> {
    let mut codegen = CodeGen::new();
    codegen.emit_file(file)
}
