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
/// NOTE: This creates a new CodeGen instance for each file, which means
/// module re-exports are not preserved across files. For multi-file compilation,
/// use `generate_with_codegen` with a shared CodeGen instance.
pub fn generate(file: &HirFile) -> CodeGenResult<ParseTreeNodePtr> {
    let mut codegen = CodeGen::new();
    codegen.emit_file(file)
}

/// Generate ParseTree from a HIR file using an existing CodeGen instance.
///
/// This preserves module re-exports and import aliases across files,
/// which is necessary for proper symbol resolution in multi-file compilation.
pub fn generate_with_codegen(
    codegen: &mut CodeGen,
    file: &HirFile,
) -> CodeGenResult<ParseTreeNodePtr> {
    codegen.emit_file(file)
}
