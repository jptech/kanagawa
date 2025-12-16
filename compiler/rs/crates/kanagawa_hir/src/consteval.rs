//! Constant expression evaluation.
//!
//! This module implements compile-time evaluation of constant expressions,
//! used for array dimensions, template arguments, and constant propagation.

use crate::{DefId, HirBinaryOp, HirExpr, HirExprKind, HirUnaryOp, Ty};
use std::collections::HashMap;

/// Result of constant evaluation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ConstValue {
    /// Integer value with known width.
    Int {
        value: i128,
        width: u32,
        signed: bool,
    },
    /// Boolean value.
    Bool(bool),
    /// String literal.
    String(String),
    /// Array of constant values.
    Array(Vec<ConstValue>),
    /// Struct/class initializer with field values.
    Struct(Vec<(String, ConstValue)>),
    /// Evaluation failed (not a constant).
    NotConst,
    /// Evaluation produced an error.
    Error(ConstEvalError),
}

impl ConstValue {
    /// Create a signed integer constant.
    pub fn signed(value: i128, width: u32) -> Self {
        ConstValue::Int {
            value,
            width,
            signed: true,
        }
    }

    /// Create an unsigned integer constant.
    pub fn unsigned(value: i128, width: u32) -> Self {
        ConstValue::Int {
            value,
            width,
            signed: false,
        }
    }

    /// Check if this is a constant integer.
    pub fn is_int(&self) -> bool {
        matches!(self, ConstValue::Int { .. })
    }

    /// Check if this is a constant boolean.
    pub fn is_bool(&self) -> bool {
        matches!(self, ConstValue::Bool(_))
    }

    /// Check if this value represents a compile-time constant.
    pub fn is_const(&self) -> bool {
        !matches!(self, ConstValue::NotConst | ConstValue::Error(_))
    }

    /// Get the integer value if this is an integer constant.
    pub fn as_int(&self) -> Option<i128> {
        match self {
            ConstValue::Int { value, .. } => Some(*value),
            _ => None,
        }
    }

    /// Get the boolean value if this is a boolean constant.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            ConstValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Convert to i64 if within range.
    pub fn to_i64(&self) -> Option<i64> {
        match self {
            ConstValue::Int { value, .. } => {
                if *value >= i64::MIN as i128 && *value <= i64::MAX as i128 {
                    Some(*value as i64)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Convert to u64 if within range.
    pub fn to_u64(&self) -> Option<u64> {
        match self {
            ConstValue::Int { value, signed, .. } => {
                if *signed && *value < 0 {
                    None
                } else if *value >= 0 && *value <= u64::MAX as i128 {
                    Some(*value as u64)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

/// Constant evaluation errors.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ConstEvalError {
    /// Division by zero.
    DivisionByZero,
    /// Integer overflow.
    Overflow,
    /// Undefined variable in constant context.
    UndefinedVariable(String),
    /// Expression is not a constant.
    NonConstantExpression(String),
    /// Unsupported operation in constant context.
    UnsupportedOperation(String),
    /// Type mismatch in operation.
    TypeMismatch { expected: String, found: String },
    /// Shift amount out of range.
    ShiftOutOfRange { amount: i128, width: u32 },
}

impl std::fmt::Display for ConstEvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConstEvalError::DivisionByZero => write!(f, "division by zero"),
            ConstEvalError::Overflow => write!(f, "integer overflow"),
            ConstEvalError::UndefinedVariable(name) => {
                write!(f, "undefined variable '{}' in constant context", name)
            }
            ConstEvalError::NonConstantExpression(desc) => {
                write!(f, "expression '{}' is not a constant", desc)
            }
            ConstEvalError::UnsupportedOperation(op) => {
                write!(f, "unsupported operation '{}' in constant context", op)
            }
            ConstEvalError::TypeMismatch { expected, found } => {
                write!(f, "type mismatch: expected {}, found {}", expected, found)
            }
            ConstEvalError::ShiftOutOfRange { amount, width } => {
                write!(
                    f,
                    "shift amount {} is out of range for {}-bit type",
                    amount, width
                )
            }
        }
    }
}

/// Constant expression evaluator.
pub struct ConstEvaluator {
    /// Known constant bindings in current scope.
    bindings: HashMap<DefId, ConstValue>,
    /// Named constant bindings (for identifiers without DefId).
    named_bindings: HashMap<String, ConstValue>,
}

impl ConstEvaluator {
    /// Create a new constant evaluator.
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
            named_bindings: HashMap::new(),
        }
    }

    /// Bind a definition to a constant value.
    pub fn bind(&mut self, def_id: DefId, value: ConstValue) {
        self.bindings.insert(def_id, value);
    }

    /// Bind a name to a constant value.
    pub fn bind_name(&mut self, name: String, value: ConstValue) {
        self.named_bindings.insert(name, value);
    }

    /// Evaluate an expression to a constant value.
    pub fn eval(&self, expr: &HirExpr) -> ConstValue {
        self.eval_expr(expr)
    }

    /// Evaluate an expression, returning a result.
    pub fn try_eval(&self, expr: &HirExpr) -> Result<ConstValue, ConstEvalError> {
        let result = self.eval_expr(expr);
        match result {
            ConstValue::Error(e) => Err(e),
            ConstValue::NotConst => Err(ConstEvalError::NonConstantExpression(
                "expression".to_string(),
            )),
            v => Ok(v),
        }
    }

    fn eval_expr(&self, expr: &HirExpr) -> ConstValue {
        match &expr.kind {
            // Literals
            HirExprKind::IntLiteral { value, suffix } => {
                let (width, signed) = match suffix {
                    Some(s) => (s.width as u32, s.signed),
                    None => (64, true), // Default to i64
                };
                ConstValue::Int {
                    value: *value,
                    width,
                    signed,
                }
            }

            HirExprKind::BoolLiteral(b) => ConstValue::Bool(*b),

            HirExprKind::StringLiteral(s) => ConstValue::String(s.clone()),

            // Binary operations
            HirExprKind::Binary { op, lhs, rhs } => {
                self.eval_binary(*op, &self.eval_expr(lhs), &self.eval_expr(rhs))
            }

            // Unary operations
            HirExprKind::Unary { op, operand } => self.eval_unary(*op, &self.eval_expr(operand)),

            // Conditional (ternary)
            HirExprKind::Ternary {
                condition,
                then_expr,
                else_expr,
            } => match self.eval_expr(condition) {
                ConstValue::Bool(true) => self.eval_expr(then_expr),
                ConstValue::Bool(false) => self.eval_expr(else_expr),
                ConstValue::NotConst => ConstValue::NotConst,
                ConstValue::Error(e) => ConstValue::Error(e),
                _ => ConstValue::Error(ConstEvalError::TypeMismatch {
                    expected: "bool".to_string(),
                    found: "non-bool".to_string(),
                }),
            },

            // Identifier lookup
            HirExprKind::Ident { name, def_id } => {
                // Try DefId first, then named binding
                if let Some(value) = self.bindings.get(def_id) {
                    return value.clone();
                }
                if let Some(value) = self.named_bindings.get(name) {
                    return value.clone();
                }
                ConstValue::NotConst
            }

            // Qualified identifier lookup
            HirExprKind::QualifiedIdent { path, def_id } => {
                if let Some(value) = self.bindings.get(def_id) {
                    return value.clone();
                }
                let name = path.join("::");
                if let Some(value) = self.named_bindings.get(&name) {
                    return value.clone();
                }
                ConstValue::NotConst
            }

            // Parenthesized expression
            HirExprKind::Paren(inner) => self.eval_expr(inner),

            // Cast expression - handle simple numeric casts
            HirExprKind::Cast { ty, expr } => {
                let inner = self.eval_expr(expr);
                self.eval_cast(inner, ty)
            }

            // Initializer list (array literal)
            HirExprKind::InitializerList(elements) => {
                let mut values = Vec::with_capacity(elements.len());
                for elem in elements {
                    let val = self.eval_expr(elem);
                    if !val.is_const() {
                        return ConstValue::NotConst;
                    }
                    if let ConstValue::Error(e) = val {
                        return ConstValue::Error(e);
                    }
                    values.push(val);
                }
                ConstValue::Array(values)
            }

            // Sizeof expressions
            HirExprKind::Sizeof { kind, operand } => {
                // Get the type of the operand
                let ty = &operand.ty;
                match kind {
                    crate::HirSizeofKind::Bits => {
                        if let Some(width) = ty.width() {
                            ConstValue::unsigned(width as i128, 64)
                        } else {
                            ConstValue::NotConst
                        }
                    }
                    crate::HirSizeofKind::Bytes => {
                        if let Some(width) = ty.width() {
                            ConstValue::unsigned(((width + 7) / 8) as i128, 64)
                        } else {
                            ConstValue::NotConst
                        }
                    }
                    crate::HirSizeofKind::Clog2 => {
                        if let Some(width) = ty.width() {
                            let clog2 = if width == 0 { 0 } else { (width as f64).log2().ceil() as u32 };
                            ConstValue::unsigned(clog2 as i128, 64)
                        } else {
                            ConstValue::NotConst
                        }
                    }
                }
            }

            // Member access - could be enum variant
            HirExprKind::Member { object, member, .. } => {
                // Try to look up qualified name
                let qualified_name = match &object.kind {
                    HirExprKind::Ident { name, .. } => format!("{}::{}", name, member),
                    _ => return ConstValue::NotConst,
                };
                if let Some(value) = self.named_bindings.get(&qualified_name) {
                    return value.clone();
                }
                ConstValue::NotConst
            }

            // Static expression - evaluate inner
            HirExprKind::Static(inner) => self.eval_expr(inner),

            // Everything else is not a constant
            _ => ConstValue::NotConst,
        }
    }

    fn eval_binary(&self, op: HirBinaryOp, left: &ConstValue, right: &ConstValue) -> ConstValue {
        // Handle error propagation
        if let ConstValue::Error(e) = left {
            return ConstValue::Error(e.clone());
        }
        if let ConstValue::Error(e) = right {
            return ConstValue::Error(e.clone());
        }
        if matches!(left, ConstValue::NotConst) || matches!(right, ConstValue::NotConst) {
            return ConstValue::NotConst;
        }

        match (op, left, right) {
            // Integer arithmetic
            (
                HirBinaryOp::Add,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Int {
                value: l.wrapping_add(*r),
                width: *width,
                signed: *signed,
            },

            (
                HirBinaryOp::Sub,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Int {
                value: l.wrapping_sub(*r),
                width: *width,
                signed: *signed,
            },

            (
                HirBinaryOp::Mul,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Int {
                value: l.wrapping_mul(*r),
                width: *width,
                signed: *signed,
            },

            (
                HirBinaryOp::Div,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => {
                if *r == 0 {
                    ConstValue::Error(ConstEvalError::DivisionByZero)
                } else {
                    ConstValue::Int {
                        value: l / r,
                        width: *width,
                        signed: *signed,
                    }
                }
            }

            (
                HirBinaryOp::Mod,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => {
                if *r == 0 {
                    ConstValue::Error(ConstEvalError::DivisionByZero)
                } else {
                    ConstValue::Int {
                        value: l % r,
                        width: *width,
                        signed: *signed,
                    }
                }
            }

            // Bitwise operations
            (
                HirBinaryOp::BitwiseAnd,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Int {
                value: l & r,
                width: *width,
                signed: *signed,
            },

            (
                HirBinaryOp::BitwiseOr,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Int {
                value: l | r,
                width: *width,
                signed: *signed,
            },

            (
                HirBinaryOp::BitwiseXor,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Int {
                value: l ^ r,
                width: *width,
                signed: *signed,
            },

            // Shift operations
            (
                HirBinaryOp::Shl,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => {
                if *r < 0 || *r >= *width as i128 {
                    ConstValue::Error(ConstEvalError::ShiftOutOfRange {
                        amount: *r,
                        width: *width,
                    })
                } else {
                    ConstValue::Int {
                        value: l << (*r as u32),
                        width: *width,
                        signed: *signed,
                    }
                }
            }

            (
                HirBinaryOp::Shr,
                ConstValue::Int {
                    value: l,
                    width,
                    signed,
                },
                ConstValue::Int { value: r, .. },
            ) => {
                if *r < 0 || *r >= *width as i128 {
                    ConstValue::Error(ConstEvalError::ShiftOutOfRange {
                        amount: *r,
                        width: *width,
                    })
                } else {
                    ConstValue::Int {
                        value: l >> (*r as u32),
                        width: *width,
                        signed: *signed,
                    }
                }
            }

            // Comparison operations
            (
                HirBinaryOp::Eq,
                ConstValue::Int { value: l, .. },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Bool(l == r),

            (
                HirBinaryOp::Ne,
                ConstValue::Int { value: l, .. },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Bool(l != r),

            (
                HirBinaryOp::Lt,
                ConstValue::Int { value: l, .. },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Bool(l < r),

            (
                HirBinaryOp::Le,
                ConstValue::Int { value: l, .. },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Bool(l <= r),

            (
                HirBinaryOp::Gt,
                ConstValue::Int { value: l, .. },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Bool(l > r),

            (
                HirBinaryOp::Ge,
                ConstValue::Int { value: l, .. },
                ConstValue::Int { value: r, .. },
            ) => ConstValue::Bool(l >= r),

            // Boolean operations
            (HirBinaryOp::LogicalAnd, ConstValue::Bool(l), ConstValue::Bool(r)) => {
                ConstValue::Bool(*l && *r)
            }

            (HirBinaryOp::LogicalOr, ConstValue::Bool(l), ConstValue::Bool(r)) => {
                ConstValue::Bool(*l || *r)
            }

            (HirBinaryOp::LogicalXor, ConstValue::Bool(l), ConstValue::Bool(r)) => {
                ConstValue::Bool(*l ^ *r)
            }

            (HirBinaryOp::Eq, ConstValue::Bool(l), ConstValue::Bool(r)) => {
                ConstValue::Bool(l == r)
            }

            (HirBinaryOp::Ne, ConstValue::Bool(l), ConstValue::Bool(r)) => {
                ConstValue::Bool(l != r)
            }

            // String concatenation
            (HirBinaryOp::Add, ConstValue::String(l), ConstValue::String(r)) => {
                ConstValue::String(format!("{}{}", l, r))
            }

            // String comparison
            (HirBinaryOp::Eq, ConstValue::String(l), ConstValue::String(r)) => {
                ConstValue::Bool(l == r)
            }

            (HirBinaryOp::Ne, ConstValue::String(l), ConstValue::String(r)) => {
                ConstValue::Bool(l != r)
            }

            // Unsupported combination
            _ => ConstValue::Error(ConstEvalError::UnsupportedOperation(format!(
                "{:?}",
                op
            ))),
        }
    }

    fn eval_unary(&self, op: HirUnaryOp, operand: &ConstValue) -> ConstValue {
        // Handle error propagation
        if let ConstValue::Error(e) = operand {
            return ConstValue::Error(e.clone());
        }
        if matches!(operand, ConstValue::NotConst) {
            return ConstValue::NotConst;
        }

        match (op, operand) {
            // Integer negation
            (
                HirUnaryOp::Neg,
                ConstValue::Int {
                    value,
                    width,
                    signed,
                },
            ) => ConstValue::Int {
                value: value.wrapping_neg(),
                width: *width,
                signed: *signed,
            },

            // Bitwise invert (complement)
            (
                HirUnaryOp::Invert,
                ConstValue::Int {
                    value,
                    width,
                    signed,
                },
            ) => ConstValue::Int {
                value: !value,
                width: *width,
                signed: *signed,
            },

            // Logical not
            (HirUnaryOp::Not, ConstValue::Bool(b)) => ConstValue::Bool(!b),

            // Unsupported (increment/decrement are not constant expressions)
            _ => ConstValue::Error(ConstEvalError::UnsupportedOperation(format!(
                "{:?}",
                op
            ))),
        }
    }

    fn eval_cast(&self, value: ConstValue, target_ty: &Ty) -> ConstValue {
        match (&value, target_ty) {
            // Int to int cast
            (ConstValue::Int { value, .. }, Ty::Signed(width)) => ConstValue::Int {
                value: *value,
                width: *width,
                signed: true,
            },

            (ConstValue::Int { value, .. }, Ty::Unsigned(width)) => ConstValue::Int {
                value: *value,
                width: *width,
                signed: false,
            },

            // Bool to int
            (ConstValue::Bool(b), Ty::Signed(width)) => ConstValue::Int {
                value: if *b { 1 } else { 0 },
                width: *width,
                signed: true,
            },

            (ConstValue::Bool(b), Ty::Unsigned(width)) => ConstValue::Int {
                value: if *b { 1 } else { 0 },
                width: *width,
                signed: false,
            },

            // Int to bool
            (ConstValue::Int { value, .. }, Ty::Bool) => ConstValue::Bool(*value != 0),

            // Const passthrough
            (v, Ty::Const(inner)) => self.eval_cast(v.clone(), inner),

            // Pass through NotConst
            (ConstValue::NotConst, _) => ConstValue::NotConst,

            // Unsupported cast
            _ => ConstValue::NotConst,
        }
    }
}

impl Default for ConstEvaluator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Span;

    fn make_int_lit(value: i128) -> HirExpr {
        HirExpr {
            kind: HirExprKind::IntLiteral {
                value,
                suffix: None,
            },
            ty: Ty::Signed(64),
            span: Span { start: 0, end: 0, file_index: 0 },
        }
    }

    fn make_bool_lit(value: bool) -> HirExpr {
        HirExpr {
            kind: HirExprKind::BoolLiteral(value),
            ty: Ty::Bool,
            span: Span { start: 0, end: 0, file_index: 0 },
        }
    }

    fn make_binary(op: HirBinaryOp, left: HirExpr, right: HirExpr) -> HirExpr {
        HirExpr {
            kind: HirExprKind::Binary {
                op,
                lhs: Box::new(left),
                rhs: Box::new(right),
            },
            ty: Ty::Signed(64),
            span: Span { start: 0, end: 0, file_index: 0 },
        }
    }

    #[test]
    fn test_int_literal() {
        let eval = ConstEvaluator::new();
        let expr = make_int_lit(42);
        assert_eq!(eval.eval(&expr).as_int(), Some(42));
    }

    #[test]
    fn test_bool_literal() {
        let eval = ConstEvaluator::new();
        let expr = make_bool_lit(true);
        assert_eq!(eval.eval(&expr).as_bool(), Some(true));
    }

    #[test]
    fn test_addition() {
        let eval = ConstEvaluator::new();
        let expr = make_binary(HirBinaryOp::Add, make_int_lit(10), make_int_lit(20));
        assert_eq!(eval.eval(&expr).as_int(), Some(30));
    }

    #[test]
    fn test_subtraction() {
        let eval = ConstEvaluator::new();
        let expr = make_binary(HirBinaryOp::Sub, make_int_lit(30), make_int_lit(10));
        assert_eq!(eval.eval(&expr).as_int(), Some(20));
    }

    #[test]
    fn test_multiplication() {
        let eval = ConstEvaluator::new();
        let expr = make_binary(HirBinaryOp::Mul, make_int_lit(6), make_int_lit(7));
        assert_eq!(eval.eval(&expr).as_int(), Some(42));
    }

    #[test]
    fn test_division() {
        let eval = ConstEvaluator::new();
        let expr = make_binary(HirBinaryOp::Div, make_int_lit(100), make_int_lit(10));
        assert_eq!(eval.eval(&expr).as_int(), Some(10));
    }

    #[test]
    fn test_division_by_zero() {
        let eval = ConstEvaluator::new();
        let expr = make_binary(HirBinaryOp::Div, make_int_lit(100), make_int_lit(0));
        match eval.eval(&expr) {
            ConstValue::Error(ConstEvalError::DivisionByZero) => {}
            _ => panic!("Expected division by zero error"),
        }
    }

    #[test]
    fn test_comparison() {
        let eval = ConstEvaluator::new();

        let lt = make_binary(HirBinaryOp::Lt, make_int_lit(5), make_int_lit(10));
        assert_eq!(eval.eval(&lt).as_bool(), Some(true));

        let gt = make_binary(HirBinaryOp::Gt, make_int_lit(5), make_int_lit(10));
        assert_eq!(eval.eval(&gt).as_bool(), Some(false));

        let eq = make_binary(HirBinaryOp::Eq, make_int_lit(5), make_int_lit(5));
        assert_eq!(eval.eval(&eq).as_bool(), Some(true));
    }

    #[test]
    fn test_boolean_ops() {
        let eval = ConstEvaluator::new();

        let and_expr = HirExpr {
            kind: HirExprKind::Binary {
                op: HirBinaryOp::LogicalAnd,
                lhs: Box::new(make_bool_lit(true)),
                rhs: Box::new(make_bool_lit(false)),
            },
            ty: Ty::Bool,
            span: Span { start: 0, end: 0, file_index: 0 },
        };
        assert_eq!(eval.eval(&and_expr).as_bool(), Some(false));

        let or_expr = HirExpr {
            kind: HirExprKind::Binary {
                op: HirBinaryOp::LogicalOr,
                lhs: Box::new(make_bool_lit(true)),
                rhs: Box::new(make_bool_lit(false)),
            },
            ty: Ty::Bool,
            span: Span { start: 0, end: 0, file_index: 0 },
        };
        assert_eq!(eval.eval(&or_expr).as_bool(), Some(true));
    }

    #[test]
    fn test_complex_expression() {
        let eval = ConstEvaluator::new();
        // (10 + 20) * 2 = 60
        let add = make_binary(HirBinaryOp::Add, make_int_lit(10), make_int_lit(20));
        let mul = make_binary(HirBinaryOp::Mul, add, make_int_lit(2));
        assert_eq!(eval.eval(&mul).as_int(), Some(60));
    }

    #[test]
    fn test_bitwise_ops() {
        let eval = ConstEvaluator::new();

        let and = make_binary(
            HirBinaryOp::BitwiseAnd,
            make_int_lit(0b1111),
            make_int_lit(0b1010),
        );
        assert_eq!(eval.eval(&and).as_int(), Some(0b1010));

        let or = make_binary(
            HirBinaryOp::BitwiseOr,
            make_int_lit(0b1100),
            make_int_lit(0b0011),
        );
        assert_eq!(eval.eval(&or).as_int(), Some(0b1111));
    }

    #[test]
    fn test_named_binding() {
        let mut eval = ConstEvaluator::new();
        eval.bind_name("N".to_string(), ConstValue::signed(100, 64));

        let ident = HirExpr {
            kind: HirExprKind::Ident {
                name: "N".to_string(),
                def_id: DefId(0),
            },
            ty: Ty::Signed(64),
            span: Span { start: 0, end: 0, file_index: 0 },
        };
        assert_eq!(eval.eval(&ident).as_int(), Some(100));
    }
}
