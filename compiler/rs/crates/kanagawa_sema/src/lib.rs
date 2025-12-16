//! Semantic validation for the Kanagawa compiler.
//!
//! This crate provides comprehensive semantic analysis and validation
//! for Kanagawa HIR (High-level Intermediate Representation) files.
//!
//! # Validation Passes
//!
//! The semantic validator performs the following checks:
//!
//! 1. **Duplicate Definitions** ([`duplicates`])
//!    - Duplicate top-level symbols (functions, types, variables)
//!    - Duplicate function parameters
//!    - Duplicate struct/class/union fields
//!    - Duplicate enum variants
//!    - Duplicate template parameters
//!    - Duplicate switch case labels
//!
//! 2. **Control Flow** ([`control_flow`])
//!    - Return path analysis (all paths return in non-void functions)
//!    - Break/continue context validation (only inside loops)
//!    - Unreachable code detection
//!    - Loop variable binding validity
//!
//! 3. **Attributes** ([`attributes`])
//!    - Valid attribute targets (functions, arrays, loops, etc.)
//!    - Attribute value constraints
//!    - Conflicting attribute combinations
//!    - Duplicate attribute warnings
//!
//! 4. **Memory Annotations** ([`memory`])
//!    - Memory attributes only on arrays
//!    - Valid FIFO depths and latency values
//!    - Conflicting memory configurations
//!    - Atomic block validation
//!
//! # Usage
//!
//! ```ignore
//! use kanagawa_sema::{SemanticValidator, ValidationOptions, validate};
//!
//! // Validate with all checks
//! let result = validate(&hir_file, &symbols);
//! if result.has_errors() {
//!     for error in result.diagnostics.errors() {
//!         eprintln!("{}", error);
//!     }
//! }
//!
//! // Or with specific checks
//! let validator = SemanticValidator::new(
//!     ValidationOptions::none()
//!         .with_duplicates()
//!         .with_control_flow()
//! );
//! let result = validator.validate(&hir_file, &symbols);
//! ```
//!
//! # Error Codes
//!
//! Errors are categorized by code:
//!
//! - **S001-S099**: Duplicate definition errors
//! - **S100-S199**: Control flow errors
//! - **S200-S299**: Attribute errors
//! - **S300-S399**: Memory/register annotation errors
//! - **S400-S499**: General semantic errors

pub mod attributes;
pub mod control_flow;
pub mod diagnostic;
pub mod duplicates;
pub mod memory;
pub mod validator;

// Re-export main types for convenience
pub use diagnostic::{SemaDiagnostic, SemaDiagnostics, SemaErrorCode, Severity};
pub use validator::{
    validate, validate_attributes, validate_control_flow, validate_duplicates, validate_memory,
    SemanticValidator, ValidationOptions, ValidationResult,
};

// Re-export individual validators
pub use attributes::AttributeValidator;
pub use control_flow::ControlFlowValidator;
pub use duplicates::DuplicateChecker;
pub use memory::MemoryValidator;
