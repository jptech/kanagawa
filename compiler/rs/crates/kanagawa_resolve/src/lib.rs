//! Multi-file module resolution for the Kanagawa compiler.
//!
//! This crate provides comprehensive module resolution including:
//!
//! - **Module graph construction**: Build dependency graph from import declarations
//! - **Cross-module resolution**: Resolve symbols across module boundaries
//! - **Export validation**: Compute and validate module exports
//! - **Visibility checking**: Enforce public/private access control
//! - **Cycle detection**: Detect and report circular dependencies
//!
//! # Architecture
//!
//! The resolution process works in several phases:
//!
//! 1. **Registration**: Add all HIR files to create the module registry
//! 2. **Graph Building**: Build the module dependency graph from imports
//! 3. **Cycle Detection**: Check for circular dependencies
//! 4. **Export Computation**: Compute the export set for each module
//! 5. **Cross-Module Resolution**: Resolve imports to actual definitions
//! 6. **Visibility Validation**: Ensure all accesses respect visibility
//!
//! # Usage
//!
//! ```ignore
//! use kanagawa_resolve::{ModuleResolver, ResolveResult};
//! use kanagawa_hir::HirFile;
//!
//! // Create resolver
//! let mut resolver = ModuleResolver::new();
//!
//! // Add all files (each with its own symbol table)
//! for (file, symbols) in files {
//!     resolver.add_module(file, symbols);
//! }
//!
//! // Resolve all cross-module references
//! let result = resolver.resolve_all();
//!
//! if result.has_errors() {
//!     for diag in &result.diagnostics {
//!         eprintln!("{}", diag);
//!     }
//! }
//! ```
//!
//! # Module Namespaces
//!
//! Module namespaces follow the Haskell frontend convention:
//! - Encoded with `@` prefixes: `"@data@optional"`
//! - Display format: `data.optional`
//!
//! # Export System
//!
//! Kanagawa supports three types of exports:
//! - **Name**: Export a single symbol (`export Foo;`)
//! - **Module**: Re-export an entire module (`export module data.list;`)
//! - **ModuleDiff**: Export module minus another (`export module foo \ bar;`)

pub mod diagnostic;
pub mod exports;
pub mod graph;
pub mod resolver;
pub mod visibility;

// Re-export main API
pub use diagnostic::{ResolveDiagnostic, ResolveDiagnostics, ResolveErrorCode};
pub use exports::{ExportSet, ExportedSymbol};
pub use graph::{ModuleGraph, ModuleId, ModuleNode};
pub use resolver::{ModuleResolver, ResolveResult};
pub use visibility::{check_visibility, VisibilityError};
