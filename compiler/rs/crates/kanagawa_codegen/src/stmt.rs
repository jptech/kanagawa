//! Statement emission to ParseTree.

use kanagawa_hir::{
    HirAssign, HirAssignOp, HirAtomic, HirBlock, HirDoWhile, HirIf, HirRangeFor, HirReorder,
    HirReturn, HirStaticFor, HirStaticIfStmt, HirStmt, HirSwitch, HirSwitchLabel, HirUnrolledFor,
    HirVariable, HirAnnotated,
};
use kanagawa_parsetree::build_list;
use kanagawa_parsetree_sys::{self as sys, ParseTreeNodePtr};

use crate::emit::{CodeGen, CodeGenError, CodeGenResult};

impl CodeGen {
    /// Emit a statement as a ParseTree node.
    pub(crate) fn emit_stmt(&mut self, stmt: &HirStmt) -> CodeGenResult<ParseTreeNodePtr> {
        match stmt {
            HirStmt::Block(block) => self.emit_block(block),
            HirStmt::Return(ret) => self.emit_return(ret),
            HirStmt::If(if_stmt) => self.emit_if(if_stmt),
            HirStmt::Switch(switch) => self.emit_switch(switch),
            HirStmt::DoWhile(do_while) => self.emit_do_while(do_while),
            HirStmt::RangeFor(range_for) => self.emit_range_for(range_for),
            HirStmt::StaticFor(static_for) => self.emit_static_for(static_for),
            HirStmt::UnrolledFor(unrolled_for) => self.emit_unrolled_for(unrolled_for),
            HirStmt::StaticIf(static_if) => self.emit_static_if_stmt(static_if),
            HirStmt::Barrier(span) => {
                self.set_location(span);
                Ok(unsafe { sys::ParseBarrier() })
            }
            HirStmt::Reorder(reorder) => self.emit_reorder(reorder),
            HirStmt::Atomic(atomic) => self.emit_atomic(atomic),
            HirStmt::Break(span) => {
                self.set_location(span);
                // Break is typically part of switch - emit as empty/null for now
                // The backend handles break specially within switch blocks
                Err(CodeGenError::Unsupported("break statement outside switch".to_string()))
            }
            HirStmt::Expr(expr_stmt) => {
                self.set_location(&expr_stmt.span);
                self.emit_expr(&expr_stmt.expr)
            }
            HirStmt::Assign(assign) => self.emit_assign(assign),
            HirStmt::VarDecl(var) => self.emit_local_var(var),
            HirStmt::Annotated(annotated) => self.emit_annotated(annotated),
        }
    }

    /// Emit a block of statements.
    pub(crate) fn emit_block(&mut self, block: &HirBlock) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&block.span);

        let mut stmt_nodes = Vec::new();
        for stmt in &block.stmts {
            let node = self.emit_stmt(stmt)?;
            if !node.is_null() {
                stmt_nodes.push(node);
            }
        }

        Ok(unsafe { sys::ParseNestedScope(build_list(&stmt_nodes)) })
    }

    /// Emit a return statement.
    fn emit_return(&mut self, ret: &HirReturn) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_return: has_value={}", ret.value.is_some());
        }
        self.set_location(&ret.span);

        if let Some(value) = &ret.value {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_return: emitting return expr");
            }
            let expr = self.emit_expr(value)?;
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_return: calling ParseReturnExpression");
            }
            Ok(unsafe { sys::ParseReturnExpression(expr) })
        } else {
            Ok(unsafe { sys::ParseReturn() })
        }
    }

    /// Emit an if statement.
    fn emit_if(&mut self, if_stmt: &HirIf) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&if_stmt.span);

        let cond = self.emit_expr(&if_stmt.condition)?;
        let then_branch = self.emit_stmt(&if_stmt.then_branch)?;
        let else_branch = if let Some(else_stmt) = &if_stmt.else_branch {
            self.emit_stmt(else_stmt)?
        } else {
            std::ptr::null_mut()
        };

        Ok(unsafe { sys::ParseIf(cond, then_branch, else_branch) })
    }

    /// Emit a switch statement.
    fn emit_switch(&mut self, switch: &HirSwitch) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&switch.span);

        let expr = self.emit_expr(&switch.expr)?;

        // Build switch blocks for each case
        let mut case_nodes = Vec::new();
        for case in &switch.cases {
            self.set_location(&case.span);

            // Emit case label
            let label = match &case.label {
                HirSwitchLabel::Case(expr) => self.emit_expr(expr)?,
                HirSwitchLabel::Default => std::ptr::null_mut(),
            };

            // Emit statements in this case
            let mut stmt_nodes = Vec::new();
            for stmt in &case.stmts {
                // Skip break statements - they're implicit in Kanagawa switch
                if matches!(stmt, HirStmt::Break(_)) {
                    continue;
                }
                let node = self.emit_stmt(stmt)?;
                if !node.is_null() {
                    stmt_nodes.push(node);
                }
            }
            let stmts_list = build_list(&stmt_nodes);

            let block = unsafe { sys::ParseSwitchBlock(label, stmts_list) };
            case_nodes.push(block);
        }

        let cases_list = build_list(&case_nodes);
        Ok(unsafe { sys::ParseSwitch(expr, cases_list) })
    }

    /// Emit a do-while loop.
    fn emit_do_while(&mut self, do_while: &HirDoWhile) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&do_while.span);

        let body = self.emit_stmt(&do_while.body)?;
        let cond = self.emit_expr(&do_while.condition)?;
        let attrs = self.emit_loop_attrs(&do_while.attrs);

        Ok(unsafe { sys::ParseDoWhile(attrs, body, cond) })
    }

    /// Emit a range-for loop.
    fn emit_range_for(&mut self, range_for: &HirRangeFor) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&range_for.span);

        // Emit loop variable declaration
        let var_ty = self.emit_type(&range_for.var_ty)?;
        let var_name = self.identifier(&range_for.var_name);
        let limit = self.emit_expr(&range_for.limit)?;

        // Emit body
        let body = self.emit_stmt(&range_for.body)?;

        // Emit attributes (for loop ordering)
        let _attrs = self.emit_loop_attrs(&range_for.attrs);

        // ParseRangeFor(type, name, limit, body)
        Ok(unsafe { sys::ParseRangeFor(var_ty, var_name, limit, body) })
    }

    /// Emit a static for loop.
    fn emit_static_for(&mut self, static_for: &HirStaticFor) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&static_for.span);

        // Static for is similar to unrolled for
        let var_ty = self.emit_type(&static_for.var_ty)?;
        let var_name = self.identifier(&static_for.var_name);
        let limit = self.emit_expr(&static_for.limit)?;
        let _body = self.emit_stmt(&static_for.body)?;

        // Use ParseUnrolledFor for static for
        Ok(unsafe { sys::ParseUnrolledFor(var_ty, var_name, limit) })
    }

    /// Emit an unrolled for loop.
    fn emit_unrolled_for(&mut self, unrolled_for: &HirUnrolledFor) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&unrolled_for.span);

        let var_ty = self.emit_type(&unrolled_for.var_ty)?;
        let var_name = self.identifier(&unrolled_for.var_name);
        let limit = self.emit_expr(&unrolled_for.limit)?;

        // Note: ParseUnrolledFor takes (decl, limit, body) but we need to check the actual signature
        Ok(unsafe { sys::ParseUnrolledFor(var_ty, var_name, limit) })
    }

    /// Emit a static if statement.
    fn emit_static_if_stmt(&mut self, static_if: &HirStaticIfStmt) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&static_if.span);

        let cond = self.emit_expr(&static_if.condition)?;
        let then_branch = self.emit_stmt(&static_if.then_branch)?;
        let else_branch = if let Some(else_stmt) = &static_if.else_branch {
            self.emit_stmt(else_stmt)?
        } else {
            std::ptr::null_mut()
        };

        // Static if at statement level is similar to regular if
        Ok(unsafe { sys::ParseIf(cond, then_branch, else_branch) })
    }

    /// Emit a reorder statement.
    fn emit_reorder(&mut self, reorder: &HirReorder) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&reorder.span);

        let body = self.emit_stmt(&reorder.body)?;
        Ok(unsafe { sys::ParseReorder(body) })
    }

    /// Emit an atomic statement.
    fn emit_atomic(&mut self, atomic: &HirAtomic) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&atomic.span);

        // Atomic is typically handled via annotations
        let body = self.emit_stmt(&atomic.body)?;
        // For now, just return the body - proper atomic handling needs attribute annotation
        Ok(body)
    }

    /// Emit an assignment statement.
    fn emit_assign(&mut self, assign: &HirAssign) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&assign.span);

        let lhs = self.emit_expr(&assign.lhs)?;

        // Handle compound assignments
        let rhs = match assign.op {
            HirAssignOp::Assign => self.emit_expr(&assign.rhs)?,
            HirAssignOp::AddAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeAdd, lhs, rhs_val) }
            }
            HirAssignOp::SubAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeSub, lhs, rhs_val) }
            }
            HirAssignOp::MulAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeMul, lhs, rhs_val) }
            }
            HirAssignOp::DivAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeDiv, lhs, rhs_val) }
            }
            HirAssignOp::ModAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeMod, lhs, rhs_val) }
            }
            HirAssignOp::ShlAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeShl, lhs, rhs_val) }
            }
            HirAssignOp::ShrAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeShr, lhs, rhs_val) }
            }
            HirAssignOp::AndAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeAnd, lhs, rhs_val) }
            }
            HirAssignOp::OrAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeOr, lhs, rhs_val) }
            }
            HirAssignOp::XorAssign => {
                let rhs_val = self.emit_expr(&assign.rhs)?;
                unsafe { sys::ParseBinaryOp(sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeXor, lhs, rhs_val) }
            }
        };

        // For compound assignments, we need to re-emit the LHS
        let final_lhs = if assign.op != HirAssignOp::Assign {
            self.emit_expr(&assign.lhs)?
        } else {
            lhs
        };

        let final_rhs = if assign.op != HirAssignOp::Assign {
            rhs
        } else {
            rhs
        };

        Ok(unsafe { sys::ParseAssign(final_lhs, final_rhs) })
    }

    /// Emit a local variable declaration.
    fn emit_local_var(&mut self, var: &HirVariable) -> CodeGenResult<ParseTreeNodePtr> {
        use crate::decl::emit_variable;
        emit_variable(self, var)
    }

    /// Emit an annotated statement.
    fn emit_annotated(&mut self, annotated: &HirAnnotated) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&annotated.span);

        let attrs = self.emit_attrs(&annotated.attrs)?;
        let stmt = self.emit_stmt(&annotated.stmt)?;

        if attrs.is_null() {
            Ok(stmt)
        } else {
            Ok(unsafe { sys::ParseAnnotatedStatement(attrs, stmt) })
        }
    }

    /// Emit loop attributes (ordering mode).
    fn emit_loop_attrs(&self, attrs: &[kanagawa_hir::TyAttr]) -> ParseTreeNodePtr {
        use kanagawa_hir::TyAttrFlag;

        for attr in attrs {
            if let kanagawa_hir::TyAttr::Flag(flag) = attr {
                match flag {
                    TyAttrFlag::Unordered => {
                        // Return unordered loop mode marker
                        return unsafe { sys::ParseFunctionModifier(sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierUnordered) };
                    }
                    TyAttrFlag::ReorderByLooping => {
                        return unsafe { sys::ParseFunctionModifier(sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierReorderByLooping) };
                    }
                    _ => {}
                }
            }
        }

        std::ptr::null_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirExpr, HirExprKind, Span, Ty};

    // Note: These tests require the C++ backend to be initialized (InitCompiler called).
    // They are ignored by default because unit tests cannot easily initialize the backend.

    fn make_int_expr(value: i128) -> HirExpr {
        HirExpr::new(
            Span::default(),
            Ty::Signed(32),
            HirExprKind::IntLiteral { value, suffix: None },
        )
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_empty_block() {
        let mut cg = CodeGen::new();
        let block = HirBlock {
            span: Span::default(),
            stmts: vec![],
        };
        let result = cg.emit_block(&block);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_return_void() {
        let mut cg = CodeGen::new();
        let ret = HirReturn {
            span: Span::default(),
            value: None,
        };
        let result = cg.emit_return(&ret);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_return_value() {
        let mut cg = CodeGen::new();
        let ret = HirReturn {
            span: Span::default(),
            value: Some(make_int_expr(42)),
        };
        let result = cg.emit_return(&ret);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_if_stmt() {
        let mut cg = CodeGen::new();
        let if_stmt = HirIf {
            span: Span::default(),
            condition: HirExpr::new(
                Span::default(),
                Ty::Bool,
                HirExprKind::BoolLiteral(true),
            ),
            then_branch: Box::new(HirStmt::Return(HirReturn {
                span: Span::default(),
                value: None,
            })),
            else_branch: None,
        };
        let result = cg.emit_if(&if_stmt);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_assign() {
        let mut cg = CodeGen::new();
        let assign = HirAssign {
            span: Span::default(),
            lhs: HirExpr::new(
                Span::default(),
                Ty::Signed(32),
                HirExprKind::Ident {
                    name: "x".to_string(),
                    def_id: kanagawa_hir::DefId(0),
                },
            ),
            op: HirAssignOp::Assign,
            rhs: make_int_expr(42),
        };
        let result = cg.emit_assign(&assign);
        assert!(result.is_ok());
    }
}
