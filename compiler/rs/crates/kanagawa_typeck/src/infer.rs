//! Type inference engine for Kanagawa.
//!
//! This module provides:
//! - Type variables for deferred type resolution
//! - Constraint-based type inference
//! - Type unification algorithm
//! - Substitution application

use crate::diagnostic::{Diagnostic, DiagnosticCode, Diagnostics};
use crate::rules::{self, Compatibility};
use kanagawa_hir::{Span, Ty};
use std::collections::HashMap;

/// Unique identifier for a type variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TypeVar(pub u32);

impl std::fmt::Display for TypeVar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "?T{}", self.0)
    }
}

/// A type that may contain type variables.
#[derive(Debug, Clone, PartialEq)]
pub enum InferTy {
    /// A known concrete type.
    Concrete(Ty),
    /// A type variable to be resolved.
    Var(TypeVar),
    /// An integer type with unknown width (will be inferred).
    IntVar { var: TypeVar, signed: Option<bool> },
}

impl InferTy {
    /// Check if this is a concrete (fully resolved) type.
    pub fn is_concrete(&self) -> bool {
        matches!(self, InferTy::Concrete(_))
    }

    /// Get the concrete type if resolved.
    pub fn as_concrete(&self) -> Option<&Ty> {
        match self {
            InferTy::Concrete(ty) => Some(ty),
            _ => None,
        }
    }

    /// Convert to concrete type, defaulting type variables.
    pub fn to_concrete(&self, default_int_width: u32) -> Ty {
        match self {
            InferTy::Concrete(ty) => ty.clone(),
            InferTy::Var(_) => Ty::Unresolved,
            InferTy::IntVar { signed, .. } => {
                if signed.unwrap_or(false) {
                    Ty::Signed(default_int_width)
                } else {
                    Ty::Unsigned(default_int_width)
                }
            }
        }
    }
}

impl std::fmt::Display for InferTy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InferTy::Concrete(ty) => write!(f, "{:?}", ty),
            InferTy::Var(v) => write!(f, "{}", v),
            InferTy::IntVar { var, signed } => {
                let sign = match signed {
                    Some(true) => "int",
                    Some(false) => "uint",
                    None => "?int",
                };
                write!(f, "{}#{}", sign, var)
            }
        }
    }
}

/// Type constraint generated during inference.
#[derive(Debug, Clone)]
pub enum Constraint {
    /// Two types must be equal.
    Equal { a: InferTy, b: InferTy, span: Span },
    /// Type `a` must be assignable to type `b`.
    Assignable {
        source: InferTy,
        target: InferTy,
        span: Span,
    },
    /// Type variable must be an integer.
    IsInteger { var: TypeVar, span: Span },
    /// Type variable must have at least this width.
    MinWidth { var: TypeVar, width: u32, span: Span },
}

/// The type inference context.
///
/// Tracks type variables, constraints, and resolved substitutions.
pub struct InferContext {
    /// Next type variable ID.
    next_var: u32,
    /// Substitutions: TypeVar -> InferTy.
    substitutions: HashMap<TypeVar, InferTy>,
    /// Pending constraints to solve.
    constraints: Vec<Constraint>,
    /// Generated diagnostics.
    pub diagnostics: Diagnostics,
}

impl Default for InferContext {
    fn default() -> Self {
        Self::new()
    }
}

impl InferContext {
    /// Create a new inference context.
    pub fn new() -> Self {
        Self {
            next_var: 0,
            substitutions: HashMap::new(),
            constraints: Vec::new(),
            diagnostics: Diagnostics::new(),
        }
    }

    /// Create a fresh type variable.
    pub fn fresh_var(&mut self) -> TypeVar {
        let var = TypeVar(self.next_var);
        self.next_var += 1;
        var
    }

    /// Create a fresh integer type variable.
    pub fn fresh_int_var(&mut self, signed: Option<bool>) -> InferTy {
        let var = self.fresh_var();
        InferTy::IntVar { var, signed }
    }

    /// Add a constraint that two types must be equal.
    pub fn constrain_equal(&mut self, a: InferTy, b: InferTy, span: Span) {
        self.constraints.push(Constraint::Equal { a, b, span });
    }

    /// Add a constraint that source is assignable to target.
    pub fn constrain_assignable(&mut self, source: InferTy, target: InferTy, span: Span) {
        self.constraints
            .push(Constraint::Assignable { source, target, span });
    }

    /// Set a type variable to a concrete type.
    pub fn set_var(&mut self, var: TypeVar, ty: InferTy) {
        self.substitutions.insert(var, ty);
    }

    /// Look up the current binding for a type variable.
    pub fn lookup(&self, var: TypeVar) -> Option<&InferTy> {
        self.substitutions.get(&var)
    }

    /// Apply substitutions to an inference type.
    pub fn apply(&self, ty: &InferTy) -> InferTy {
        match ty {
            InferTy::Concrete(_) => ty.clone(),
            InferTy::Var(var) => {
                if let Some(resolved) = self.substitutions.get(var) {
                    self.apply(resolved)
                } else {
                    ty.clone()
                }
            }
            InferTy::IntVar { var, signed } => {
                if let Some(resolved) = self.substitutions.get(var) {
                    self.apply(resolved)
                } else {
                    InferTy::IntVar {
                        var: *var,
                        signed: *signed,
                    }
                }
            }
        }
    }

    /// Solve all constraints and return whether successful.
    pub fn solve(&mut self) -> bool {
        let constraints = std::mem::take(&mut self.constraints);
        let mut changed = true;
        let mut iterations = 0;
        const MAX_ITERATIONS: usize = 100;

        // Iteratively solve constraints until fixed point
        let mut remaining = constraints;
        while changed && iterations < MAX_ITERATIONS {
            changed = false;
            iterations += 1;

            let mut next_remaining = Vec::new();

            for constraint in remaining {
                match self.solve_constraint(&constraint) {
                    SolveResult::Solved => changed = true,
                    SolveResult::Deferred => next_remaining.push(constraint),
                    SolveResult::Error(diag) => {
                        self.diagnostics.add(diag);
                        changed = true;
                    }
                }
            }

            remaining = next_remaining;
        }

        // Report any unsolved constraints
        for constraint in remaining {
            self.report_unsolved_constraint(&constraint);
        }

        !self.diagnostics.has_errors()
    }

    /// Try to solve a single constraint.
    fn solve_constraint(&mut self, constraint: &Constraint) -> SolveResult {
        match constraint {
            Constraint::Equal { a, b, span } => self.unify(a, b, *span),
            Constraint::Assignable { source, target, span } => {
                self.check_assignable(source, target, *span)
            }
            Constraint::IsInteger { var, span } => {
                // Check if var is bound to an integer
                if let Some(ty) = self.substitutions.get(var) {
                    if let InferTy::Concrete(ty) = self.apply(ty) {
                        if ty.is_int() || ty.is_bool() {
                            return SolveResult::Solved;
                        } else {
                            return SolveResult::Error(Diagnostic::error(
                                DiagnosticCode::ExpectedType,
                                format!("expected integer type, found `{:?}`", ty),
                                *span,
                            ));
                        }
                    }
                }
                SolveResult::Deferred
            }
            Constraint::MinWidth { var, width, span } => {
                if let Some(ty) = self.substitutions.get(var).cloned() {
                    if let InferTy::Concrete(ty) = self.apply(&ty) {
                        if let Some(actual_width) = ty.width() {
                            if actual_width >= *width {
                                return SolveResult::Solved;
                            } else {
                                return SolveResult::Error(Diagnostic::error(
                                    DiagnosticCode::IntegerWidthMismatch,
                                    format!(
                                        "type `{:?}` is {} bits, but at least {} bits required",
                                        ty, actual_width, width
                                    ),
                                    *span,
                                ));
                            }
                        }
                    }
                }
                SolveResult::Deferred
            }
        }
    }

    /// Unify two types, making them equal.
    fn unify(&mut self, a: &InferTy, b: &InferTy, span: Span) -> SolveResult {
        let a = self.apply(a);
        let b = self.apply(b);

        match (&a, &b) {
            // Both concrete: must be equal
            (InferTy::Concrete(ta), InferTy::Concrete(tb)) => {
                if rules::types_equal(ta, tb) {
                    SolveResult::Solved
                } else {
                    SolveResult::Error(Diagnostic::error(
                        DiagnosticCode::TypeMismatch,
                        format!("type mismatch: expected `{:?}`, found `{:?}`", ta, tb),
                        span,
                    ))
                }
            }

            // One is a variable: bind it
            (InferTy::Var(var), other) | (other, InferTy::Var(var)) => {
                self.substitutions.insert(*var, other.clone());
                SolveResult::Solved
            }

            // Integer variables
            (InferTy::IntVar { var: va, signed: sa }, InferTy::IntVar { var: vb, signed: sb }) => {
                // Merge signedness info
                let merged_signed = match (sa, sb) {
                    (Some(a), Some(b)) if a != b => {
                        // Conflict: one signed, one unsigned
                        // Promote to signed
                        Some(true)
                    }
                    (Some(s), _) | (_, Some(s)) => Some(*s),
                    _ => None,
                };
                // Bind va to vb with merged info
                self.substitutions.insert(
                    *va,
                    InferTy::IntVar {
                        var: *vb,
                        signed: merged_signed,
                    },
                );
                SolveResult::Solved
            }

            (InferTy::IntVar { var, signed }, InferTy::Concrete(ty))
            | (InferTy::Concrete(ty), InferTy::IntVar { var, signed }) => {
                // Check type is integer
                match ty {
                    Ty::Unsigned(_) if *signed != Some(true) => {
                        self.substitutions.insert(*var, InferTy::Concrete(ty.clone()));
                        SolveResult::Solved
                    }
                    Ty::Signed(_) if *signed != Some(false) => {
                        self.substitutions.insert(*var, InferTy::Concrete(ty.clone()));
                        SolveResult::Solved
                    }
                    Ty::Unsigned(_) | Ty::Signed(_) => {
                        // Signedness mismatch
                        SolveResult::Error(Diagnostic::error(
                            DiagnosticCode::SignednessMismatch,
                            format!(
                                "signedness mismatch: expected {}, found `{:?}`",
                                if *signed == Some(true) {
                                    "signed"
                                } else {
                                    "unsigned"
                                },
                                ty
                            ),
                            span,
                        ))
                    }
                    Ty::Bool => {
                        self.substitutions.insert(*var, InferTy::Concrete(ty.clone()));
                        SolveResult::Solved
                    }
                    _ => SolveResult::Error(Diagnostic::error(
                        DiagnosticCode::ExpectedType,
                        format!("expected integer type, found `{:?}`", ty),
                        span,
                    )),
                }
            }
        }
    }

    /// Check if source type is assignable to target type.
    fn check_assignable(&mut self, source: &InferTy, target: &InferTy, span: Span) -> SolveResult {
        let source = self.apply(source);
        let target = self.apply(target);

        match (&source, &target) {
            (InferTy::Concrete(s), InferTy::Concrete(t)) => {
                match rules::check_assignment_compatibility(t, s) {
                    Compatibility::Identical | Compatibility::ImplicitWidening => {
                        SolveResult::Solved
                    }
                    Compatibility::ExplicitCastRequired => {
                        SolveResult::Error(crate::diagnostic::implicit_narrowing(s, t, span))
                    }
                    Compatibility::Incompatible => SolveResult::Error(Diagnostic::error(
                        DiagnosticCode::InvalidAssignment,
                        format!("cannot assign `{:?}` to `{:?}`", s, t),
                        span,
                    )),
                }
            }
            // If either is a variable, defer
            _ => SolveResult::Deferred,
        }
    }

    /// Report an unsolved constraint as an error.
    fn report_unsolved_constraint(&mut self, constraint: &Constraint) {
        let span = match constraint {
            Constraint::Equal { span, .. }
            | Constraint::Assignable { span, .. }
            | Constraint::IsInteger { span, .. }
            | Constraint::MinWidth { span, .. } => *span,
        };

        self.diagnostics.add(Diagnostic::error(
            DiagnosticCode::CannotInfer,
            "could not infer type".to_string(),
            span,
        ));
    }

    /// Finalize a type, applying all substitutions and defaulting unresolved vars.
    pub fn finalize(&self, ty: &InferTy) -> Ty {
        let resolved = self.apply(ty);
        resolved.to_concrete(32) // Default to 32-bit integers
    }

    /// Check if there are any errors.
    pub fn has_errors(&self) -> bool {
        self.diagnostics.has_errors()
    }
}

/// Result of attempting to solve a constraint.
enum SolveResult {
    /// Constraint was solved.
    Solved,
    /// Constraint needs more information, defer.
    Deferred,
    /// Constraint is unsatisfiable.
    Error(Diagnostic),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fresh_vars() {
        let mut ctx = InferContext::new();
        let v1 = ctx.fresh_var();
        let v2 = ctx.fresh_var();
        assert_ne!(v1, v2);
    }

    #[test]
    fn test_unify_concrete() {
        let mut ctx = InferContext::new();
        ctx.constrain_equal(
            InferTy::Concrete(Ty::Unsigned(32)),
            InferTy::Concrete(Ty::Unsigned(32)),
            Span::default(),
        );
        assert!(ctx.solve());
    }

    #[test]
    fn test_unify_var() {
        let mut ctx = InferContext::new();
        let var = ctx.fresh_var();
        ctx.constrain_equal(
            InferTy::Var(var),
            InferTy::Concrete(Ty::Unsigned(32)),
            Span::default(),
        );
        assert!(ctx.solve());
        assert_eq!(
            ctx.finalize(&InferTy::Var(var)),
            Ty::Unsigned(32)
        );
    }

    #[test]
    fn test_unify_mismatch() {
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
    fn test_assignable_widening() {
        let mut ctx = InferContext::new();
        ctx.constrain_assignable(
            InferTy::Concrete(Ty::Unsigned(16)),
            InferTy::Concrete(Ty::Unsigned(32)),
            Span::default(),
        );
        assert!(ctx.solve());
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
}
