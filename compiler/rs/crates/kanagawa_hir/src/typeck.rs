//! Type checking with bidirectional type inference.
//!
//! This module implements type checking and inference for HIR using:
//! - Bidirectional type checking (check mode + infer mode)
//! - Union-find based unification with path compression
//! - Constraint solving for type variables

use crate::{
    consteval::{ConstEvaluator, ConstValue},
    DefId, HirBinaryOp, HirBlock, HirExpr, HirExprKind, HirFunction, HirItem, HirStmt, HirUnaryOp,
    Span, SymbolTable, Ty, TyFuncParam,
};
use std::collections::HashMap;

/// Unique identifier for a type variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TypeVarId(pub u32);

impl TypeVarId {
    /// Create a type representing this type variable.
    pub fn to_type(&self) -> Ty {
        // We use Ty::Dependent to represent type variables
        // In a full implementation, we'd add a Ty::Var variant
        Ty::Dependent(Box::new(Ty::Signed(self.0)))
    }
}

/// Type checking errors.
#[derive(Debug, Clone)]
pub enum TypeError {
    /// Type mismatch.
    Mismatch {
        expected: Ty,
        found: Ty,
        span: Span,
        context: String,
    },
    /// Undefined variable.
    UndefinedVariable {
        name: String,
        span: Span,
    },
    /// Cannot infer type.
    CannotInfer {
        span: Span,
        context: String,
    },
    /// Invalid operation for type.
    InvalidOperation {
        op: String,
        ty: Ty,
        span: Span,
    },
    /// Function call argument count mismatch.
    ArgCountMismatch {
        expected: usize,
        found: usize,
        span: Span,
    },
    /// Not a function type.
    NotAFunction {
        ty: Ty,
        span: Span,
    },
    /// Not callable.
    NotCallable {
        span: Span,
    },
    /// Invalid member access.
    InvalidMember {
        ty: Ty,
        member: String,
        span: Span,
    },
    /// Invalid array subscript.
    InvalidSubscript {
        ty: Ty,
        span: Span,
    },
    /// Cannot assign to expression.
    NotAssignable {
        span: Span,
    },
    /// Return type mismatch.
    ReturnTypeMismatch {
        expected: Ty,
        found: Ty,
        span: Span,
    },
    /// Break outside of loop.
    BreakOutsideLoop {
        span: Span,
    },
    /// Occurs check failure (recursive type).
    OccursCheck {
        var: TypeVarId,
        ty: Ty,
    },
}

impl std::fmt::Display for TypeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TypeError::Mismatch {
                expected,
                found,
                context,
                ..
            } => {
                write!(
                    f,
                    "type mismatch in {}: expected {:?}, found {:?}",
                    context, expected, found
                )
            }
            TypeError::UndefinedVariable { name, .. } => {
                write!(f, "undefined variable '{}'", name)
            }
            TypeError::CannotInfer { context, .. } => {
                write!(f, "cannot infer type: {}", context)
            }
            TypeError::InvalidOperation { op, ty, .. } => {
                write!(f, "invalid operation '{}' for type {:?}", op, ty)
            }
            TypeError::ArgCountMismatch {
                expected, found, ..
            } => {
                write!(
                    f,
                    "function argument count mismatch: expected {}, found {}",
                    expected, found
                )
            }
            TypeError::NotAFunction { ty, .. } => {
                write!(f, "not a function type: {:?}", ty)
            }
            TypeError::NotCallable { .. } => {
                write!(f, "expression is not callable")
            }
            TypeError::InvalidMember { ty, member, .. } => {
                write!(f, "type {:?} has no member '{}'", ty, member)
            }
            TypeError::InvalidSubscript { ty, .. } => {
                write!(f, "cannot subscript type {:?}", ty)
            }
            TypeError::NotAssignable { .. } => {
                write!(f, "expression is not assignable")
            }
            TypeError::ReturnTypeMismatch {
                expected, found, ..
            } => {
                write!(
                    f,
                    "return type mismatch: expected {:?}, found {:?}",
                    expected, found
                )
            }
            TypeError::BreakOutsideLoop { .. } => {
                write!(f, "break statement outside of loop")
            }
            TypeError::OccursCheck { var, ty } => {
                write!(
                    f,
                    "infinite type: type variable {:?} occurs in {:?}",
                    var, ty
                )
            }
        }
    }
}

/// Result of type inference for a function body.
#[derive(Debug, Clone)]
pub struct InferenceResult {
    /// Inferred types for each expression by span.
    pub expr_types: HashMap<Span, Ty>,
    /// Inferred types for local variables.
    pub local_types: HashMap<DefId, Ty>,
    /// Type errors encountered.
    pub errors: Vec<TypeError>,
    /// Final substitution.
    pub substitution: Substitution,
}

impl InferenceResult {
    /// Create a new empty inference result.
    pub fn new() -> Self {
        Self {
            expr_types: HashMap::new(),
            local_types: HashMap::new(),
            errors: Vec::new(),
            substitution: Substitution::new(),
        }
    }

    /// Check if there are any errors.
    pub fn has_errors(&self) -> bool {
        !self.errors.is_empty()
    }

    /// Get the type for an expression at a given span.
    pub fn type_at(&self, span: &Span) -> Option<&Ty> {
        self.expr_types.get(span)
    }

    /// Get the type for a local variable.
    pub fn local_type(&self, def_id: &DefId) -> Option<&Ty> {
        self.local_types.get(def_id)
    }

    /// Apply the substitution to resolve all type variables.
    pub fn resolve_type(&self, ty: &Ty) -> Ty {
        self.substitution.apply(ty)
    }
}

impl Default for InferenceResult {
    fn default() -> Self {
        Self::new()
    }
}

/// Type substitution map.
#[derive(Debug, Clone, Default)]
pub struct Substitution {
    /// Map from type variable ID to resolved type.
    map: HashMap<TypeVarId, Ty>,
}

impl Substitution {
    /// Create a new empty substitution.
    pub fn new() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    /// Insert a type variable binding.
    pub fn insert(&mut self, var: TypeVarId, ty: Ty) {
        self.map.insert(var, ty);
    }

    /// Get the type bound to a variable.
    pub fn get(&self, var: TypeVarId) -> Option<&Ty> {
        self.map.get(&var)
    }

    /// Apply the substitution to a type.
    pub fn apply(&self, ty: &Ty) -> Ty {
        match ty {
            Ty::Dependent(inner) => {
                // Check if this is a type variable
                if let Ty::Signed(id) = inner.as_ref() {
                    let var = TypeVarId(*id);
                    if let Some(resolved) = self.map.get(&var) {
                        return self.apply(resolved);
                    }
                }
                Ty::Dependent(Box::new(self.apply(inner)))
            }
            Ty::Auto => {
                // Auto should have been resolved
                Ty::Auto
            }
            Ty::Const(inner) => Ty::Const(Box::new(self.apply(inner))),
            Ty::Array {
                attrs,
                element,
                dims,
            } => Ty::Array {
                attrs: attrs.clone(),
                element: Box::new(self.apply(element)),
                dims: dims.clone(),
            },
            Ty::Function {
                kind,
                attrs,
                return_ty,
                params,
            } => Ty::Function {
                kind: *kind,
                attrs: attrs.clone(),
                return_ty: Box::new(self.apply(return_ty)),
                params: params
                    .iter()
                    .map(|p| TyFuncParam {
                        attrs: p.attrs.clone(),
                        ty: self.apply(&p.ty),
                        name: p.name.clone(),
                    })
                    .collect(),
            },
            // Other types pass through unchanged
            other => other.clone(),
        }
    }

    /// Combine two substitutions.
    pub fn compose(&mut self, other: &Substitution) {
        // Apply other to all existing bindings
        for (_, ty) in self.map.iter_mut() {
            *ty = other.apply(ty);
        }
        // Add new bindings from other
        for (var, ty) in &other.map {
            self.map.entry(*var).or_insert_with(|| ty.clone());
        }
    }
}

/// Union-find based type unifier.
#[derive(Debug)]
pub struct TypeUnifier {
    /// Parent pointers for union-find.
    parent: Vec<usize>,
    /// Rank for union by rank optimization.
    rank: Vec<usize>,
    /// Resolved types for each variable.
    types: Vec<Option<Ty>>,
    /// Next type variable ID.
    next_var: u32,
}

impl TypeUnifier {
    /// Create a new type unifier.
    pub fn new() -> Self {
        Self {
            parent: Vec::new(),
            rank: Vec::new(),
            types: Vec::new(),
            next_var: 0,
        }
    }

    /// Allocate a fresh type variable.
    pub fn fresh(&mut self) -> TypeVarId {
        let id = TypeVarId(self.next_var);
        self.next_var += 1;
        let idx = id.0 as usize;
        // Ensure we have enough capacity
        while self.parent.len() <= idx {
            self.parent.push(self.parent.len());
            self.rank.push(0);
            self.types.push(None);
        }
        id
    }

    /// Find the representative of a type variable with path compression.
    pub fn find(&mut self, var: TypeVarId) -> TypeVarId {
        let idx = var.0 as usize;
        if idx >= self.parent.len() {
            return var;
        }
        if self.parent[idx] != idx {
            let root = self.find(TypeVarId(self.parent[idx] as u32));
            self.parent[idx] = root.0 as usize;
            return root;
        }
        var
    }

    /// Get the resolved type for a variable.
    pub fn probe(&mut self, var: TypeVarId) -> Option<Ty> {
        let root = self.find(var);
        let idx = root.0 as usize;
        if idx < self.types.len() {
            self.types[idx].clone()
        } else {
            None
        }
    }

    /// Unify two type variables.
    pub fn unify_vars(&mut self, a: TypeVarId, b: TypeVarId) -> Result<(), TypeError> {
        let root_a = self.find(a);
        let root_b = self.find(b);

        if root_a == root_b {
            return Ok(());
        }

        let idx_a = root_a.0 as usize;
        let idx_b = root_b.0 as usize;

        // Check for conflicting concrete types
        let ty_a = self.types.get(idx_a).cloned().flatten();
        let ty_b = self.types.get(idx_b).cloned().flatten();

        match (ty_a.as_ref(), ty_b.as_ref()) {
            (Some(ta), Some(tb)) if !types_compatible(ta, tb) => {
                return Err(TypeError::Mismatch {
                    expected: ta.clone(),
                    found: tb.clone(),
                    span: Span { start: 0, end: 0, file_index: 0 },
                    context: "unification".to_string(),
                });
            }
            _ => {}
        }

        // Union by rank
        if self.rank[idx_a] < self.rank[idx_b] {
            self.parent[idx_a] = idx_b;
            if ty_a.is_some() && ty_b.is_none() {
                self.types[idx_b] = ty_a;
            }
        } else if self.rank[idx_a] > self.rank[idx_b] {
            self.parent[idx_b] = idx_a;
            if ty_b.is_some() && ty_a.is_none() {
                self.types[idx_a] = ty_b;
            }
        } else {
            self.parent[idx_b] = idx_a;
            self.rank[idx_a] += 1;
            if ty_b.is_some() && ty_a.is_none() {
                self.types[idx_a] = ty_b;
            }
        }

        Ok(())
    }

    /// Bind a type variable to a concrete type.
    pub fn bind(&mut self, var: TypeVarId, ty: Ty) -> Result<(), TypeError> {
        let root = self.find(var);
        let idx = root.0 as usize;

        // Occurs check
        if self.occurs_in(root, &ty) {
            return Err(TypeError::OccursCheck { var: root, ty });
        }

        // Ensure capacity
        while self.types.len() <= idx {
            self.types.push(None);
            self.parent.push(self.parent.len());
            self.rank.push(0);
        }

        if let Some(existing) = &self.types[idx] {
            // Already bound - unify with existing
            if !types_compatible(existing, &ty) {
                return Err(TypeError::Mismatch {
                    expected: existing.clone(),
                    found: ty,
                    span: Span { start: 0, end: 0, file_index: 0 },
                    context: "binding".to_string(),
                });
            }
        } else {
            self.types[idx] = Some(ty);
        }

        Ok(())
    }

    /// Check if a type variable occurs in a type.
    fn occurs_in(&self, var: TypeVarId, ty: &Ty) -> bool {
        match ty {
            Ty::Dependent(inner) => {
                if let Ty::Signed(id) = inner.as_ref() {
                    if TypeVarId(*id) == var {
                        return true;
                    }
                }
                self.occurs_in(var, inner)
            }
            Ty::Const(inner) => self.occurs_in(var, inner),
            Ty::Array { element, .. } => self.occurs_in(var, element),
            Ty::Function {
                return_ty, params, ..
            } => {
                self.occurs_in(var, return_ty)
                    || params.iter().any(|p| self.occurs_in(var, &p.ty))
            }
            _ => false,
        }
    }

    /// Get the final substitution.
    pub fn into_substitution(self) -> Substitution {
        let mut subst = Substitution::new();
        for (i, ty) in self.types.into_iter().enumerate() {
            if let Some(t) = ty {
                subst.insert(TypeVarId(i as u32), t);
            }
        }
        subst
    }
}

impl Default for TypeUnifier {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if two types are compatible for unification.
pub fn types_compatible(a: &Ty, b: &Ty) -> bool {
    match (a, b) {
        // Same simple types
        (Ty::Void, Ty::Void) => true,
        (Ty::Bool, Ty::Bool) => true,
        (Ty::Float, Ty::Float) => true,
        (Ty::String, Ty::String) => true,
        (Ty::Signed(w1), Ty::Signed(w2)) => w1 == w2,
        (Ty::Unsigned(w1), Ty::Unsigned(w2)) => w1 == w2,

        // Error type is compatible with anything (prevents cascading errors)
        (Ty::Error(_), _) | (_, Ty::Error(_)) => true,

        // Auto/unresolved are compatible (will be resolved)
        (Ty::Auto, _) | (_, Ty::Auto) => true,
        (Ty::Unresolved, _) | (_, Ty::Unresolved) => true,

        // Const compatibility
        (Ty::Const(a), Ty::Const(b)) => types_compatible(a, b),
        (Ty::Const(a), b) => types_compatible(a, b),
        (a, Ty::Const(b)) => types_compatible(a, b),

        // Array compatibility
        (
            Ty::Array {
                element: e1,
                dims: d1,
                ..
            },
            Ty::Array {
                element: e2,
                dims: d2,
                ..
            },
        ) => types_compatible(e1, e2) && d1 == d2,

        // Function compatibility
        (
            Ty::Function {
                return_ty: r1,
                params: p1,
                ..
            },
            Ty::Function {
                return_ty: r2,
                params: p2,
                ..
            },
        ) => {
            types_compatible(r1, r2)
                && p1.len() == p2.len()
                && p1
                    .iter()
                    .zip(p2.iter())
                    .all(|(a, b)| types_compatible(&a.ty, &b.ty))
        }

        // Named types
        (Ty::Struct { name: n1, .. }, Ty::Struct { name: n2, .. }) => n1 == n2,
        (Ty::Class { name: n1, .. }, Ty::Class { name: n2, .. }) => n1 == n2,
        (Ty::Enum { name: n1, .. }, Ty::Enum { name: n2, .. }) => n1 == n2,
        (Ty::Union { name: n1, .. }, Ty::Union { name: n2, .. }) => n1 == n2,

        // Instance compatibility
        (
            Ty::Instance {
                template: t1,
                args: a1,
                ..
            },
            Ty::Instance {
                template: t2,
                args: a2,
                ..
            },
        ) => types_compatible(t1, t2) && a1 == a2,

        // Reference compatibility
        (Ty::Reference(n1), Ty::Reference(n2)) => n1 == n2,

        // Different types
        _ => false,
    }
}

/// Type checker with bidirectional type inference.
pub struct TypeChecker<'a> {
    /// Symbol table for name resolution.
    symbols: &'a SymbolTable,
    /// Type unifier.
    unifier: TypeUnifier,
    /// Type errors.
    errors: Vec<TypeError>,
    /// Expression types by span.
    expr_types: HashMap<Span, Ty>,
    /// Local variable types.
    local_types: HashMap<DefId, Ty>,
    /// Current function return type (for return statement checking).
    return_ty: Option<Ty>,
    /// Are we inside a loop?
    in_loop: bool,
    /// Constant evaluator.
    const_eval: ConstEvaluator,
}

impl<'a> TypeChecker<'a> {
    /// Create a new type checker.
    pub fn new(symbols: &'a SymbolTable) -> Self {
        Self {
            symbols,
            unifier: TypeUnifier::new(),
            errors: Vec::new(),
            expr_types: HashMap::new(),
            local_types: HashMap::new(),
            return_ty: None,
            in_loop: false,
            const_eval: ConstEvaluator::new(),
        }
    }

    /// Type check a function.
    pub fn check_function(&mut self, func: &HirFunction) -> InferenceResult {
        // Set return type for return statement checking
        self.return_ty = Some(func.return_ty.clone());

        // Bind parameters
        for param in &func.params {
            self.local_types.insert(param.def_id, param.ty.clone());
        }

        // Check body
        if let Some(body) = &func.body {
            self.check_block(body);
        }

        InferenceResult {
            expr_types: std::mem::take(&mut self.expr_types),
            local_types: std::mem::take(&mut self.local_types),
            errors: std::mem::take(&mut self.errors),
            substitution: std::mem::take(&mut self.unifier).into_substitution(),
        }
    }

    /// Check a block of statements.
    fn check_block(&mut self, block: &HirBlock) {
        for stmt in &block.stmts {
            self.check_stmt(stmt);
        }
    }

    /// Check a statement.
    fn check_stmt(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::Block(block) => self.check_block(block),

            HirStmt::Return(ret) => {
                if let Some(expr) = &ret.value {
                    let ty = self.infer_expr(expr);
                    if let Some(expected) = &self.return_ty {
                        if !types_compatible(&ty, expected) {
                            self.errors.push(TypeError::ReturnTypeMismatch {
                                expected: expected.clone(),
                                found: ty,
                                span: ret.span,
                            });
                        }
                    }
                } else if let Some(expected) = &self.return_ty {
                    if !matches!(expected, Ty::Void) {
                        self.errors.push(TypeError::ReturnTypeMismatch {
                            expected: expected.clone(),
                            found: Ty::Void,
                            span: ret.span,
                        });
                    }
                }
            }

            HirStmt::If(if_stmt) => {
                let cond_ty = self.infer_expr(&if_stmt.condition);
                if !matches!(cond_ty, Ty::Bool | Ty::Error(_) | Ty::Auto | Ty::Unresolved) {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: cond_ty,
                        span: if_stmt.condition.span,
                        context: "if condition".to_string(),
                    });
                }
                self.check_stmt(&if_stmt.then_branch);
                if let Some(else_branch) = &if_stmt.else_branch {
                    self.check_stmt(else_branch);
                }
            }

            HirStmt::DoWhile(do_while) => {
                let was_in_loop = self.in_loop;
                self.in_loop = true;
                self.check_stmt(&do_while.body);
                self.in_loop = was_in_loop;
                let cond_ty = self.infer_expr(&do_while.condition);
                if !matches!(cond_ty, Ty::Bool | Ty::Error(_) | Ty::Auto | Ty::Unresolved) {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: cond_ty,
                        span: do_while.condition.span,
                        context: "do-while condition".to_string(),
                    });
                }
            }

            HirStmt::RangeFor(range_for) => {
                // Infer iterator type from limit
                let limit_ty = self.infer_expr(&range_for.limit);
                let iter_ty = match &limit_ty {
                    Ty::Signed(_) | Ty::Unsigned(_) => limit_ty.clone(),
                    _ => Ty::Signed(32), // Default
                };

                // Bind iterator variable
                let var_ty = if matches!(range_for.var_ty, Ty::Auto) {
                    iter_ty
                } else {
                    range_for.var_ty.clone()
                };
                self.local_types.insert(range_for.var_def_id, var_ty);

                let was_in_loop = self.in_loop;
                self.in_loop = true;
                self.check_stmt(&range_for.body);
                self.in_loop = was_in_loop;
            }

            HirStmt::StaticFor(static_for) => {
                // Static for requires compile-time limit
                let limit_val = self.const_eval.eval(&static_for.limit);
                let iter_ty = match limit_val {
                    ConstValue::Int { width, signed, .. } => {
                        if signed {
                            Ty::Signed(width)
                        } else {
                            Ty::Unsigned(width)
                        }
                    }
                    _ => self.infer_expr(&static_for.limit),
                };

                // Bind iterator variable
                let var_ty = if matches!(static_for.var_ty, Ty::Auto) {
                    iter_ty
                } else {
                    static_for.var_ty.clone()
                };
                self.local_types.insert(static_for.var_def_id, var_ty);

                let was_in_loop = self.in_loop;
                self.in_loop = true;
                self.check_stmt(&static_for.body);
                self.in_loop = was_in_loop;
            }

            HirStmt::UnrolledFor(unrolled_for) => {
                // Similar to static for
                let limit_ty = self.infer_expr(&unrolled_for.limit);
                let iter_ty = match &limit_ty {
                    Ty::Signed(_) | Ty::Unsigned(_) => limit_ty.clone(),
                    _ => Ty::Signed(32),
                };

                let var_ty = if matches!(unrolled_for.var_ty, Ty::Auto) {
                    iter_ty
                } else {
                    unrolled_for.var_ty.clone()
                };
                self.local_types.insert(unrolled_for.var_def_id, var_ty);

                let was_in_loop = self.in_loop;
                self.in_loop = true;
                self.check_stmt(&unrolled_for.body);
                self.in_loop = was_in_loop;
            }

            HirStmt::Switch(switch) => {
                let scrutinee_ty = self.infer_expr(&switch.expr);
                for case in &switch.cases {
                    if let crate::HirSwitchLabel::Case(value) = &case.label {
                        let case_ty = self.infer_expr(value);
                        if !types_compatible(&scrutinee_ty, &case_ty) {
                            self.errors.push(TypeError::Mismatch {
                                expected: scrutinee_ty.clone(),
                                found: case_ty,
                                span: value.span,
                                context: "switch case".to_string(),
                            });
                        }
                    }
                    for stmt in &case.stmts {
                        self.check_stmt(stmt);
                    }
                }
            }

            HirStmt::Expr(expr_stmt) => {
                self.infer_expr(&expr_stmt.expr);
            }

            HirStmt::VarDecl(var_decl) => {
                let decl_ty = &var_decl.ty;
                let init_ty = var_decl.init.as_ref().map(|e| self.infer_expr(e));

                let final_ty = match (decl_ty, init_ty) {
                    (Ty::Auto, Some(init)) => init,
                    (ty, Some(init)) if !types_compatible(ty, &init) => {
                        self.errors.push(TypeError::Mismatch {
                            expected: ty.clone(),
                            found: init,
                            span: var_decl.span,
                            context: "variable initialization".to_string(),
                        });
                        ty.clone()
                    }
                    (ty, _) => ty.clone(),
                };

                self.local_types.insert(var_decl.def_id, final_ty);
            }

            HirStmt::Assign(assign) => {
                let target_ty = self.infer_expr(&assign.lhs);
                let value_ty = self.infer_expr(&assign.rhs);
                if !types_compatible(&target_ty, &value_ty) {
                    self.errors.push(TypeError::Mismatch {
                        expected: target_ty,
                        found: value_ty,
                        span: assign.span,
                        context: "assignment".to_string(),
                    });
                }
            }

            HirStmt::Break(span) => {
                if !self.in_loop {
                    self.errors.push(TypeError::BreakOutsideLoop { span: *span });
                }
            }

            HirStmt::Barrier(_) | HirStmt::Reorder(_) | HirStmt::Atomic(_) => {
                // These don't require type checking
            }

            HirStmt::Annotated(annotated) => {
                self.check_stmt(&annotated.stmt);
            }

            HirStmt::StaticIf(static_if) => {
                // Condition should be compile-time evaluable
                let cond_ty = self.infer_expr(&static_if.condition);
                if !matches!(cond_ty, Ty::Bool | Ty::Error(_) | Ty::Auto | Ty::Unresolved) {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: cond_ty,
                        span: static_if.condition.span,
                        context: "static if condition".to_string(),
                    });
                }
                self.check_stmt(&static_if.then_branch);
                if let Some(else_branch) = &static_if.else_branch {
                    self.check_stmt(else_branch);
                }
            }
        }
    }

    /// Infer the type of an expression.
    pub fn infer_expr(&mut self, expr: &HirExpr) -> Ty {
        let ty = self.infer_expr_inner(expr);
        self.expr_types.insert(expr.span, ty.clone());
        ty
    }

    fn infer_expr_inner(&mut self, expr: &HirExpr) -> Ty {
        match &expr.kind {
            // Literals
            HirExprKind::IntLiteral { suffix, .. } => match suffix {
                Some(s) => {
                    if s.signed {
                        Ty::Signed(s.width as u32)
                    } else {
                        Ty::Unsigned(s.width as u32)
                    }
                }
                None => {
                    // Default to i32 for unsuffixed integer
                    Ty::Signed(32)
                }
            },

            HirExprKind::FloatLiteral(_) => Ty::Float,

            HirExprKind::BoolLiteral(_) => Ty::Bool,

            HirExprKind::StringLiteral(_) | HirExprKind::InterpolatedString(_) => Ty::String,

            // Identifiers
            HirExprKind::Ident { def_id, name } => {
                if let Some(ty) = self.local_types.get(def_id) {
                    return ty.clone();
                }
                // Try to look up in symbol table
                if let Some(lookup_def_id) = self.symbols.lookup(name) {
                    if let Some(entry) = self.symbols.get(lookup_def_id) {
                        return entry.ty.clone();
                    }
                }
                // Unknown identifier - use declared type
                expr.ty.clone()
            }

            HirExprKind::QualifiedIdent { .. } => {
                // Qualified names usually refer to types or constants
                expr.ty.clone()
            }

            HirExprKind::This { .. } => {
                // 'this' type should be set in context
                expr.ty.clone()
            }

            // Binary operations
            HirExprKind::Binary { op, lhs, rhs } => {
                let left_ty = self.infer_expr(lhs);
                let right_ty = self.infer_expr(rhs);
                self.infer_binary_op(*op, &left_ty, &right_ty, expr.span)
            }

            // Unary operations
            HirExprKind::Unary { op, operand } => {
                let operand_ty = self.infer_expr(operand);
                self.infer_unary_op(*op, &operand_ty, expr.span)
            }

            // Ternary conditional
            HirExprKind::Ternary {
                condition,
                then_expr,
                else_expr,
            } => {
                let cond_ty = self.infer_expr(condition);
                if !matches!(cond_ty, Ty::Bool | Ty::Error(_) | Ty::Auto | Ty::Unresolved) {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: cond_ty,
                        span: condition.span,
                        context: "conditional".to_string(),
                    });
                }
                let then_ty = self.infer_expr(then_expr);
                let else_ty = self.infer_expr(else_expr);
                // Result type is the common type
                if types_compatible(&then_ty, &else_ty) {
                    then_ty
                } else {
                    self.errors.push(TypeError::Mismatch {
                        expected: then_ty.clone(),
                        found: else_ty,
                        span: else_expr.span,
                        context: "conditional branches".to_string(),
                    });
                    then_ty
                }
            }

            // Function call
            HirExprKind::Call { callee, args, .. } => {
                let callee_ty = self.infer_expr(callee);
                self.check_call(&callee_ty, args, expr.span)
            }

            // Member access
            HirExprKind::Member { object, member, .. } => {
                let obj_ty = self.infer_expr(object);
                self.infer_member_access(&obj_ty, member, expr.span)
            }

            // Array subscript
            HirExprKind::Subscript { array, index } => {
                let arr_ty = self.infer_expr(array);
                let idx_ty = self.infer_expr(index);
                self.infer_subscript(&arr_ty, &idx_ty, expr.span)
            }

            // Type cast
            HirExprKind::Cast { ty, expr: inner } => {
                self.infer_expr(inner);
                ty.clone()
            }

            // Parenthesized
            HirExprKind::Paren(inner) => self.infer_expr(inner),

            // Initializer list
            HirExprKind::InitializerList(elements) => {
                if elements.is_empty() {
                    // Empty array - need context to determine type
                    expr.ty.clone()
                } else {
                    let elem_ty = self.infer_expr(&elements[0]);
                    for elem in elements.iter().skip(1) {
                        let ty = self.infer_expr(elem);
                        if !types_compatible(&elem_ty, &ty) {
                            self.errors.push(TypeError::Mismatch {
                                expected: elem_ty.clone(),
                                found: ty,
                                span: elem.span,
                                context: "initializer element".to_string(),
                            });
                        }
                    }
                    Ty::Initializer(vec![elem_ty; elements.len()])
                }
            }

            // Designated initializer
            HirExprKind::DesignatedInitializer(designators) => {
                let mut fields = Vec::new();
                for (name, value) in designators {
                    let ty = self.infer_expr(value);
                    fields.push((name.clone(), ty));
                }
                // Return as struct type with fields
                Ty::Struct {
                    name: vec!["<initializer>".to_string()],
                    fields,
                }
            }

            // Built-ins
            HirExprKind::Mux { .. } => {
                // Mux returns the type of its data inputs
                expr.ty.clone()
            }

            HirExprKind::Concat(_) => {
                // Concat returns array or wider integer
                expr.ty.clone()
            }

            HirExprKind::FanOut { .. } => {
                // FanOut returns array
                expr.ty.clone()
            }

            HirExprKind::Static(inner) => {
                // Static expression
                self.infer_expr(inner)
            }

            HirExprKind::Sizeof { .. } => {
                // Sizeof returns unsigned integer
                Ty::Unsigned(64)
            }

            HirExprKind::Lambda(lambda) => {
                // Infer lambda type
                let param_types: Vec<_> = lambda.params.iter().map(|p| p.ty.clone()).collect();

                // Push parameters to local scope
                for param in &lambda.params {
                    self.local_types.insert(param.def_id, param.ty.clone());
                }

                // Check body
                self.check_block(&lambda.body);

                // Infer return type
                let return_ty = lambda.return_ty.clone().unwrap_or(Ty::Void);

                Ty::Function {
                    kind: crate::FunctionKind::Lambda,
                    attrs: vec![],
                    return_ty: Box::new(return_ty),
                    params: param_types
                        .into_iter()
                        .map(|ty| TyFuncParam {
                            attrs: vec![],
                            ty,
                            name: None,
                        })
                        .collect(),
                }
            }

            HirExprKind::EnumValue { enum_ty, .. } => {
                // Enum value type
                enum_ty.clone()
            }

            // Use declared type for other expressions
            _ => expr.ty.clone(),
        }
    }

    fn infer_binary_op(&mut self, op: HirBinaryOp, left: &Ty, right: &Ty, span: Span) -> Ty {
        // Error propagation
        if left.is_error() {
            return left.clone();
        }
        if right.is_error() {
            return right.clone();
        }

        match op {
            // Arithmetic - result is numeric type
            HirBinaryOp::Add | HirBinaryOp::Sub | HirBinaryOp::Mul | HirBinaryOp::Div | HirBinaryOp::Mod => {
                if (left.is_int() || left.is_float()) && (right.is_int() || right.is_float()) {
                    // Promote to common type
                    self.promote_numeric(left, right)
                } else if left.is_string() && right.is_string() && op == HirBinaryOp::Add {
                    // String concatenation
                    Ty::String
                } else {
                    self.errors.push(TypeError::InvalidOperation {
                        op: format!("{:?}", op),
                        ty: left.clone(),
                        span,
                    });
                    Ty::Error("invalid arithmetic operation".to_string())
                }
            }

            // Bitwise - result is integer type
            HirBinaryOp::BitwiseAnd | HirBinaryOp::BitwiseOr | HirBinaryOp::BitwiseXor | HirBinaryOp::Shl | HirBinaryOp::Shr => {
                if left.is_int() && right.is_int() {
                    self.promote_numeric(left, right)
                } else {
                    self.errors.push(TypeError::InvalidOperation {
                        op: format!("{:?}", op),
                        ty: left.clone(),
                        span,
                    });
                    Ty::Error("invalid bitwise operation".to_string())
                }
            }

            // Comparison - result is bool
            HirBinaryOp::Eq | HirBinaryOp::Ne | HirBinaryOp::Lt | HirBinaryOp::Le | HirBinaryOp::Gt | HirBinaryOp::Ge => Ty::Bool,

            // Logical - operands must be bool, result is bool
            HirBinaryOp::LogicalAnd | HirBinaryOp::LogicalOr | HirBinaryOp::LogicalXor => {
                if !matches!(left, Ty::Bool | Ty::Auto | Ty::Unresolved) {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: left.clone(),
                        span,
                        context: "logical operation".to_string(),
                    });
                }
                if !matches!(right, Ty::Bool | Ty::Auto | Ty::Unresolved) {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: right.clone(),
                        span,
                        context: "logical operation".to_string(),
                    });
                }
                Ty::Bool
            }
        }
    }

    fn infer_unary_op(&mut self, op: HirUnaryOp, operand: &Ty, span: Span) -> Ty {
        if operand.is_error() {
            return operand.clone();
        }

        match op {
            HirUnaryOp::Neg => {
                if operand.is_int() || operand.is_float() {
                    operand.clone()
                } else {
                    self.errors.push(TypeError::InvalidOperation {
                        op: format!("{:?}", op),
                        ty: operand.clone(),
                        span,
                    });
                    Ty::Error("invalid negation".to_string())
                }
            }

            HirUnaryOp::Not => {
                if matches!(operand, Ty::Bool | Ty::Auto | Ty::Unresolved) {
                    Ty::Bool
                } else {
                    self.errors.push(TypeError::Mismatch {
                        expected: Ty::Bool,
                        found: operand.clone(),
                        span,
                        context: "logical not".to_string(),
                    });
                    Ty::Bool
                }
            }

            HirUnaryOp::Invert => {
                if operand.is_int() {
                    operand.clone()
                } else {
                    self.errors.push(TypeError::InvalidOperation {
                        op: "bitwise invert".to_string(),
                        ty: operand.clone(),
                        span,
                    });
                    Ty::Error("invalid bitwise invert".to_string())
                }
            }

            HirUnaryOp::PreInc | HirUnaryOp::PreDec | HirUnaryOp::PostInc | HirUnaryOp::PostDec => {
                if operand.is_int() {
                    operand.clone()
                } else {
                    self.errors.push(TypeError::InvalidOperation {
                        op: format!("{:?}", op),
                        ty: operand.clone(),
                        span,
                    });
                    Ty::Error("invalid increment/decrement".to_string())
                }
            }
        }
    }

    fn check_call(&mut self, callee_ty: &Ty, args: &[HirExpr], span: Span) -> Ty {
        match callee_ty {
            Ty::Function {
                return_ty, params, ..
            } => {
                // Check argument count
                if args.len() != params.len() {
                    self.errors.push(TypeError::ArgCountMismatch {
                        expected: params.len(),
                        found: args.len(),
                        span,
                    });
                }

                // Check argument types
                for (arg, param) in args.iter().zip(params.iter()) {
                    let arg_ty = self.infer_expr(arg);
                    if !types_compatible(&arg_ty, &param.ty) {
                        self.errors.push(TypeError::Mismatch {
                            expected: param.ty.clone(),
                            found: arg_ty,
                            span: arg.span,
                            context: "function argument".to_string(),
                        });
                    }
                }

                (**return_ty).clone()
            }

            // Intrinsics and unresolved callees
            Ty::Auto | Ty::Unresolved | Ty::Undefined => {
                // Infer argument types but return unknown
                for arg in args {
                    self.infer_expr(arg);
                }
                Ty::Auto
            }

            Ty::Error(e) => Ty::Error(e.clone()),

            _ => {
                self.errors.push(TypeError::NotAFunction {
                    ty: callee_ty.clone(),
                    span,
                });
                Ty::Error("not a function".to_string())
            }
        }
    }

    fn infer_member_access(&mut self, obj_ty: &Ty, member: &str, span: Span) -> Ty {
        match obj_ty {
            Ty::Struct { fields, .. } | Ty::Class { fields, .. } | Ty::Union { fields, .. } => {
                for (name, ty) in fields {
                    if name == member {
                        return ty.clone();
                    }
                }
                self.errors.push(TypeError::InvalidMember {
                    ty: obj_ty.clone(),
                    member: member.to_string(),
                    span,
                });
                Ty::Error(format!("no member '{}'", member))
            }

            Ty::Enum { .. } => {
                // Enum variant access
                obj_ty.clone()
            }

            Ty::Const(inner) => self.infer_member_access(inner, member, span),

            Ty::Instance { template, .. } => self.infer_member_access(template, member, span),

            Ty::Auto | Ty::Unresolved | Ty::Undefined => {
                // Unknown type - can't check member
                Ty::Auto
            }

            Ty::Error(e) => Ty::Error(e.clone()),

            _ => {
                self.errors.push(TypeError::InvalidMember {
                    ty: obj_ty.clone(),
                    member: member.to_string(),
                    span,
                });
                Ty::Error(format!("cannot access member on {:?}", obj_ty))
            }
        }
    }

    fn infer_subscript(&mut self, arr_ty: &Ty, idx_ty: &Ty, span: Span) -> Ty {
        // Check index is integer
        if !idx_ty.is_int() && !matches!(idx_ty, Ty::Auto | Ty::Unresolved | Ty::Error(_)) {
            self.errors.push(TypeError::Mismatch {
                expected: Ty::Signed(32),
                found: idx_ty.clone(),
                span,
                context: "array index".to_string(),
            });
        }

        match arr_ty {
            Ty::Array { element, .. } => (**element).clone(),

            Ty::Const(inner) => self.infer_subscript(inner, idx_ty, span),

            Ty::Instance { template, .. } => self.infer_subscript(template, idx_ty, span),

            Ty::Auto | Ty::Unresolved | Ty::Undefined => Ty::Auto,

            Ty::Error(e) => Ty::Error(e.clone()),

            _ => {
                self.errors.push(TypeError::InvalidSubscript {
                    ty: arr_ty.clone(),
                    span,
                });
                Ty::Error("cannot subscript".to_string())
            }
        }
    }

    fn promote_numeric(&self, a: &Ty, b: &Ty) -> Ty {
        // Numeric type promotion rules
        match (a, b) {
            (Ty::Float, _) | (_, Ty::Float) => Ty::Float,

            (Ty::Signed(w1), Ty::Signed(w2)) => Ty::Signed((*w1).max(*w2)),
            (Ty::Unsigned(w1), Ty::Unsigned(w2)) => Ty::Unsigned((*w1).max(*w2)),

            // Mixed signed/unsigned - use signed with larger width
            (Ty::Signed(w1), Ty::Unsigned(w2)) | (Ty::Unsigned(w2), Ty::Signed(w1)) => {
                let max_w = (*w1).max(*w2);
                Ty::Signed(if max_w < 64 { max_w * 2 } else { max_w })
            }

            (Ty::Const(inner), other) => self.promote_numeric(inner.unconst(), other),
            (other, Ty::Const(inner)) => self.promote_numeric(other, inner.unconst()),

            // Default
            _ => a.clone(),
        }
    }

    /// Finalize type inference and get the result.
    pub fn finalize(self) -> InferenceResult {
        InferenceResult {
            expr_types: self.expr_types,
            local_types: self.local_types,
            errors: self.errors,
            substitution: self.unifier.into_substitution(),
        }
    }
}

/// Type check an entire file.
pub fn type_check_file(file: &crate::HirFile, symbols: &SymbolTable) -> Vec<InferenceResult> {
    let mut results = Vec::new();

    for item in &file.items {
        if let HirItem::Function(func) = item {
            let mut checker = TypeChecker::new(symbols);
            results.push(checker.check_function(func));
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_type_unifier_fresh() {
        let mut unifier = TypeUnifier::new();
        let v1 = unifier.fresh();
        let v2 = unifier.fresh();
        assert_ne!(v1, v2);
    }

    #[test]
    fn test_type_unifier_bind() {
        let mut unifier = TypeUnifier::new();
        let v = unifier.fresh();
        unifier.bind(v, Ty::Signed(32)).unwrap();
        assert_eq!(unifier.probe(v), Some(Ty::Signed(32)));
    }

    #[test]
    fn test_type_unifier_unify() {
        let mut unifier = TypeUnifier::new();
        let v1 = unifier.fresh();
        let v2 = unifier.fresh();
        unifier.bind(v1, Ty::Signed(32)).unwrap();
        unifier.unify_vars(v1, v2).unwrap();
        assert_eq!(unifier.probe(v2), Some(Ty::Signed(32)));
    }

    #[test]
    fn test_types_compatible() {
        assert!(types_compatible(&Ty::Signed(32), &Ty::Signed(32)));
        assert!(!types_compatible(&Ty::Signed(32), &Ty::Unsigned(32)));
        assert!(types_compatible(&Ty::Auto, &Ty::Signed(32)));
        assert!(types_compatible(
            &Ty::Error("test".to_string()),
            &Ty::Signed(32)
        ));
    }

    #[test]
    fn test_substitution_apply() {
        let mut subst = Substitution::new();
        subst.insert(TypeVarId(0), Ty::Signed(32));

        // When a type variable is resolved, we get the resolved type directly
        let ty = Ty::Dependent(Box::new(Ty::Signed(0)));
        let resolved = subst.apply(&ty);
        assert_eq!(resolved, Ty::Signed(32));
    }
}
