//! Name resolution for HIR.
//!
//! This module provides utilities for resolving names after HIR lowering,
//! though much of the resolution happens during lowering itself.

use crate::hir::*;
use crate::symbol::SymbolTable;
use crate::ty::Ty;

/// Errors that can occur during name resolution.
#[derive(Debug, Clone)]
pub enum ResolveError {
    /// Undefined symbol.
    UndefinedSymbol { name: String, span: crate::Span },
    /// Duplicate definition.
    DuplicateDefinition { name: String, first: crate::Span, second: crate::Span },
    /// Type mismatch.
    TypeMismatch { expected: Ty, found: Ty, span: crate::Span },
    /// Invalid operation.
    InvalidOperation { message: String, span: crate::Span },
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::UndefinedSymbol { name, .. } => {
                write!(f, "undefined symbol: {}", name)
            }
            ResolveError::DuplicateDefinition { name, .. } => {
                write!(f, "duplicate definition: {}", name)
            }
            ResolveError::TypeMismatch { expected, found, .. } => {
                write!(f, "type mismatch: expected {:?}, found {:?}", expected, found)
            }
            ResolveError::InvalidOperation { message, .. } => {
                write!(f, "invalid operation: {}", message)
            }
        }
    }
}

impl std::error::Error for ResolveError {}

/// Result type for resolution operations.
pub type ResolveResult<T> = Result<T, ResolveError>;

/// Perform additional resolution passes on a HIR file.
///
/// This is called after initial lowering to resolve any remaining
/// unresolved references and perform validation.
pub fn resolve(file: &mut HirFile, symbols: &mut SymbolTable) -> Result<(), Vec<ResolveError>> {
    let mut resolver = Resolver::new(symbols);
    resolver.resolve_file(file);

    if resolver.errors.is_empty() {
        Ok(())
    } else {
        Err(resolver.errors)
    }
}

/// Name resolver.
struct Resolver<'a> {
    symbols: &'a mut SymbolTable,
    errors: Vec<ResolveError>,
}

impl<'a> Resolver<'a> {
    fn new(symbols: &'a mut SymbolTable) -> Self {
        Self {
            symbols,
            errors: Vec::new(),
        }
    }

    fn resolve_file(&mut self, file: &mut HirFile) {
        for item in &mut file.items {
            self.resolve_item(item);
        }
    }

    fn resolve_item(&mut self, item: &mut HirItem) {
        match item {
            HirItem::Function(func) => self.resolve_function(func),
            HirItem::Variable(var) => self.resolve_variable(var),
            HirItem::Struct(s) => self.resolve_struct(s),
            HirItem::Enum(e) => self.resolve_enum(e),
            HirItem::Class(c) => self.resolve_class(c),
            HirItem::Union(u) => self.resolve_union(u),
            HirItem::Using(u) => self.resolve_using(u),
            HirItem::Template(t) => self.resolve_template(t),
            HirItem::StaticIf(si) => self.resolve_static_if_decl(si),
            HirItem::StaticAssert(sa) => self.resolve_static_assert(sa),
            HirItem::Extern(e) => self.resolve_extern(e),
            HirItem::Export(e) => self.resolve_export(e),
        }
    }

    fn resolve_function(&mut self, func: &mut HirFunction) {
        // Resolve parameter types and default values
        for param in &mut func.params {
            self.resolve_type(&mut param.ty);
            if let Some(default) = &mut param.default {
                self.resolve_expr(default);
            }
        }

        // Resolve return type
        self.resolve_type(&mut func.return_ty);

        // Resolve body
        if let Some(body) = &mut func.body {
            self.resolve_block(body);
        }
    }

    fn resolve_variable(&mut self, var: &mut HirVariable) {
        self.resolve_type(&mut var.ty);
        if let Some(init) = &mut var.init {
            self.resolve_expr(init);
        }
    }

    fn resolve_struct(&mut self, s: &mut HirStruct) {
        for member in &mut s.members {
            self.resolve_type(&mut member.ty);
            if let Some(init) = &mut member.init {
                self.resolve_expr(init);
            }
        }
    }

    fn resolve_enum(&mut self, e: &mut HirEnum) {
        self.resolve_type(&mut e.base_ty);
        for variant in &mut e.variants {
            if let Some(value) = &mut variant.value {
                self.resolve_expr(value);
            }
        }
    }

    fn resolve_class(&mut self, c: &mut HirClass) {
        for member in &mut c.members {
            match member {
                HirClassMember::Variable(v) => self.resolve_variable(v),
                HirClassMember::Function(f) => self.resolve_function(f),
                HirClassMember::DefaultInit(e) => self.resolve_expr(e),
                HirClassMember::Nested(item) => self.resolve_item(item),
                HirClassMember::Access(_) => {}
            }
        }
    }

    fn resolve_union(&mut self, u: &mut HirUnion) {
        for member in &mut u.members {
            self.resolve_type(&mut member.ty);
            if let Some(init) = &mut member.init {
                self.resolve_expr(init);
            }
        }
    }

    fn resolve_using(&mut self, u: &mut HirUsing) {
        self.resolve_type(&mut u.ty);
    }

    fn resolve_template(&mut self, t: &mut HirTemplate) {
        for param in &mut t.params {
            match param {
                HirTemplateParam::Type { default, .. } => {
                    if let Some(ty) = default {
                        self.resolve_type(ty);
                    }
                }
                HirTemplateParam::NonType { ty, default, .. } => {
                    self.resolve_type(ty);
                    if let Some(expr) = default {
                        self.resolve_expr(expr);
                    }
                }
            }
        }
        self.resolve_item(&mut t.item);
    }

    fn resolve_static_if_decl(&mut self, si: &mut HirStaticIf) {
        self.resolve_expr(&mut si.condition);
        self.resolve_item(&mut si.then_item);
        if let Some(else_item) = &mut si.else_item {
            self.resolve_item(else_item);
        }
    }

    fn resolve_static_assert(&mut self, sa: &mut HirStaticAssert) {
        self.resolve_expr(&mut sa.condition);
    }

    fn resolve_extern(&mut self, e: &mut HirExtern) {
        self.resolve_type(&mut e.extern_type);
    }

    fn resolve_export(&mut self, e: &mut HirExport2) {
        self.resolve_type(&mut e.exported_type);
    }

    fn resolve_block(&mut self, block: &mut HirBlock) {
        for stmt in &mut block.stmts {
            self.resolve_stmt(stmt);
        }
    }

    fn resolve_stmt(&mut self, stmt: &mut HirStmt) {
        match stmt {
            HirStmt::Block(b) => self.resolve_block(b),
            HirStmt::Return(r) => {
                if let Some(value) = &mut r.value {
                    self.resolve_expr(value);
                }
            }
            HirStmt::If(i) => {
                self.resolve_expr(&mut i.condition);
                self.resolve_stmt(&mut i.then_branch);
                if let Some(else_branch) = &mut i.else_branch {
                    self.resolve_stmt(else_branch);
                }
            }
            HirStmt::Switch(s) => {
                self.resolve_expr(&mut s.expr);
                for case in &mut s.cases {
                    if let HirSwitchLabel::Case(e) = &mut case.label {
                        self.resolve_expr(e);
                    }
                    for stmt in &mut case.stmts {
                        self.resolve_stmt(stmt);
                    }
                }
            }
            HirStmt::DoWhile(d) => {
                self.resolve_stmt(&mut d.body);
                self.resolve_expr(&mut d.condition);
            }
            HirStmt::RangeFor(r) => {
                self.resolve_type(&mut r.var_ty);
                self.resolve_expr(&mut r.limit);
                self.resolve_stmt(&mut r.body);
            }
            HirStmt::StaticFor(s) => {
                self.resolve_type(&mut s.var_ty);
                self.resolve_expr(&mut s.limit);
                self.resolve_stmt(&mut s.body);
            }
            HirStmt::UnrolledFor(u) => {
                self.resolve_type(&mut u.var_ty);
                self.resolve_expr(&mut u.limit);
                self.resolve_stmt(&mut u.body);
            }
            HirStmt::StaticIf(si) => {
                self.resolve_expr(&mut si.condition);
                self.resolve_stmt(&mut si.then_branch);
                if let Some(else_branch) = &mut si.else_branch {
                    self.resolve_stmt(else_branch);
                }
            }
            HirStmt::Reorder(r) => self.resolve_stmt(&mut r.body),
            HirStmt::Atomic(a) => self.resolve_stmt(&mut a.body),
            HirStmt::Expr(e) => self.resolve_expr(&mut e.expr),
            HirStmt::Assign(a) => {
                self.resolve_expr(&mut a.lhs);
                self.resolve_expr(&mut a.rhs);
            }
            HirStmt::VarDecl(v) => self.resolve_variable(v),
            HirStmt::Annotated(a) => self.resolve_stmt(&mut a.stmt),
            HirStmt::Barrier(_) | HirStmt::Break(_) => {}
        }
    }

    fn resolve_expr(&mut self, expr: &mut HirExpr) {
        // Resolve the expression's type
        self.resolve_type(&mut expr.ty);

        // Resolve nested expressions
        match &mut expr.kind {
            HirExprKind::IntLiteral { .. } |
            HirExprKind::FloatLiteral(_) |
            HirExprKind::BoolLiteral(_) |
            HirExprKind::StringLiteral(_) |
            HirExprKind::This { .. } |
            HirExprKind::Error(_) => {}

            HirExprKind::Ident { name, def_id } => {
                // Try to resolve if not already resolved
                if !def_id.is_valid() {
                    if let Some(resolved) = self.symbols.lookup(name) {
                        *def_id = resolved;
                        // Update type from symbol table
                        if let Some(ty) = self.symbols.ty(resolved) {
                            if !expr.ty.is_resolved() {
                                expr.ty = ty.clone();
                            }
                        }
                    } else {
                        self.errors.push(ResolveError::UndefinedSymbol {
                            name: name.clone(),
                            span: expr.span,
                        });
                    }
                }
            }

            HirExprKind::QualifiedIdent { path, def_id } => {
                if !def_id.is_valid() {
                    if let Some(resolved) = self.symbols.lookup_qualified(path) {
                        *def_id = resolved;
                        if let Some(ty) = self.symbols.ty(resolved) {
                            if !expr.ty.is_resolved() {
                                expr.ty = ty.clone();
                            }
                        }
                    }
                }
            }

            HirExprKind::InterpolatedString(parts) => {
                for part in parts {
                    if let HirStringPart::Interpolation { expr, .. } = part {
                        self.resolve_expr(expr);
                    }
                }
            }

            HirExprKind::Binary { lhs, rhs, .. } => {
                self.resolve_expr(lhs);
                self.resolve_expr(rhs);
            }

            HirExprKind::Unary { operand, .. } => {
                self.resolve_expr(operand);
            }

            HirExprKind::Ternary { condition, then_expr, else_expr } => {
                self.resolve_expr(condition);
                self.resolve_expr(then_expr);
                self.resolve_expr(else_expr);
            }

            HirExprKind::Call { callee, args, .. } => {
                self.resolve_expr(callee);
                for arg in args {
                    self.resolve_expr(arg);
                }
            }

            HirExprKind::Member { object, .. } => {
                self.resolve_expr(object);
            }

            HirExprKind::Subscript { array, index } => {
                self.resolve_expr(array);
                self.resolve_expr(index);
            }

            HirExprKind::Cast { ty, expr } => {
                self.resolve_type(ty);
                self.resolve_expr(expr);
            }

            HirExprKind::Mux { selector, args } => {
                self.resolve_expr(selector);
                for arg in args {
                    self.resolve_expr(arg);
                }
            }

            HirExprKind::Concat(args) => {
                for arg in args {
                    self.resolve_expr(arg);
                }
            }

            HirExprKind::FanOut { count, value } => {
                self.resolve_expr(count);
                self.resolve_expr(value);
            }

            HirExprKind::Static(e) => self.resolve_expr(e),

            HirExprKind::InitializerList(elems) => {
                for elem in elems {
                    self.resolve_expr(elem);
                }
            }

            HirExprKind::DesignatedInitializer(fields) => {
                for (_, expr) in fields {
                    self.resolve_expr(expr);
                }
            }

            HirExprKind::Paren(e) => self.resolve_expr(e),

            HirExprKind::TypeExpr(ty) => self.resolve_type(ty),

            HirExprKind::Lambda(lambda) => {
                for param in &mut lambda.params {
                    self.resolve_type(&mut param.ty);
                    if let Some(default) = &mut param.default {
                        self.resolve_expr(default);
                    }
                }
                if let Some(return_ty) = &mut lambda.return_ty {
                    self.resolve_type(return_ty);
                }
                self.resolve_block(&mut lambda.body);
            }

            HirExprKind::Sizeof { operand, .. } => self.resolve_expr(operand),

            HirExprKind::Offsetof { ty, .. } => self.resolve_type(ty),

            HirExprKind::EnumValue { value, .. } => self.resolve_expr(value),

            HirExprKind::NamedValue(e) => self.resolve_expr(e),
        }
    }

    fn resolve_type(&mut self, _ty: &mut Ty) {
        // Most type resolution happens during initial lowering.
        // This pass can perform additional validation.
        // For now, types are resolved during lowering.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_error_display() {
        let err = ResolveError::UndefinedSymbol {
            name: "foo".to_string(),
            span: crate::Span::default(),
        };
        assert!(err.to_string().contains("foo"));
    }
}
