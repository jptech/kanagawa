//! Type checking pass for Kanagawa HIR.
//!
//! This module walks the HIR and:
//! - Infers types for `auto` declarations
//! - Checks type compatibility in expressions
//! - Validates function call arguments
//! - Reports type errors with detailed diagnostics

use crate::diagnostic::{Diagnostic, DiagnosticCode, Diagnostics};
use crate::infer::InferContext;
use crate::rules::{self, BinaryOp, Compatibility, UnaryOp};
use kanagawa_hir::*;

/// Result of type checking.
pub struct TypeCheckResult {
    /// Collected diagnostics (errors and warnings).
    pub diagnostics: Vec<Diagnostic>,
    /// Whether type checking succeeded (no errors).
    pub success: bool,
}

impl TypeCheckResult {
    /// Check if there are any errors.
    pub fn has_errors(&self) -> bool {
        !self.success
    }
}

/// Type checker for HIR.
pub struct TypeChecker<'a> {
    /// The HIR file being checked.
    hir: &'a HirFile,
    /// Symbol table for lookups.
    symbols: &'a SymbolTable,
    /// Inference context for type variables.
    infer: InferContext,
    /// Collected diagnostics.
    diagnostics: Diagnostics,
    /// Current function's return type (for return statement checking).
    current_return_type: Option<Ty>,
}

impl<'a> TypeChecker<'a> {
    /// Create a new type checker.
    pub fn new(hir: &'a HirFile, symbols: &'a SymbolTable) -> Self {
        Self {
            hir,
            symbols,
            infer: InferContext::new(),
            diagnostics: Diagnostics::new(),
            current_return_type: None,
        }
    }

    /// Run type checking on the HIR file.
    pub fn check(mut self) -> TypeCheckResult {
        // Check all items
        for item in &self.hir.items {
            self.check_item(item);
        }

        // Solve inference constraints
        self.infer.solve();

        // Collect all diagnostics
        let mut all_diagnostics = self.diagnostics.take();
        all_diagnostics.extend(self.infer.diagnostics.take());

        let success = !all_diagnostics.iter().any(|d| d.is_error());

        TypeCheckResult {
            diagnostics: all_diagnostics,
            success,
        }
    }

    /// Check an item (declaration).
    fn check_item(&mut self, item: &HirItem) {
        match item {
            HirItem::Function(f) => self.check_function(f),
            HirItem::Struct(s) => self.check_struct(s),
            HirItem::Class(c) => self.check_class(c),
            HirItem::Union(u) => self.check_union(u),
            HirItem::Enum(e) => self.check_enum(e),
            HirItem::Variable(v) => self.check_variable(v),
            HirItem::Using(_) => {} // Type aliases are checked during resolution
            HirItem::Template(t) => self.check_template(t),
            HirItem::StaticIf(s) => self.check_static_if(s),
            HirItem::StaticAssert(s) => self.check_static_assert(s),
            HirItem::Extern(_) => {} // Extern declarations are checked during resolution
            HirItem::Export(_) => {} // Export declarations are checked during resolution
            HirItem::DeclBlock(b) => {
                for inner in &b.items {
                    self.check_item(inner);
                }
            }
        }
    }

    /// Check a function declaration.
    fn check_function(&mut self, func: &HirFunction) {
        // Set current return type for return statement checking
        self.current_return_type = Some(func.return_ty.clone());

        // Check parameter types are valid
        for param in &func.params {
            self.validate_type(&param.ty, param.span);
        }

        // Check return type is valid
        self.validate_type(&func.return_ty, func.span);

        // Check function body
        if let Some(body) = &func.body {
            self.check_block(body);
        }

        self.current_return_type = None;
    }

    /// Check a struct declaration.
    fn check_struct(&mut self, s: &HirStruct) {
        for member in &s.members {
            self.validate_type(&member.ty, member.span);
            // Check initializer if present
            if let Some(init) = &member.init {
                let init_ty = self.infer_expr_type(init);
                self.check_assignment(&member.ty, &init_ty, init.span);
            }
        }
    }

    /// Check a class declaration.
    fn check_class(&mut self, c: &HirClass) {
        for member in &c.members {
            match member {
                HirClassMember::Variable(v) => {
                    self.validate_type(&v.ty, v.span);
                    if let Some(init) = &v.init {
                        let init_ty = self.infer_expr_type(init);
                        self.check_assignment(&v.ty, &init_ty, init.span);
                    }
                }
                HirClassMember::Function(f) => self.check_function(f),
                HirClassMember::Access(_) => {} // Access specifiers don't need type checking
                HirClassMember::DefaultInit(expr) => {
                    self.infer_expr_type(expr);
                }
                HirClassMember::Nested(item) => self.check_item(item),
            }
        }
    }

    /// Check a union declaration.
    fn check_union(&mut self, u: &HirUnion) {
        for member in &u.members {
            self.validate_type(&member.ty, member.span);
        }
    }

    /// Check an enum declaration.
    fn check_enum(&mut self, e: &HirEnum) {
        for variant in &e.variants {
            if let Some(value) = &variant.value {
                let value_ty = self.infer_expr_type(value);
                // Enum values should be compatible with base type
                self.check_assignment(&e.base_ty, &value_ty, value.span);
            }
        }
    }

    /// Check a variable declaration.
    fn check_variable(&mut self, var: &HirVariable) {
        self.validate_type(&var.ty, var.span);

        if let Some(init) = &var.init {
            let init_ty = self.infer_expr_type(init);

            // Handle auto type inference
            if matches!(var.ty, Ty::Auto) {
                // Type should be inferred from initializer
                // This is handled during HIR lowering, but we validate here
                if matches!(init_ty, Ty::Unresolved) {
                    self.diagnostics.add(Diagnostic::error(
                        DiagnosticCode::CannotInfer,
                        "cannot infer type for auto variable",
                        var.span,
                    ));
                }
            } else {
                self.check_assignment(&var.ty, &init_ty, init.span);
            }
        }
    }

    /// Check a template declaration.
    fn check_template(&mut self, t: &HirTemplate) {
        // Check the inner item
        self.check_item(&t.item);
    }

    /// Check a static if declaration.
    fn check_static_if(&mut self, s: &HirStaticIf) {
        // Check condition is boolean
        let cond_ty = self.infer_expr_type(&s.condition);
        self.expect_bool(&cond_ty, s.condition.span);

        // Check branches
        self.check_item(&s.then_item);
        if let Some(else_item) = &s.else_item {
            self.check_item(else_item);
        }
    }

    /// Check a static assert.
    fn check_static_assert(&mut self, s: &HirStaticAssert) {
        let cond_ty = self.infer_expr_type(&s.condition);
        self.expect_bool(&cond_ty, s.condition.span);
    }

    /// Check a statement.
    fn check_stmt(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::Block(b) => self.check_block(b),
            HirStmt::VarDecl(v) => self.check_variable(v),
            HirStmt::Expr(e) => {
                self.infer_expr_type(&e.expr);
            }
            HirStmt::Return(r) => self.check_return(r),
            HirStmt::If(i) => self.check_if(i),
            HirStmt::Switch(s) => self.check_switch(s),
            HirStmt::RangeFor(f) => self.check_range_for(f),
            HirStmt::StaticFor(f) => self.check_static_for(f),
            HirStmt::UnrolledFor(f) => self.check_unrolled_for(f),
            HirStmt::DoWhile(d) => self.check_do_while(d),
            HirStmt::StaticIf(s) => self.check_static_if_stmt(s),
            HirStmt::Break(_) | HirStmt::Barrier(_) => {}
            HirStmt::Assign(a) => self.check_assign(a),
            HirStmt::Reorder(r) => self.check_stmt(&r.body),
            HirStmt::Atomic(a) => self.check_stmt(&a.body),
            HirStmt::Annotated(a) => self.check_stmt(&a.stmt),
        }
    }

    /// Check a block statement.
    fn check_block(&mut self, block: &HirBlock) {
        for stmt in &block.stmts {
            self.check_stmt(stmt);
        }
    }

    /// Check a return statement.
    fn check_return(&mut self, ret: &HirReturn) {
        let expected = self.current_return_type.clone().unwrap_or(Ty::Void);

        match (&ret.value, expected.is_void()) {
            (Some(value), false) => {
                let value_ty = self.infer_expr_type(value);
                self.check_assignment(&expected, &value_ty, value.span);
            }
            (Some(value), true) => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::ReturnTypeMismatch,
                    "unexpected return value in void function",
                    value.span,
                ));
            }
            (None, false) => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::MissingReturn,
                    format!("missing return value of type `{:?}`", expected),
                    ret.span,
                ));
            }
            (None, true) => {}
        }
    }

    /// Check an if statement.
    fn check_if(&mut self, i: &HirIf) {
        let cond_ty = self.infer_expr_type(&i.condition);
        self.expect_bool(&cond_ty, i.condition.span);

        self.check_stmt(&i.then_branch);
        if let Some(else_branch) = &i.else_branch {
            self.check_stmt(else_branch);
        }
    }

    /// Check a switch statement.
    fn check_switch(&mut self, s: &HirSwitch) {
        let switch_ty = self.infer_expr_type(&s.expr);

        for case in &s.cases {
            if let HirSwitchLabel::Case(value) = &case.label {
                let case_ty = self.infer_expr_type(value);
                // Case values should be comparable to switch expression
                if !self.types_comparable(&switch_ty, &case_ty) {
                    self.diagnostics.add(Diagnostic::error(
                        DiagnosticCode::TypeMismatch,
                        format!(
                            "case value type `{:?}` incompatible with switch type `{:?}`",
                            case_ty, switch_ty
                        ),
                        value.span,
                    ));
                }
            }
            for stmt in &case.stmts {
                self.check_stmt(stmt);
            }
        }
    }

    /// Check a range-for statement.
    fn check_range_for(&mut self, f: &HirRangeFor) {
        // Limit should be an integer
        let limit_ty = self.infer_expr_type(&f.limit);
        if !limit_ty.is_int() && !matches!(limit_ty, Ty::Unresolved) {
            self.diagnostics.add(Diagnostic::error(
                DiagnosticCode::ExpectedType,
                format!("for loop limit must be integer, found `{:?}`", limit_ty),
                f.limit.span,
            ));
        }

        self.check_stmt(&f.body);
    }

    /// Check a static for statement.
    fn check_static_for(&mut self, f: &HirStaticFor) {
        let limit_ty = self.infer_expr_type(&f.limit);
        if !limit_ty.is_int() && !matches!(limit_ty, Ty::Unresolved) {
            self.diagnostics.add(Diagnostic::error(
                DiagnosticCode::ExpectedType,
                format!("static for loop limit must be integer, found `{:?}`", limit_ty),
                f.limit.span,
            ));
        }

        self.check_stmt(&f.body);
    }

    /// Check an unrolled for statement.
    fn check_unrolled_for(&mut self, f: &HirUnrolledFor) {
        let limit_ty = self.infer_expr_type(&f.limit);
        if !limit_ty.is_int() && !matches!(limit_ty, Ty::Unresolved) {
            self.diagnostics.add(Diagnostic::error(
                DiagnosticCode::ExpectedType,
                format!("unrolled for loop limit must be integer, found `{:?}`", limit_ty),
                f.limit.span,
            ));
        }

        self.check_stmt(&f.body);
    }

    /// Check a do-while statement.
    fn check_do_while(&mut self, d: &HirDoWhile) {
        self.check_stmt(&d.body);

        let cond_ty = self.infer_expr_type(&d.condition);
        self.expect_bool(&cond_ty, d.condition.span);
    }

    /// Check a static if statement.
    fn check_static_if_stmt(&mut self, s: &HirStaticIfStmt) {
        let cond_ty = self.infer_expr_type(&s.condition);
        self.expect_bool(&cond_ty, s.condition.span);

        self.check_stmt(&s.then_branch);
        if let Some(else_branch) = &s.else_branch {
            self.check_stmt(else_branch);
        }
    }

    /// Check an assignment statement.
    fn check_assign(&mut self, a: &HirAssign) {
        let lhs_ty = self.infer_expr_type(&a.lhs);
        let rhs_ty = self.infer_expr_type(&a.rhs);

        // For compound assignments, check operator compatibility
        match a.op {
            HirAssignOp::Assign => {
                self.check_assignment(&lhs_ty, &rhs_ty, a.span);
            }
            HirAssignOp::AddAssign | HirAssignOp::SubAssign | HirAssignOp::MulAssign
            | HirAssignOp::DivAssign | HirAssignOp::ModAssign => {
                // Both sides should be numeric
                if !lhs_ty.is_int() && !lhs_ty.is_float() && !matches!(lhs_ty, Ty::Unresolved) {
                    self.diagnostics.add(Diagnostic::error(
                        DiagnosticCode::InvalidOperand,
                        format!("invalid operand type `{:?}` for compound assignment", lhs_ty),
                        a.span,
                    ));
                }
            }
            HirAssignOp::ShlAssign | HirAssignOp::ShrAssign
            | HirAssignOp::AndAssign | HirAssignOp::OrAssign | HirAssignOp::XorAssign => {
                // LHS should be integer
                if !lhs_ty.is_int() && !matches!(lhs_ty, Ty::Unresolved) {
                    self.diagnostics.add(Diagnostic::error(
                        DiagnosticCode::InvalidOperand,
                        format!("invalid operand type `{:?}` for bitwise compound assignment", lhs_ty),
                        a.span,
                    ));
                }
            }
        }
    }

    /// Infer the type of an expression.
    fn infer_expr_type(&mut self, expr: &HirExpr) -> Ty {
        // If type is already resolved, use it
        if !matches!(expr.ty, Ty::Unresolved | Ty::Auto) {
            return expr.ty.clone();
        }

        // Otherwise infer from expression structure
        match &expr.kind {
            HirExprKind::IntLiteral { value, suffix } => {
                if let Some(suffix) = suffix {
                    if suffix.signed {
                        Ty::Signed(suffix.width as u32)
                    } else {
                        Ty::Unsigned(suffix.width as u32)
                    }
                } else {
                    rules::infer_integer_literal_type(*value)
                }
            }
            HirExprKind::FloatLiteral(_) => Ty::Float,
            HirExprKind::BoolLiteral(_) => Ty::Bool,
            HirExprKind::StringLiteral(_) => Ty::String,
            HirExprKind::InterpolatedString(_) => Ty::String,
            HirExprKind::Ident { def_id, .. } => {
                self.lookup_def_type(*def_id)
            }
            HirExprKind::QualifiedIdent { def_id, .. } => {
                self.lookup_def_type(*def_id)
            }
            HirExprKind::This { .. } => {
                // This returns a reference to the enclosing class/struct
                // For now, mark as unresolved
                Ty::Unresolved
            }
            HirExprKind::Binary { op, lhs, rhs } => {
                self.infer_binary_type(*op, lhs, rhs)
            }
            HirExprKind::Unary { op, operand } => {
                self.infer_unary_type(*op, operand)
            }
            HirExprKind::Ternary { condition, then_expr, else_expr } => {
                let cond_ty = self.infer_expr_type(condition);
                self.expect_bool(&cond_ty, condition.span);
                let then_ty = self.infer_expr_type(then_expr);
                let else_ty = self.infer_expr_type(else_expr);
                // Result type is common type of branches
                rules::common_type(&then_ty, &else_ty).unwrap_or(then_ty)
            }
            HirExprKind::Call { callee, args, .. } => {
                self.infer_call_type(callee, args)
            }
            HirExprKind::Member { object, member, .. } => {
                self.infer_member_type(object, member)
            }
            HirExprKind::Subscript { array, index } => {
                self.infer_subscript_type(array, index)
            }
            HirExprKind::Cast { ty, .. } => ty.clone(),
            HirExprKind::Sizeof { .. } => Ty::Unsigned(64), // size_t
            HirExprKind::Offsetof { .. } => Ty::Unsigned(64),
            HirExprKind::InitializerList(elements) => {
                // Infer element types
                let element_types: Vec<_> = elements.iter().map(|e| self.infer_expr_type(e)).collect();
                Ty::Initializer(element_types)
            }
            HirExprKind::DesignatedInitializer(fields) => {
                // Each field has a type
                let field_types: Vec<_> = fields.iter().map(|(name, e)| {
                    let ty = self.infer_expr_type(e);
                    (name.clone(), ty)
                }).collect();
                // This could be a struct initializer
                Ty::Struct {
                    name: Vec::new(),
                    fields: field_types,
                }
            }
            HirExprKind::FanOut { count, value } => {
                let value_ty = self.infer_expr_type(value);
                let _count_ty = self.infer_expr_type(count);
                // Result is array of value_ty
                if let Some(count_val) = self.try_eval_const_int(count) {
                    Ty::Array {
                        attrs: Vec::new(),
                        element: Box::new(value_ty),
                        dims: vec![count_val],
                    }
                } else {
                    // Unknown count - still an array but unknown size
                    Ty::Array {
                        attrs: Vec::new(),
                        element: Box::new(value_ty),
                        dims: vec![-1], // Unknown dimension
                    }
                }
            }
            HirExprKind::Mux { selector, args } => {
                // Check selector is integer
                let sel_ty = self.infer_expr_type(selector);
                if !sel_ty.is_int() && !matches!(sel_ty, Ty::Unresolved) {
                    self.diagnostics.add(Diagnostic::error(
                        DiagnosticCode::ExpectedType,
                        format!("mux selector must be integer, found `{:?}`", sel_ty),
                        selector.span,
                    ));
                }
                // Result is common type of all args
                if !args.is_empty() {
                    args.iter().fold(self.infer_expr_type(&args[0]), |acc, arg| {
                        let arg_ty = self.infer_expr_type(arg);
                        rules::common_type(&acc, &arg_ty).unwrap_or(acc)
                    })
                } else {
                    Ty::Unresolved
                }
            }
            HirExprKind::Concat(args) => {
                // Concatenation: sum of all bit widths
                let total_width: u32 = args.iter().map(|a| {
                    let ty = self.infer_expr_type(a);
                    ty.width().unwrap_or(0)
                }).sum();
                Ty::Unsigned(total_width)
            }
            HirExprKind::Lambda(lambda) => {
                let param_tys: Vec<_> = lambda.params.iter().map(|p| TyFuncParam {
                    attrs: Vec::new(),
                    ty: p.ty.clone(),
                    name: Some(p.name.clone()),
                }).collect();
                Ty::Function {
                    kind: FunctionKind::Lambda,
                    attrs: Vec::new(),
                    return_ty: Box::new(lambda.return_ty.clone().unwrap_or(Ty::Void)),
                    params: param_tys,
                }
            }
            HirExprKind::TypeExpr(ty) => Ty::Type(Box::new(ty.clone())),
            HirExprKind::Static(inner) => self.infer_expr_type(inner),
            HirExprKind::Paren(inner) => self.infer_expr_type(inner),
            HirExprKind::Unit => Ty::Void,
            HirExprKind::EnumValue { enum_ty, .. } => enum_ty.clone(),
            HirExprKind::NamedValue(inner) => self.infer_expr_type(inner),
            HirExprKind::Error(_) => Ty::Error("type error".to_string()),
        }
    }

    /// Look up the type of a definition.
    fn lookup_def_type(&self, def_id: DefId) -> Ty {
        if let Some(def) = self.symbols.get(def_id) {
            def.ty.clone()
        } else {
            Ty::Unresolved
        }
    }

    /// Infer type for binary expression.
    fn infer_binary_type(&mut self, op: HirBinaryOp, lhs: &HirExpr, rhs: &HirExpr) -> Ty {
        let lhs_ty = self.infer_expr_type(lhs);
        let rhs_ty = self.infer_expr_type(rhs);

        let bin_op = match op {
            HirBinaryOp::Add => BinaryOp::Add,
            HirBinaryOp::Sub => BinaryOp::Sub,
            HirBinaryOp::Mul => BinaryOp::Mul,
            HirBinaryOp::Div => BinaryOp::Div,
            HirBinaryOp::Mod => BinaryOp::Mod,
            HirBinaryOp::Shl => BinaryOp::Shl,
            HirBinaryOp::Shr => BinaryOp::Shr,
            HirBinaryOp::BitwiseAnd => BinaryOp::BitAnd,
            HirBinaryOp::BitwiseOr => BinaryOp::BitOr,
            HirBinaryOp::BitwiseXor => BinaryOp::BitXor,
            HirBinaryOp::LogicalAnd => BinaryOp::LogAnd,
            HirBinaryOp::LogicalOr => BinaryOp::LogOr,
            HirBinaryOp::LogicalXor => BinaryOp::LogXor,
            HirBinaryOp::Eq => BinaryOp::Eq,
            HirBinaryOp::Ne => BinaryOp::Ne,
            HirBinaryOp::Lt => BinaryOp::Lt,
            HirBinaryOp::Le => BinaryOp::Le,
            HirBinaryOp::Gt => BinaryOp::Gt,
            HirBinaryOp::Ge => BinaryOp::Ge,
        };

        rules::binary_arithmetic_result_type(bin_op, &lhs_ty, &rhs_ty).unwrap_or(Ty::Unresolved)
    }

    /// Infer type for unary expression.
    fn infer_unary_type(&mut self, op: HirUnaryOp, operand: &HirExpr) -> Ty {
        let operand_ty = self.infer_expr_type(operand);

        let unary_op = match op {
            HirUnaryOp::Neg => UnaryOp::Neg,
            HirUnaryOp::Not => UnaryOp::Not,
            HirUnaryOp::Invert => UnaryOp::BitNot,
            HirUnaryOp::PreInc | HirUnaryOp::PreDec
            | HirUnaryOp::PostInc | HirUnaryOp::PostDec => return operand_ty,
        };

        rules::unary_result_type(unary_op, &operand_ty).unwrap_or(Ty::Unresolved)
    }

    /// Infer type for function call.
    fn infer_call_type(&mut self, callee: &HirExpr, args: &[HirExpr]) -> Ty {
        let callee_ty = self.infer_expr_type(callee);

        match &callee_ty {
            Ty::Function { return_ty, params, .. } => {
                // Check argument count
                if args.len() != params.len() {
                    self.diagnostics.add(crate::diagnostic::argument_count(
                        params.len(),
                        args.len(),
                        callee.span,
                    ));
                }

                // Check argument types
                for (i, (arg, param)) in args.iter().zip(params.iter()).enumerate() {
                    let arg_ty = self.infer_expr_type(arg);
                    if !self.check_assignment_silent(&param.ty, &arg_ty) {
                        self.diagnostics.add(
                            Diagnostic::error(
                                DiagnosticCode::ArgumentTypeMismatch,
                                format!(
                                    "argument {} type mismatch: expected `{:?}`, found `{:?}`",
                                    i + 1,
                                    param.ty,
                                    arg_ty
                                ),
                                arg.span,
                            )
                        );
                    }
                }

                (**return_ty).clone()
            }
            Ty::Unresolved => Ty::Unresolved,
            _ => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::NotCallable,
                    format!("type `{:?}` is not callable", callee_ty),
                    callee.span,
                ));
                Ty::Error("not callable".to_string())
            }
        }
    }

    /// Infer type for member access.
    fn infer_member_type(&mut self, object: &HirExpr, member: &str) -> Ty {
        let object_ty = self.infer_expr_type(object);

        match &object_ty {
            Ty::Struct { fields, .. } | Ty::Class { fields, .. } | Ty::Union { fields, .. } => {
                // Find field
                for (field_name, field_ty) in fields {
                    if field_name == member {
                        return field_ty.clone();
                    }
                }
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::UnknownField,
                    format!("unknown field `{}` on type `{:?}`", member, object_ty),
                    object.span,
                ));
                Ty::Error(format!("unknown field `{}`", member))
            }
            Ty::Unresolved => Ty::Unresolved,
            _ => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::InvalidOperand,
                    format!("cannot access member `{}` on type `{:?}`", member, object_ty),
                    object.span,
                ));
                Ty::Error("invalid member access".to_string())
            }
        }
    }

    /// Infer type for subscript (array indexing).
    fn infer_subscript_type(&mut self, array: &HirExpr, index: &HirExpr) -> Ty {
        let array_ty = self.infer_expr_type(array);
        let index_ty = self.infer_expr_type(index);

        // Index must be integer
        if !index_ty.is_int() && !matches!(index_ty, Ty::Unresolved) {
            self.diagnostics.add(Diagnostic::error(
                DiagnosticCode::InvalidArrayIndex,
                format!("array index must be integer, found `{:?}`", index_ty),
                index.span,
            ));
        }

        match &array_ty {
            Ty::Array { element, .. } => (**element).clone(),
            Ty::Unresolved => Ty::Unresolved,
            _ => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::InvalidOperand,
                    format!("cannot index type `{:?}`", array_ty),
                    array.span,
                ));
                Ty::Error("invalid subscript".to_string())
            }
        }
    }

    /// Check assignment compatibility and report errors.
    fn check_assignment(&mut self, target: &Ty, source: &Ty, span: Span) {
        // Skip if either type is unresolved
        if matches!(target, Ty::Unresolved) || matches!(source, Ty::Unresolved) {
            return;
        }

        match rules::check_assignment_compatibility(target, source) {
            Compatibility::Identical | Compatibility::ImplicitWidening => {}
            Compatibility::ExplicitCastRequired => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::ImplicitNarrowing,
                    format!(
                        "implicit narrowing conversion from `{:?}` to `{:?}` not allowed",
                        source, target
                    ),
                    span,
                ).with_note("use explicit cast<>() if narrowing is intentional"));
            }
            Compatibility::Incompatible => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::InvalidAssignment,
                    format!("cannot assign `{:?}` to `{:?}`", source, target),
                    span,
                ));
            }
        }
    }

    /// Check assignment compatibility silently (for use in loops).
    fn check_assignment_silent(&self, target: &Ty, source: &Ty) -> bool {
        if matches!(target, Ty::Unresolved) || matches!(source, Ty::Unresolved) {
            return true;
        }
        rules::check_assignment_compatibility(target, source).is_implicit()
    }

    /// Check that a type is boolean.
    fn expect_bool(&mut self, ty: &Ty, span: Span) {
        if !ty.is_bool() && !matches!(ty, Ty::Unresolved) {
            self.diagnostics.add(Diagnostic::error(
                DiagnosticCode::ExpectedType,
                format!("expected `bool`, found `{:?}`", ty),
                span,
            ));
        }
    }

    /// Check if two types are comparable.
    fn types_comparable(&self, a: &Ty, b: &Ty) -> bool {
        if matches!(a, Ty::Unresolved) || matches!(b, Ty::Unresolved) {
            return true;
        }
        // For now, allow comparison of same category types
        (a.is_int() && b.is_int())
            || (a.is_bool() && b.is_bool())
            || (a.is_float() && b.is_float())
            || rules::types_equal(a, b)
    }

    /// Validate that a type is well-formed.
    fn validate_type(&mut self, ty: &Ty, span: Span) {
        match ty {
            Ty::Unsigned(w) | Ty::Signed(w) if *w == 0 => {
                self.diagnostics.add(Diagnostic::error(
                    DiagnosticCode::InvalidIntegerWidth,
                    "integer width cannot be zero",
                    span,
                ));
            }
            Ty::Array { element, dims, .. } => {
                self.validate_type(element, span);
                for dim in dims {
                    if *dim <= 0 && *dim != -1 {
                        self.diagnostics.add(Diagnostic::error(
                            DiagnosticCode::ArrayDimensionMismatch,
                            format!("array dimension must be positive, found {}", dim),
                            span,
                        ));
                    }
                }
            }
            Ty::Function { return_ty, params, .. } => {
                self.validate_type(return_ty, span);
                for param in params {
                    self.validate_type(&param.ty, span);
                }
            }
            Ty::Const(inner) => self.validate_type(inner, span),
            _ => {}
        }
    }

    /// Try to evaluate a constant integer expression.
    fn try_eval_const_int(&self, expr: &HirExpr) -> Option<i64> {
        match &expr.kind {
            HirExprKind::IntLiteral { value, .. } => Some(*value as i64),
            _ => None,
        }
    }
}

/// Run type checking on an HIR file.
pub fn check_types(hir: &HirFile, symbols: &SymbolTable) -> TypeCheckResult {
    TypeChecker::new(hir, symbols).check()
}
