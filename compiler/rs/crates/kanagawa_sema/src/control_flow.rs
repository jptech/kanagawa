//! Control flow validation.
//!
//! This module validates control flow correctness:
//! - Return paths (all paths return in non-void functions)
//! - Break/continue contexts (only in loops)
//! - Unreachable code detection
//! - Loop variable binding validity

use crate::diagnostic::{
    break_outside_loop, missing_return_value, not_all_paths_return,
    return_value_in_void, unreachable_code, SemaDiagnostic, SemaDiagnostics, SemaErrorCode,
};
use kanagawa_hir::{
    DefId, HirBlock, HirExpr, HirFile, HirFunction, HirItem, HirStmt, HirSwitchLabel, Span,
    SymbolTable, Ty,
};

/// Control flow context tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFlowContext {
    /// Top-level or global context.
    TopLevel,
    /// Inside a function.
    Function,
    /// Inside a loop (for, while, do-while).
    Loop,
    /// Inside a switch statement.
    Switch,
}

/// Result of analyzing a block's control flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowResult {
    /// Flow continues normally (may fall through).
    Normal,
    /// All paths return a value.
    Returns,
    /// All paths break out of the current loop.
    Breaks,
    /// Some paths return, others fall through.
    MayReturn,
    /// Some paths break, others fall through.
    MayBreak,
}

impl FlowResult {
    /// Check if this flow result guarantees a return.
    pub fn always_returns(&self) -> bool {
        matches!(self, FlowResult::Returns)
    }

    /// Check if this flow terminates (return or break).
    pub fn terminates(&self) -> bool {
        matches!(self, FlowResult::Returns | FlowResult::Breaks)
    }

    /// Combine two flow results (for if/else branches).
    pub fn combine(self, other: FlowResult) -> FlowResult {
        match (self, other) {
            // Both return -> returns
            (FlowResult::Returns, FlowResult::Returns) => FlowResult::Returns,
            // Both break -> breaks
            (FlowResult::Breaks, FlowResult::Breaks) => FlowResult::Breaks,
            // One returns, one doesn't -> may return
            (FlowResult::Returns, _) | (_, FlowResult::Returns) => FlowResult::MayReturn,
            // One breaks, one doesn't -> may break
            (FlowResult::Breaks, _) | (_, FlowResult::Breaks) => FlowResult::MayBreak,
            // May return propagates
            (FlowResult::MayReturn, _) | (_, FlowResult::MayReturn) => FlowResult::MayReturn,
            // May break propagates
            (FlowResult::MayBreak, _) | (_, FlowResult::MayBreak) => FlowResult::MayBreak,
            // Otherwise normal
            (FlowResult::Normal, FlowResult::Normal) => FlowResult::Normal,
        }
    }
}

/// Control flow validator.
pub struct ControlFlowValidator<'a> {
    /// The symbol table.
    pub symbols: &'a SymbolTable,
    /// Current context stack.
    context_stack: Vec<ControlFlowContext>,
    /// Current function's return type (if in a function).
    current_return_ty: Option<Ty>,
    /// Current function name (for error messages).
    current_function: Option<String>,
    /// Collected diagnostics.
    pub diagnostics: SemaDiagnostics,
}

impl<'a> ControlFlowValidator<'a> {
    /// Create a new control flow validator.
    pub fn new(symbols: &'a SymbolTable) -> Self {
        Self {
            symbols,
            context_stack: vec![ControlFlowContext::TopLevel],
            current_return_ty: None,
            current_function: None,
            diagnostics: SemaDiagnostics::new(),
        }
    }

    /// Check if we're inside a loop.
    fn in_loop(&self) -> bool {
        self.context_stack.iter().any(|c| *c == ControlFlowContext::Loop)
    }

    /// Push a new context.
    fn push_context(&mut self, ctx: ControlFlowContext) {
        self.context_stack.push(ctx);
    }

    /// Pop the current context.
    fn pop_context(&mut self) {
        self.context_stack.pop();
    }

    /// Validate a HIR file.
    pub fn validate_file(&mut self, file: &HirFile) {
        for item in &file.items {
            self.validate_item(item);
        }
    }

    /// Validate an item.
    fn validate_item(&mut self, item: &HirItem) {
        match item {
            HirItem::Function(f) => self.validate_function(f),
            HirItem::Template(t) => {
                self.validate_item(&t.item);
            }
            HirItem::StaticIf(s) => {
                self.validate_item(&s.then_item);
                if let Some(else_item) = &s.else_item {
                    self.validate_item(else_item);
                }
            }
            HirItem::DeclBlock(d) => {
                for item in &d.items {
                    self.validate_item(item);
                }
            }
            HirItem::Class(c) => {
                for member in &c.members {
                    if let kanagawa_hir::HirClassMember::Function(f) = member {
                        self.validate_function(f);
                    }
                }
            }
            _ => {}
        }
    }

    /// Validate a function's control flow.
    pub fn validate_function(&mut self, func: &HirFunction) {
        self.push_context(ControlFlowContext::Function);
        self.current_return_ty = Some(func.return_ty.clone());
        self.current_function = Some(func.name.clone());

        if let Some(body) = &func.body {
            let flow = self.validate_block(body);

            // Check if non-void function always returns
            if !func.return_ty.is_void() && !flow.always_returns() {
                self.diagnostics.add(not_all_paths_return(&func.name, func.span));
            }
        }

        self.current_function = None;
        self.current_return_ty = None;
        self.pop_context();
    }

    /// Validate a block and return its flow result.
    fn validate_block(&mut self, block: &HirBlock) -> FlowResult {
        let mut flow = FlowResult::Normal;
        let mut unreachable_reported = false;

        for stmt in &block.stmts {
            // Check for unreachable code
            if flow.terminates() && !unreachable_reported {
                // This statement is unreachable because previous statement terminated
                self.diagnostics.add(unreachable_code(get_stmt_span(stmt)));
                unreachable_reported = true;
            }

            let stmt_flow = self.validate_statement(stmt);

            // Update flow result
            if !flow.terminates() {
                flow = stmt_flow;
            }
        }

        flow
    }

    /// Validate a boxed statement (could be a block or single statement).
    fn validate_boxed_stmt(&mut self, stmt: &HirStmt) -> FlowResult {
        match stmt {
            HirStmt::Block(block) => self.validate_block(block),
            _ => self.validate_statement(stmt),
        }
    }

    /// Validate a statement and return its flow result.
    fn validate_statement(&mut self, stmt: &HirStmt) -> FlowResult {
        match stmt {
            HirStmt::Return(ret) => {
                self.validate_return(ret.value.as_ref(), ret.span);
                FlowResult::Returns
            }

            HirStmt::Break(span) => {
                if !self.in_loop() {
                    self.diagnostics.add(break_outside_loop(*span));
                }
                FlowResult::Breaks
            }

            HirStmt::If(if_stmt) => {
                let then_flow = self.validate_boxed_stmt(&if_stmt.then_branch);

                if let Some(else_branch) = &if_stmt.else_branch {
                    let else_flow = self.validate_boxed_stmt(else_branch);
                    then_flow.combine(else_flow)
                } else {
                    // No else branch means flow might not go through then
                    FlowResult::Normal
                }
            }

            HirStmt::Switch(switch) => {
                self.push_context(ControlFlowContext::Switch);

                let mut all_return = true;
                let mut any_return = false;
                let mut has_default = false;

                for case in &switch.cases {
                    if matches!(case.label, HirSwitchLabel::Default) {
                        has_default = true;
                    }

                    let case_flow = self.validate_case_stmts(&case.stmts);
                    if case_flow.always_returns() {
                        any_return = true;
                    } else {
                        all_return = false;
                    }
                }

                if !has_default {
                    // No default means not all cases covered
                    all_return = false;
                }

                self.pop_context();

                if all_return && has_default {
                    FlowResult::Returns
                } else if any_return {
                    FlowResult::MayReturn
                } else {
                    FlowResult::Normal
                }
            }

            HirStmt::RangeFor(f) => {
                self.validate_loop_variable(f.var_def_id, f.span);
                self.push_context(ControlFlowContext::Loop);
                self.validate_boxed_stmt(&f.body);
                self.pop_context();
                // Loops don't guarantee return (might not execute)
                FlowResult::Normal
            }

            HirStmt::StaticFor(f) => {
                self.validate_loop_variable(f.var_def_id, f.span);
                self.push_context(ControlFlowContext::Loop);
                self.validate_boxed_stmt(&f.body);
                self.pop_context();
                FlowResult::Normal
            }

            HirStmt::UnrolledFor(f) => {
                self.validate_loop_variable(f.var_def_id, f.span);
                self.push_context(ControlFlowContext::Loop);
                self.validate_boxed_stmt(&f.body);
                self.pop_context();
                FlowResult::Normal
            }

            HirStmt::DoWhile(d) => {
                self.push_context(ControlFlowContext::Loop);
                let body_flow = self.validate_boxed_stmt(&d.body);
                self.pop_context();

                // Do-while executes at least once
                if body_flow.always_returns() {
                    FlowResult::Returns
                } else {
                    FlowResult::Normal
                }
            }

            HirStmt::Block(block) => self.validate_block(block),

            HirStmt::Annotated(a) => self.validate_statement(&a.stmt),

            HirStmt::Reorder(r) => {
                self.validate_boxed_stmt(&r.body);
                FlowResult::Normal
            }

            HirStmt::Atomic(a) => {
                self.validate_boxed_stmt(&a.body);
                FlowResult::Normal
            }

            HirStmt::StaticIf(s) => {
                let then_flow = self.validate_boxed_stmt(&s.then_branch);
                if let Some(else_branch) = &s.else_branch {
                    let else_flow = self.validate_boxed_stmt(else_branch);
                    then_flow.combine(else_flow)
                } else {
                    FlowResult::Normal
                }
            }

            // Non-terminating statements
            HirStmt::Expr(_)
            | HirStmt::Assign(_)
            | HirStmt::VarDecl(_)
            | HirStmt::Barrier(_) => FlowResult::Normal,
        }
    }

    /// Validate a list of case statements.
    fn validate_case_stmts(&mut self, stmts: &[HirStmt]) -> FlowResult {
        let mut flow = FlowResult::Normal;
        for stmt in stmts {
            let stmt_flow = self.validate_statement(stmt);
            if !flow.terminates() {
                flow = stmt_flow;
            }
        }
        flow
    }

    /// Validate a return statement.
    fn validate_return(&mut self, value: Option<&HirExpr>, span: Span) {
        let return_ty = self.current_return_ty.clone().unwrap_or(Ty::Void);

        if return_ty.is_void() {
            if value.is_some() {
                self.diagnostics.add(return_value_in_void(span));
            }
        } else if value.is_none() {
            self.diagnostics.add(missing_return_value(span, &format!("{:?}", return_ty)));
        }
    }

    /// Validate a loop variable's def_id.
    fn validate_loop_variable(&mut self, def_id: DefId, span: Span) {
        if !def_id.is_valid() {
            self.diagnostics.add(
                SemaDiagnostic::error(
                    SemaErrorCode::InvalidLoopVariable,
                    "loop variable has invalid definition",
                    span,
                )
                .with_note("loop variable must be properly bound to a definition"),
            );
        }
    }

    /// Take the collected diagnostics.
    pub fn take_diagnostics(self) -> SemaDiagnostics {
        self.diagnostics
    }
}

/// Get the span from a statement.
fn get_stmt_span(stmt: &HirStmt) -> Span {
    match stmt {
        HirStmt::Block(b) => b.span,
        HirStmt::Return(r) => r.span,
        HirStmt::If(i) => i.span,
        HirStmt::Switch(s) => s.span,
        HirStmt::DoWhile(d) => d.span,
        HirStmt::RangeFor(f) => f.span,
        HirStmt::StaticFor(f) => f.span,
        HirStmt::UnrolledFor(f) => f.span,
        HirStmt::StaticIf(s) => s.span,
        HirStmt::Barrier(span) => *span,
        HirStmt::Reorder(r) => r.span,
        HirStmt::Atomic(a) => a.span,
        HirStmt::Break(span) => *span,
        HirStmt::Expr(e) => e.span,
        HirStmt::Assign(a) => a.span,
        HirStmt::VarDecl(v) => v.span,
        HirStmt::Annotated(a) => a.span,
    }
}

/// Validate control flow in a file.
pub fn validate_control_flow(file: &HirFile, symbols: &SymbolTable) -> SemaDiagnostics {
    let mut validator = ControlFlowValidator::new(symbols);
    validator.validate_file(file);
    validator.take_diagnostics()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirDoWhile, HirExprKind, HirReturn};

    fn make_block(stmts: Vec<HirStmt>) -> HirBlock {
        HirBlock {
            span: Span::default(),
            stmts,
        }
    }

    fn make_return(value: Option<HirExpr>) -> HirStmt {
        HirStmt::Return(HirReturn {
            span: Span::default(),
            value,
        })
    }

    fn make_break() -> HirStmt {
        HirStmt::Break(Span::default())
    }

    fn make_if(then_stmt: HirStmt, else_stmt: Option<HirStmt>) -> HirStmt {
        HirStmt::If(kanagawa_hir::HirIf {
            span: Span::default(),
            condition: HirExpr::new(
                Span::default(),
                Ty::Bool,
                HirExprKind::BoolLiteral(true),
            ),
            then_branch: Box::new(then_stmt),
            else_branch: else_stmt.map(Box::new),
        })
    }

    fn make_function(name: &str, return_ty: Ty, body: HirBlock) -> HirFunction {
        HirFunction {
            span: Span::default(),
            def_id: DefId(0),
            name: name.to_string(),
            ty: Ty::Void,
            kind: kanagawa_hir::FunctionKind::Free,
            modifier: None,
            params: Vec::new(),
            return_ty,
            body: Some(body),
            attrs: Vec::new(),
        }
    }

    #[test]
    fn test_void_function_no_return() {
        let symbols = SymbolTable::new();
        let func = make_function("test", Ty::Void, make_block(vec![]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_void_function_with_return_value() {
        let symbols = SymbolTable::new();
        let func = make_function(
            "test",
            Ty::Void,
            make_block(vec![make_return(Some(HirExpr::new(
                Span::default(),
                Ty::Signed(32),
                HirExprKind::IntLiteral { value: 42, suffix: None },
            )))]),
        );

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::ReturnValueInVoidFunction);
    }

    #[test]
    fn test_non_void_function_missing_return() {
        let symbols = SymbolTable::new();
        let func = make_function("test", Ty::Signed(32), make_block(vec![]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::NotAllPathsReturn);
    }

    #[test]
    fn test_non_void_function_with_return() {
        let symbols = SymbolTable::new();
        let func = make_function(
            "test",
            Ty::Signed(32),
            make_block(vec![make_return(Some(HirExpr::new(
                Span::default(),
                Ty::Signed(32),
                HirExprKind::IntLiteral { value: 42, suffix: None },
            )))]),
        );

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_break_outside_loop() {
        let symbols = SymbolTable::new();
        let func = make_function("test", Ty::Void, make_block(vec![make_break()]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::BreakOutsideLoop);
    }

    #[test]
    fn test_break_inside_loop() {
        let symbols = SymbolTable::new();
        let do_while = HirStmt::DoWhile(HirDoWhile {
            span: Span::default(),
            condition: HirExpr::new(
                Span::default(),
                Ty::Bool,
                HirExprKind::BoolLiteral(true),
            ),
            body: Box::new(make_break()),
            attrs: Vec::new(),
        });

        let func = make_function("test", Ty::Void, make_block(vec![do_while]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_if_both_branches_return() {
        let symbols = SymbolTable::new();
        let then_return = make_return(Some(HirExpr::new(
            Span::default(),
            Ty::Signed(32),
            HirExprKind::IntLiteral { value: 1, suffix: None },
        )));
        let else_return = make_return(Some(HirExpr::new(
            Span::default(),
            Ty::Signed(32),
            HirExprKind::IntLiteral { value: 2, suffix: None },
        )));
        let if_stmt = make_if(then_return, Some(else_return));

        let func = make_function("test", Ty::Signed(32), make_block(vec![if_stmt]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_if_only_then_returns() {
        let symbols = SymbolTable::new();
        let then_return = make_return(Some(HirExpr::new(
            Span::default(),
            Ty::Signed(32),
            HirExprKind::IntLiteral { value: 1, suffix: None },
        )));
        let if_stmt = make_if(then_return, None);

        let func = make_function("test", Ty::Signed(32), make_block(vec![if_stmt]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::NotAllPathsReturn);
    }

    #[test]
    fn test_unreachable_code_after_return() {
        let symbols = SymbolTable::new();
        let func = make_function(
            "test",
            Ty::Void,
            make_block(vec![
                make_return(None),
                HirStmt::Expr(kanagawa_hir::HirExprStmt {
                    span: Span { start: 100, end: 110, file_index: 0 },
                    expr: HirExpr::new(
                        Span::default(),
                        Ty::Void,
                        HirExprKind::IntLiteral { value: 42, suffix: None },
                    ),
                }),
            ]),
        );

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.warning_count() > 0);
        let warnings: Vec<_> = diags.warnings().collect();
        assert_eq!(warnings[0].code, SemaErrorCode::UnreachableCode);
    }

    #[test]
    fn test_flow_result_combine() {
        assert_eq!(
            FlowResult::Returns.combine(FlowResult::Returns),
            FlowResult::Returns
        );
        assert_eq!(
            FlowResult::Returns.combine(FlowResult::Normal),
            FlowResult::MayReturn
        );
        assert_eq!(
            FlowResult::Normal.combine(FlowResult::Normal),
            FlowResult::Normal
        );
        assert_eq!(
            FlowResult::Breaks.combine(FlowResult::Breaks),
            FlowResult::Breaks
        );
    }

    #[test]
    fn test_nested_loops_break() {
        let symbols = SymbolTable::new();

        // Inner loop with break
        let inner_loop = HirStmt::DoWhile(HirDoWhile {
            span: Span::default(),
            condition: HirExpr::new(
                Span::default(),
                Ty::Bool,
                HirExprKind::BoolLiteral(true),
            ),
            body: Box::new(make_break()),
            attrs: Vec::new(),
        });

        // Outer loop containing inner loop
        let outer_loop = HirStmt::DoWhile(HirDoWhile {
            span: Span::default(),
            condition: HirExpr::new(
                Span::default(),
                Ty::Bool,
                HirExprKind::BoolLiteral(true),
            ),
            body: Box::new(inner_loop),
            attrs: Vec::new(),
        });

        let func = make_function("test", Ty::Void, make_block(vec![outer_loop]));

        let mut validator = ControlFlowValidator::new(&symbols);
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }
}
