//! Template instantiation and argument deduction.
//!
//! This module handles:
//! - Template argument deduction from call sites
//! - Template instantiation (substitution of type parameters)
//! - Auto type resolution through template instantiation

use crate::{
    consteval::{ConstEvaluator, ConstValue},
    typeck::types_compatible,
    HirBlock, HirClass, HirExpr, HirExprKind, HirFunction, HirItem, HirParam, HirStmt,
    HirStruct, HirTemplate, HirTemplateParam, Span, Ty, TyArg, TyAttr, TyFuncParam,
};
use std::collections::HashMap;

/// Maximum template instantiation depth to prevent infinite recursion.
pub const MAX_TEMPLATE_DEPTH: u32 = 128;

/// Template instantiation errors.
#[derive(Debug, Clone)]
pub enum TemplateError {
    /// Recursion depth exceeded.
    RecursionLimit {
        template: String,
        depth: u32,
    },
    /// Argument count mismatch.
    ArgCountMismatch {
        expected: usize,
        got: usize,
        template: String,
    },
    /// Type argument required but not provided.
    MissingTypeArg {
        param: String,
        template: String,
    },
    /// Value argument required but not provided.
    MissingValueArg {
        param: String,
        template: String,
    },
    /// Cannot deduce template argument.
    CouldNotDeduce {
        param: String,
        template: String,
        suggestion: String,
    },
    /// Type mismatch during deduction.
    DeductionMismatch {
        param: String,
        expected: Ty,
        found: Ty,
    },
    /// Template not found.
    NotFound {
        name: String,
    },
    /// Unsupported template kind.
    UnsupportedTemplateKind {
        kind: String,
    },
    /// Constraint violation.
    ConstraintViolation {
        constraint: String,
        ty: Ty,
    },
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemplateError::RecursionLimit { template, depth } => {
                write!(
                    f,
                    "template recursion limit ({}) exceeded for '{}'",
                    depth, template
                )
            }
            TemplateError::ArgCountMismatch {
                expected,
                got,
                template,
            } => {
                write!(
                    f,
                    "template '{}' expects {} arguments, got {}",
                    template, expected, got
                )
            }
            TemplateError::MissingTypeArg { param, template } => {
                write!(
                    f,
                    "missing type argument '{}' for template '{}'",
                    param, template
                )
            }
            TemplateError::MissingValueArg { param, template } => {
                write!(
                    f,
                    "missing value argument '{}' for template '{}'",
                    param, template
                )
            }
            TemplateError::CouldNotDeduce {
                param,
                template,
                suggestion,
            } => {
                write!(
                    f,
                    "could not deduce template argument '{}' for '{}'. {}",
                    param, template, suggestion
                )
            }
            TemplateError::DeductionMismatch {
                param,
                expected,
                found,
            } => {
                write!(
                    f,
                    "conflicting deduction for '{}': expected {:?}, found {:?}",
                    param, expected, found
                )
            }
            TemplateError::NotFound { name } => {
                write!(f, "template '{}' not found", name)
            }
            TemplateError::UnsupportedTemplateKind { kind } => {
                write!(f, "unsupported template kind: {}", kind)
            }
            TemplateError::ConstraintViolation { constraint, ty } => {
                write!(f, "type {:?} does not satisfy constraint '{}'", ty, constraint)
            }
        }
    }
}

/// Template arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateArgs {
    /// Type arguments.
    pub type_args: Vec<Ty>,
    /// Value arguments.
    pub value_args: Vec<ConstValue>,
}

impl TemplateArgs {
    /// Create empty template arguments.
    pub fn new() -> Self {
        Self {
            type_args: Vec::new(),
            value_args: Vec::new(),
        }
    }

    /// Create template arguments from type and value lists.
    pub fn from_args(type_args: Vec<Ty>, value_args: Vec<ConstValue>) -> Self {
        Self {
            type_args,
            value_args,
        }
    }

    /// Check if arguments are empty.
    pub fn is_empty(&self) -> bool {
        self.type_args.is_empty() && self.value_args.is_empty()
    }

    /// Create a string key for caching.
    pub fn cache_key(&self) -> String {
        format!("{:?}", self)
    }
}

impl Default for TemplateArgs {
    fn default() -> Self {
        Self::new()
    }
}

/// Type substitution for template instantiation.
#[derive(Debug, Clone, Default)]
pub struct TemplateSubstitution {
    /// Type parameter substitutions.
    type_map: HashMap<String, Ty>,
    /// Value parameter substitutions.
    value_map: HashMap<String, ConstValue>,
}

impl TemplateSubstitution {
    /// Create a new empty substitution.
    pub fn new() -> Self {
        Self {
            type_map: HashMap::new(),
            value_map: HashMap::new(),
        }
    }

    /// Insert a type substitution.
    pub fn insert_type(&mut self, name: String, ty: Ty) {
        self.type_map.insert(name, ty);
    }

    /// Insert a value substitution.
    pub fn insert_value(&mut self, name: String, value: ConstValue) {
        self.value_map.insert(name, value);
    }

    /// Get a type substitution.
    pub fn get_type(&self, name: &str) -> Option<&Ty> {
        self.type_map.get(name)
    }

    /// Get a value substitution.
    pub fn get_value(&self, name: &str) -> Option<&ConstValue> {
        self.value_map.get(name)
    }

    /// Apply substitution to a type.
    pub fn apply_type(&self, ty: &Ty) -> Ty {
        match ty {
            // Type parameter reference (using Reference as a stand-in)
            Ty::Reference(path) if path.len() == 1 => {
                if let Some(subst) = self.type_map.get(&path[0]) {
                    return subst.clone();
                }
                ty.clone()
            }

            // Auto type might be resolved through substitution context
            Ty::Auto => ty.clone(),

            // Template placeholder
            Ty::Template => ty.clone(),

            // Recursive application
            Ty::Const(inner) => Ty::Const(Box::new(self.apply_type(inner))),

            Ty::Dependent(inner) => Ty::Dependent(Box::new(self.apply_type(inner))),

            Ty::Type(inner) => Ty::Type(Box::new(self.apply_type(inner))),

            Ty::Array {
                attrs,
                element,
                dims,
            } => Ty::Array {
                attrs: attrs.clone(),
                element: Box::new(self.apply_type(element)),
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
                return_ty: Box::new(self.apply_type(return_ty)),
                params: params
                    .iter()
                    .map(|p| TyFuncParam {
                        attrs: p.attrs.clone(),
                        ty: self.apply_type(&p.ty),
                        name: p.name.clone(),
                    })
                    .collect(),
            },

            Ty::Closure {
                function,
                func_ty,
                capture_ty,
                qualified_name,
            } => Ty::Closure {
                function: function.clone(),
                func_ty: Box::new(self.apply_type(func_ty)),
                capture_ty: Box::new(self.apply_type(capture_ty)),
                qualified_name: qualified_name.clone(),
            },

            Ty::Instance {
                template,
                name,
                args,
            } => {
                let new_args: Vec<(String, TyArg)> = args
                    .iter()
                    .map(|(n, arg)| {
                        let new_arg = match arg {
                            TyArg::Type(t) => TyArg::Type(self.apply_type(t)),
                            TyArg::Named { ty, name } => TyArg::Named {
                                ty: self.apply_type(ty),
                                name: name.clone(),
                            },
                            other => other.clone(),
                        };
                        (n.clone(), new_arg)
                    })
                    .collect();
                Ty::Instance {
                    template: Box::new(self.apply_type(template)),
                    name: name.clone(),
                    args: new_args,
                }
            }

            Ty::Struct { name, fields } => Ty::Struct {
                name: name.clone(),
                fields: fields
                    .iter()
                    .map(|(n, t)| (n.clone(), self.apply_type(t)))
                    .collect(),
            },

            Ty::Class { name, fields } => Ty::Class {
                name: name.clone(),
                fields: fields
                    .iter()
                    .map(|(n, t)| (n.clone(), self.apply_type(t)))
                    .collect(),
            },

            Ty::Union { name, fields } => Ty::Union {
                name: name.clone(),
                fields: fields
                    .iter()
                    .map(|(n, t)| (n.clone(), self.apply_type(t)))
                    .collect(),
            },

            Ty::Enum { name, base } => Ty::Enum {
                name: name.clone(),
                base: Box::new(self.apply_type(base)),
            },

            Ty::Initializer(types) => {
                Ty::Initializer(types.iter().map(|t| self.apply_type(t)).collect())
            }

            Ty::Designator { name, ty } => Ty::Designator {
                name: name.clone(),
                ty: Box::new(self.apply_type(ty)),
            },

            Ty::Positional { index, ty } => Ty::Positional {
                index: *index,
                ty: Box::new(self.apply_type(ty)),
            },

            // Primitive types pass through
            other => other.clone(),
        }
    }
}

/// Helper to get template parameter info.
fn get_template_param_info(param: &HirTemplateParam) -> (String, bool, Option<Ty>, Option<HirExpr>) {
    match param {
        HirTemplateParam::Type { name, default, .. } => {
            (name.clone(), true, default.clone(), None)
        }
        HirTemplateParam::NonType { name, default, .. } => {
            (name.clone(), false, None, default.clone())
        }
    }
}

/// Template argument deduction context.
pub struct TemplateDeducer {
    /// Deduced type arguments by parameter name.
    deduced_types: HashMap<String, Ty>,
    /// Deduced value arguments by parameter name.
    deduced_values: HashMap<String, ConstValue>,
    /// Errors during deduction.
    errors: Vec<TemplateError>,
}

impl TemplateDeducer {
    /// Create a new deducer.
    pub fn new() -> Self {
        Self {
            deduced_types: HashMap::new(),
            deduced_values: HashMap::new(),
            errors: Vec::new(),
        }
    }

    /// Deduce template arguments from a function call.
    pub fn deduce_from_call(
        &mut self,
        template: &HirTemplate,
        call_arg_types: &[Ty],
    ) -> Result<TemplateArgs, Vec<TemplateError>> {
        // Get the function inside the template
        let func = match &*template.item {
            HirItem::Function(f) => f,
            _ => {
                self.errors.push(TemplateError::UnsupportedTemplateKind {
                    kind: "non-function".to_string(),
                });
                return Err(std::mem::take(&mut self.errors));
            }
        };

        // Match call argument types against parameter types
        for (param, arg_ty) in func.params.iter().zip(call_arg_types) {
            self.unify_for_deduction(&param.ty, arg_ty, &template.params);
        }

        if !self.errors.is_empty() {
            return Err(std::mem::take(&mut self.errors));
        }

        // Build template arguments from deduced values
        let mut type_args = Vec::new();
        let mut value_args = Vec::new();

        for param in &template.params {
            let (name, is_type, default_ty, default_expr) = get_template_param_info(param);

            if is_type {
                let ty = self
                    .deduced_types
                    .get(&name)
                    .cloned()
                    .or(default_ty)
                    .unwrap_or_else(|| {
                        self.errors.push(TemplateError::CouldNotDeduce {
                            param: name.clone(),
                            template: String::new(), // Would need template name
                            suggestion: format!(
                                "try providing explicit type argument: <{} = YourType>",
                                name
                            ),
                        });
                        Ty::Error("could not deduce".to_string())
                    });
                type_args.push(ty);
            } else {
                let val = self
                    .deduced_values
                    .get(&name)
                    .cloned()
                    .or_else(|| {
                        if let Some(default) = default_expr {
                            let eval = ConstEvaluator::new();
                            let v = eval.eval(&default);
                            if v.is_const() {
                                return Some(v);
                            }
                        }
                        None
                    })
                    .unwrap_or_else(|| {
                        self.errors.push(TemplateError::MissingValueArg {
                            param: name.clone(),
                            template: String::new(),
                        });
                        ConstValue::NotConst
                    });
                value_args.push(val);
            }
        }

        if !self.errors.is_empty() {
            return Err(std::mem::take(&mut self.errors));
        }

        Ok(TemplateArgs::from_args(type_args, value_args))
    }

    /// Unify a parameter type with an argument type to deduce template parameters.
    fn unify_for_deduction(&mut self, param_ty: &Ty, arg_ty: &Ty, params: &[HirTemplateParam]) {
        match (param_ty, arg_ty) {
            // If param is a type parameter (auto), try to bind it
            (Ty::Auto, _) => {
                // Auto could be any type parameter - simplified
            }

            // Reference to a type parameter
            (Ty::Reference(path), arg) if path.len() == 1 => {
                let param_name = &path[0];
                if params.iter().any(|p| {
                    matches!(p, HirTemplateParam::Type { name, .. } if name == param_name)
                }) {
                    if let Some(existing) = self.deduced_types.get(param_name) {
                        if !types_compatible(existing, arg) {
                            self.errors.push(TemplateError::DeductionMismatch {
                                param: param_name.clone(),
                                expected: existing.clone(),
                                found: arg.clone(),
                            });
                        }
                    } else {
                        self.deduced_types.insert(param_name.clone(), arg.clone());
                    }
                }
            }

            // Recursive unification for compound types
            (Ty::Const(p), Ty::Const(a)) => {
                self.unify_for_deduction(p, a, params);
            }
            (Ty::Const(p), a) => {
                self.unify_for_deduction(p, a, params);
            }
            (p, Ty::Const(a)) => {
                self.unify_for_deduction(p, a, params);
            }

            (
                Ty::Array {
                    element: p_elem, ..
                },
                Ty::Array {
                    element: a_elem, ..
                },
            ) => {
                self.unify_for_deduction(p_elem, a_elem, params);
            }

            (
                Ty::Function {
                    return_ty: p_ret,
                    params: p_params,
                    ..
                },
                Ty::Function {
                    return_ty: a_ret,
                    params: a_params,
                    ..
                },
            ) => {
                self.unify_for_deduction(p_ret, a_ret, params);
                for (pp, ap) in p_params.iter().zip(a_params.iter()) {
                    self.unify_for_deduction(&pp.ty, &ap.ty, params);
                }
            }

            // Same concrete types - nothing to deduce
            _ => {}
        }
    }
}

impl Default for TemplateDeducer {
    fn default() -> Self {
        Self::new()
    }
}

/// Template instantiator.
pub struct TemplateInstantiator {
    /// Current instantiation depth.
    depth: u32,
    /// Maximum depth.
    max_depth: u32,
    /// Cache of instantiations (using string key since Ty doesn't implement Hash).
    cache: HashMap<String, HirItem>,
    /// Instantiation trace for error reporting.
    trace: Vec<(String, TemplateArgs, Span)>,
}

impl TemplateInstantiator {
    /// Create a new instantiator.
    pub fn new() -> Self {
        Self {
            depth: 0,
            max_depth: MAX_TEMPLATE_DEPTH,
            cache: HashMap::new(),
            trace: Vec::new(),
        }
    }

    /// Set the maximum instantiation depth.
    pub fn with_max_depth(mut self, depth: u32) -> Self {
        self.max_depth = depth;
        self
    }

    /// Instantiate a template with the given arguments.
    pub fn instantiate(
        &mut self,
        template: &HirTemplate,
        args: &TemplateArgs,
        span: Span,
    ) -> Result<HirItem, TemplateError> {
        let cache_key = format!("{}#{}", template.def_id.0, args.cache_key());

        // Check cache
        if let Some(cached) = self.cache.get(&cache_key) {
            return Ok(cached.clone());
        }

        // Check depth
        if self.depth >= self.max_depth {
            return Err(TemplateError::RecursionLimit {
                template: String::new(), // Would need template name
                depth: self.depth,
            });
        }

        self.depth += 1;
        self.trace.push((cache_key.clone(), args.clone(), span));

        // Build substitution map
        let mut subst = TemplateSubstitution::new();

        let mut type_arg_idx = 0;
        let mut value_arg_idx = 0;

        for param in &template.params {
            let (name, is_type, default_ty, default_expr) = get_template_param_info(param);

            if is_type {
                if type_arg_idx < args.type_args.len() {
                    subst.insert_type(name, args.type_args[type_arg_idx].clone());
                    type_arg_idx += 1;
                } else if let Some(default) = default_ty {
                    subst.insert_type(name, default);
                } else {
                    return Err(TemplateError::MissingTypeArg {
                        param: name,
                        template: String::new(),
                    });
                }
            } else {
                if value_arg_idx < args.value_args.len() {
                    subst.insert_value(name, args.value_args[value_arg_idx].clone());
                    value_arg_idx += 1;
                } else if let Some(default) = default_expr {
                    let eval = ConstEvaluator::new();
                    let val = eval.eval(&default);
                    subst.insert_value(name, val);
                } else {
                    return Err(TemplateError::MissingValueArg {
                        param: name,
                        template: String::new(),
                    });
                }
            }
        }

        // Apply substitution to the template item
        let specialized = self.substitute_item(&template.item, &subst)?;

        // Cache the result
        self.cache.insert(cache_key, specialized.clone());

        self.trace.pop();
        self.depth -= 1;

        Ok(specialized)
    }

    fn substitute_item(
        &mut self,
        item: &HirItem,
        subst: &TemplateSubstitution,
    ) -> Result<HirItem, TemplateError> {
        match item {
            HirItem::Function(func) => {
                Ok(HirItem::Function(self.substitute_function(func, subst)?))
            }
            HirItem::Struct(s) => Ok(HirItem::Struct(self.substitute_struct(s, subst)?)),
            HirItem::Class(c) => Ok(HirItem::Class(self.substitute_class(c, subst)?)),
            _ => Err(TemplateError::UnsupportedTemplateKind {
                kind: format!("{:?}", std::mem::discriminant(item)),
            }),
        }
    }

    fn substitute_function(
        &mut self,
        func: &HirFunction,
        subst: &TemplateSubstitution,
    ) -> Result<HirFunction, TemplateError> {
        Ok(HirFunction {
            span: func.span,
            def_id: func.def_id,
            ty: subst.apply_type(&func.ty),
            kind: func.kind,
            attrs: func.attrs.clone(),
            modifier: func.modifier,
            return_ty: subst.apply_type(&func.return_ty),
            name: func.name.clone(),
            params: func
                .params
                .iter()
                .map(|p| HirParam {
                    span: p.span,
                    def_id: p.def_id,
                    ty: subst.apply_type(&p.ty),
                    name: p.name.clone(),
                    default: p.default.clone(),
                })
                .collect(),
            body: func
                .body
                .as_ref()
                .map(|b| self.substitute_block(b, subst)),
        })
    }

    fn substitute_struct(
        &mut self,
        s: &HirStruct,
        subst: &TemplateSubstitution,
    ) -> Result<HirStruct, TemplateError> {
        Ok(HirStruct {
            span: s.span,
            def_id: s.def_id,
            ty: subst.apply_type(&s.ty),
            name: s.name.clone(),
            members: s
                .members
                .iter()
                .map(|m| crate::HirStructMember {
                    span: m.span,
                    def_id: m.def_id,
                    ty: subst.apply_type(&m.ty),
                    name: m.name.clone(),
                    init: m.init.as_ref().map(|e| self.substitute_expr(e, subst)),
                })
                .collect(),
        })
    }

    fn substitute_class(
        &mut self,
        c: &HirClass,
        subst: &TemplateSubstitution,
    ) -> Result<HirClass, TemplateError> {
        Ok(HirClass {
            span: c.span,
            def_id: c.def_id,
            ty: subst.apply_type(&c.ty),
            name: c.name.clone(),
            members: c
                .members
                .iter()
                .map(|m| self.substitute_class_member(m, subst))
                .collect(),
        })
    }

    fn substitute_class_member(
        &mut self,
        member: &crate::HirClassMember,
        subst: &TemplateSubstitution,
    ) -> crate::HirClassMember {
        use crate::HirClassMember;

        match member {
            HirClassMember::Variable(v) => HirClassMember::Variable(crate::HirVariable {
                span: v.span,
                def_id: v.def_id,
                ty: subst.apply_type(&v.ty),
                name: v.name.clone(),
                init: v.init.as_ref().map(|e| self.substitute_expr(e, subst)),
                flags: v.flags,
            }),
            HirClassMember::Function(f) => {
                HirClassMember::Function(self.substitute_function(f, subst).unwrap_or_else(|_| f.clone()))
            }
            HirClassMember::Access(a) => HirClassMember::Access(*a),
            HirClassMember::DefaultInit(e) => HirClassMember::DefaultInit(self.substitute_expr(e, subst)),
            HirClassMember::Nested(item) => HirClassMember::Nested(item.clone()),
        }
    }

    fn substitute_block(&mut self, block: &HirBlock, subst: &TemplateSubstitution) -> HirBlock {
        HirBlock {
            stmts: block
                .stmts
                .iter()
                .map(|s| self.substitute_stmt(s, subst))
                .collect(),
            span: block.span,
        }
    }

    fn substitute_stmt(&mut self, stmt: &HirStmt, subst: &TemplateSubstitution) -> HirStmt {
        match stmt {
            HirStmt::Block(b) => HirStmt::Block(self.substitute_block(b, subst)),

            HirStmt::Return(r) => HirStmt::Return(crate::HirReturn {
                span: r.span,
                value: r.value.as_ref().map(|e| self.substitute_expr(e, subst)),
            }),

            HirStmt::VarDecl(v) => HirStmt::VarDecl(crate::HirVariable {
                span: v.span,
                def_id: v.def_id,
                ty: subst.apply_type(&v.ty),
                name: v.name.clone(),
                init: v.init.as_ref().map(|e| self.substitute_expr(e, subst)),
                flags: v.flags,
            }),

            HirStmt::Assign(a) => HirStmt::Assign(crate::HirAssign {
                op: a.op,
                lhs: self.substitute_expr(&a.lhs, subst),
                rhs: self.substitute_expr(&a.rhs, subst),
                span: a.span,
            }),

            HirStmt::If(i) => HirStmt::If(crate::HirIf {
                condition: self.substitute_expr(&i.condition, subst),
                then_branch: Box::new(self.substitute_stmt(&i.then_branch, subst)),
                else_branch: i
                    .else_branch
                    .as_ref()
                    .map(|s| Box::new(self.substitute_stmt(s, subst))),
                span: i.span,
            }),

            HirStmt::DoWhile(d) => HirStmt::DoWhile(crate::HirDoWhile {
                span: d.span,
                attrs: d.attrs.clone(),
                body: Box::new(self.substitute_stmt(&d.body, subst)),
                condition: self.substitute_expr(&d.condition, subst),
            }),

            HirStmt::RangeFor(f) => HirStmt::RangeFor(crate::HirRangeFor {
                span: f.span,
                attrs: f.attrs.clone(),
                var_ty: subst.apply_type(&f.var_ty),
                var_name: f.var_name.clone(),
                var_def_id: f.var_def_id,
                limit: self.substitute_expr(&f.limit, subst),
                body: Box::new(self.substitute_stmt(&f.body, subst)),
            }),

            HirStmt::StaticFor(f) => HirStmt::StaticFor(crate::HirStaticFor {
                span: f.span,
                var_ty: subst.apply_type(&f.var_ty),
                var_name: f.var_name.clone(),
                var_def_id: f.var_def_id,
                limit: self.substitute_expr(&f.limit, subst),
                body: Box::new(self.substitute_stmt(&f.body, subst)),
            }),

            HirStmt::UnrolledFor(f) => HirStmt::UnrolledFor(crate::HirUnrolledFor {
                span: f.span,
                var_ty: subst.apply_type(&f.var_ty),
                var_name: f.var_name.clone(),
                var_def_id: f.var_def_id,
                limit: self.substitute_expr(&f.limit, subst),
                body: Box::new(self.substitute_stmt(&f.body, subst)),
            }),

            HirStmt::Switch(s) => HirStmt::Switch(crate::HirSwitch {
                span: s.span,
                expr: self.substitute_expr(&s.expr, subst),
                cases: s
                    .cases
                    .iter()
                    .map(|c| crate::HirSwitchCase {
                        span: c.span,
                        label: match &c.label {
                            crate::HirSwitchLabel::Case(e) => {
                                crate::HirSwitchLabel::Case(self.substitute_expr(e, subst))
                            }
                            crate::HirSwitchLabel::Default => crate::HirSwitchLabel::Default,
                        },
                        stmts: c.stmts.iter().map(|st| self.substitute_stmt(st, subst)).collect(),
                    })
                    .collect(),
            }),

            HirStmt::Expr(e) => HirStmt::Expr(crate::HirExprStmt {
                span: e.span,
                expr: self.substitute_expr(&e.expr, subst),
            }),

            HirStmt::StaticIf(si) => HirStmt::StaticIf(crate::HirStaticIfStmt {
                span: si.span,
                condition: self.substitute_expr(&si.condition, subst),
                then_branch: Box::new(self.substitute_stmt(&si.then_branch, subst)),
                else_branch: si
                    .else_branch
                    .as_ref()
                    .map(|s| Box::new(self.substitute_stmt(s, subst))),
            }),

            HirStmt::Annotated(a) => HirStmt::Annotated(crate::HirAnnotated {
                span: a.span,
                attrs: a.attrs.clone(),
                stmt: Box::new(self.substitute_stmt(&a.stmt, subst)),
            }),

            // Pass through unchanged
            other => other.clone(),
        }
    }

    fn substitute_expr(&mut self, expr: &HirExpr, subst: &TemplateSubstitution) -> HirExpr {
        let kind = match &expr.kind {
            HirExprKind::Binary { op, lhs, rhs } => HirExprKind::Binary {
                op: *op,
                lhs: Box::new(self.substitute_expr(lhs, subst)),
                rhs: Box::new(self.substitute_expr(rhs, subst)),
            },

            HirExprKind::Unary { op, operand } => HirExprKind::Unary {
                op: *op,
                operand: Box::new(self.substitute_expr(operand, subst)),
            },

            HirExprKind::Call { callee, args, attrs } => HirExprKind::Call {
                callee: Box::new(self.substitute_expr(callee, subst)),
                args: args.iter().map(|a| self.substitute_expr(a, subst)).collect(),
                attrs: attrs.clone(),
            },

            HirExprKind::Member { object, member, member_def_id } => HirExprKind::Member {
                object: Box::new(self.substitute_expr(object, subst)),
                member: member.clone(),
                member_def_id: *member_def_id,
            },

            HirExprKind::Subscript { array, index } => HirExprKind::Subscript {
                array: Box::new(self.substitute_expr(array, subst)),
                index: Box::new(self.substitute_expr(index, subst)),
            },

            HirExprKind::Cast { ty, expr } => HirExprKind::Cast {
                ty: subst.apply_type(ty),
                expr: Box::new(self.substitute_expr(expr, subst)),
            },

            HirExprKind::Ternary {
                condition,
                then_expr,
                else_expr,
            } => HirExprKind::Ternary {
                condition: Box::new(self.substitute_expr(condition, subst)),
                then_expr: Box::new(self.substitute_expr(then_expr, subst)),
                else_expr: Box::new(self.substitute_expr(else_expr, subst)),
            },

            HirExprKind::Paren(inner) => {
                HirExprKind::Paren(Box::new(self.substitute_expr(inner, subst)))
            }

            HirExprKind::InitializerList(elems) => HirExprKind::InitializerList(
                elems.iter().map(|e| self.substitute_expr(e, subst)).collect(),
            ),

            HirExprKind::DesignatedInitializer(designators) => HirExprKind::DesignatedInitializer(
                designators
                    .iter()
                    .map(|(name, val)| (name.clone(), self.substitute_expr(val, subst)))
                    .collect(),
            ),

            HirExprKind::Static(inner) => {
                HirExprKind::Static(Box::new(self.substitute_expr(inner, subst)))
            }

            HirExprKind::Lambda(lambda) => {
                let new_lambda = crate::HirLambda {
                    span: lambda.span,
                    def_id: lambda.def_id,
                    captures: lambda.captures.clone(),
                    params: lambda
                        .params
                        .iter()
                        .map(|p| HirParam {
                            span: p.span,
                            def_id: p.def_id,
                            ty: subst.apply_type(&p.ty),
                            name: p.name.clone(),
                            default: p.default.clone(),
                        })
                        .collect(),
                    return_ty: lambda.return_ty.as_ref().map(|t| subst.apply_type(t)),
                    body: self.substitute_block(&lambda.body, subst),
                };
                HirExprKind::Lambda(Box::new(new_lambda))
            }

            // Pass through unchanged
            other => other.clone(),
        };

        HirExpr {
            kind,
            ty: subst.apply_type(&expr.ty),
            span: expr.span,
        }
    }

    /// Get the instantiation trace for error reporting.
    pub fn get_trace(&self) -> &[(String, TemplateArgs, Span)] {
        &self.trace
    }

    /// Format the trace for error messages.
    pub fn format_trace(&self) -> String {
        let mut s = String::from("instantiation trace:\n");
        for (i, (name, args, span)) in self.trace.iter().enumerate().take(10) {
            let args_str = format!("{:?}", args);
            s.push_str(&format!(
                "  {}. {}<{}> at {}..{}\n",
                i + 1,
                name,
                args_str,
                span.start,
                span.end
            ));
        }
        if self.trace.len() > 10 {
            s.push_str(&format!("  ... ({} more)\n", self.trace.len() - 10));
        }
        s
    }
}

impl Default for TemplateInstantiator {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve auto types in a function by analyzing usage.
pub fn resolve_auto_types(func: &mut HirFunction, _symbols: &crate::SymbolTable) {
    // This is a simplified auto resolution - full impl would use type inference
    for param in &mut func.params {
        if matches!(param.ty, Ty::Auto) {
            // Try to infer from default value or usage
            if let Some(default) = &param.default {
                let eval = ConstEvaluator::new();
                let val = eval.eval(default);
                match val {
                    ConstValue::Int { width, signed, .. } => {
                        param.ty = if signed {
                            Ty::Signed(width)
                        } else {
                            Ty::Unsigned(width)
                        };
                    }
                    ConstValue::Bool(_) => param.ty = Ty::Bool,
                    ConstValue::String(_) => param.ty = Ty::String,
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_template_args_empty() {
        let args = TemplateArgs::new();
        assert!(args.is_empty());
    }

    #[test]
    fn test_template_args_from_args() {
        let args = TemplateArgs::from_args(
            vec![Ty::Signed(32)],
            vec![ConstValue::signed(42, 64)],
        );
        assert!(!args.is_empty());
        assert_eq!(args.type_args.len(), 1);
        assert_eq!(args.value_args.len(), 1);
    }

    #[test]
    fn test_template_substitution() {
        let mut subst = TemplateSubstitution::new();
        subst.insert_type("T".to_string(), Ty::Signed(32));

        let ty = Ty::Reference(vec!["T".to_string()]);
        let result = subst.apply_type(&ty);
        assert_eq!(result, Ty::Signed(32));
    }

    #[test]
    fn test_template_substitution_array() {
        let mut subst = TemplateSubstitution::new();
        subst.insert_type("T".to_string(), Ty::Unsigned(8));

        let ty = Ty::Array {
            attrs: vec![],
            element: Box::new(Ty::Reference(vec!["T".to_string()])),
            dims: vec![10],
        };
        let result = subst.apply_type(&ty);

        match result {
            Ty::Array { element, .. } => {
                assert_eq!(*element, Ty::Unsigned(8));
            }
            _ => panic!("Expected array type"),
        }
    }
}
