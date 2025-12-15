//! Type rules for the Kanagawa type system.
//!
//! This module defines:
//! - Operator result types
//! - Type conversion rules (implicit and explicit)
//! - Type compatibility checks
//! - Width computation rules

use kanagawa_hir::Ty;

/// Result of a type compatibility check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compatibility {
    /// Types are identical.
    Identical,
    /// Types are compatible via implicit widening.
    ImplicitWidening,
    /// Types are compatible via explicit cast only.
    ExplicitCastRequired,
    /// Types are incompatible.
    Incompatible,
}

impl Compatibility {
    /// Check if types are compatible without explicit cast.
    pub fn is_implicit(&self) -> bool {
        matches!(self, Compatibility::Identical | Compatibility::ImplicitWidening)
    }

    /// Check if types can be converted at all.
    pub fn is_convertible(&self) -> bool {
        !matches!(self, Compatibility::Incompatible)
    }
}

/// Check if two types are compatible for assignment.
///
/// Returns the compatibility level between source and target types.
/// Rules:
/// - Same types are always compatible
/// - Widening (smaller to larger) is implicitly allowed
/// - Narrowing requires explicit cast
/// - Signed/unsigned conversion requires cast for same width
pub fn check_assignment_compatibility(target: &Ty, source: &Ty) -> Compatibility {
    // Handle identical types first
    if types_equal(target, source) {
        return Compatibility::Identical;
    }

    // Handle const stripping (can assign const to non-const)
    let target = target.unconst();
    let source = source.unconst();

    match (target, source) {
        // Integer conversions
        (Ty::Unsigned(tw), Ty::Unsigned(sw)) => {
            if *sw <= *tw {
                Compatibility::ImplicitWidening
            } else {
                Compatibility::ExplicitCastRequired
            }
        }
        (Ty::Signed(tw), Ty::Signed(sw)) => {
            if *sw <= *tw {
                Compatibility::ImplicitWidening
            } else {
                Compatibility::ExplicitCastRequired
            }
        }
        // Unsigned to signed: need extra bit for sign
        (Ty::Signed(tw), Ty::Unsigned(sw)) => {
            if *sw < *tw {
                // Unsigned fits in signed with room for sign bit
                Compatibility::ImplicitWidening
            } else {
                Compatibility::ExplicitCastRequired
            }
        }
        // Signed to unsigned: always requires cast
        (Ty::Unsigned(_), Ty::Signed(_)) => Compatibility::ExplicitCastRequired,

        // Bool can be widened to integer
        (Ty::Unsigned(w), Ty::Bool) if *w >= 1 => Compatibility::ImplicitWidening,
        (Ty::Signed(w), Ty::Bool) if *w >= 2 => Compatibility::ImplicitWidening,

        // Same compound types
        (Ty::Array { element: te, dims: td, .. }, Ty::Array { element: se, dims: sd, .. }) => {
            if td == sd && check_assignment_compatibility(te, se).is_implicit() {
                Compatibility::Identical
            } else {
                Compatibility::Incompatible
            }
        }

        // Struct/Class/Union by name
        (Ty::Struct { name: tn, .. }, Ty::Struct { name: sn, .. }) if tn == sn => {
            Compatibility::Identical
        }
        (Ty::Class { name: tn, .. }, Ty::Class { name: sn, .. }) if tn == sn => {
            Compatibility::Identical
        }
        (Ty::Union { name: tn, .. }, Ty::Union { name: sn, .. }) if tn == sn => {
            Compatibility::Identical
        }
        (Ty::Enum { name: tn, .. }, Ty::Enum { name: sn, .. }) if tn == sn => {
            Compatibility::Identical
        }

        // Everything else is incompatible
        _ => Compatibility::Incompatible,
    }
}

/// Check if two types are structurally equal.
pub fn types_equal(a: &Ty, b: &Ty) -> bool {
    match (a, b) {
        (Ty::Void, Ty::Void) => true,
        (Ty::Bool, Ty::Bool) => true,
        (Ty::Float, Ty::Float) => true,
        (Ty::String, Ty::String) => true,
        (Ty::Unsigned(wa), Ty::Unsigned(wb)) => wa == wb,
        (Ty::Signed(wa), Ty::Signed(wb)) => wa == wb,
        (Ty::Const(a), Ty::Const(b)) => types_equal(a, b),
        (Ty::Array { element: ea, dims: da, .. }, Ty::Array { element: eb, dims: db, .. }) => {
            da == db && types_equal(ea, eb)
        }
        (Ty::Struct { name: na, .. }, Ty::Struct { name: nb, .. }) => na == nb,
        (Ty::Class { name: na, .. }, Ty::Class { name: nb, .. }) => na == nb,
        (Ty::Union { name: na, .. }, Ty::Union { name: nb, .. }) => na == nb,
        (Ty::Enum { name: na, .. }, Ty::Enum { name: nb, .. }) => na == nb,
        (Ty::Function { return_ty: ra, params: pa, .. }, Ty::Function { return_ty: rb, params: pb, .. }) => {
            types_equal(ra, rb) && pa.len() == pb.len() && pa.iter().zip(pb).all(|(a, b)| types_equal(&a.ty, &b.ty))
        }
        _ => false,
    }
}

/// Compute the result type of a binary arithmetic operation.
///
/// Kanagawa follows these rules:
/// - Addition: max(a,b)+1 bits to prevent overflow
/// - Subtraction: signed result with max(a,b)+1 bits (can be negative)
/// - Multiplication: a+b bits (full precision)
/// - Division/Modulo: same as numerator
pub fn binary_arithmetic_result_type(op: BinaryOp, lhs: &Ty, rhs: &Ty) -> Option<Ty> {
    match op {
        BinaryOp::Add => binary_add_type(lhs, rhs),
        BinaryOp::Sub => binary_sub_type(lhs, rhs),
        BinaryOp::Mul => binary_mul_type(lhs, rhs),
        BinaryOp::Div | BinaryOp::Mod => binary_div_mod_type(lhs, rhs),
        BinaryOp::Shl | BinaryOp::Shr => binary_shift_type(lhs, rhs),
        BinaryOp::BitAnd | BinaryOp::BitOr | BinaryOp::BitXor => binary_bitwise_type(lhs, rhs),
        BinaryOp::LogAnd | BinaryOp::LogOr | BinaryOp::LogXor => Some(Ty::Bool),
        BinaryOp::Eq | BinaryOp::Ne | BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
            Some(Ty::Bool)
        }
    }
}

/// Binary operators supported in the type system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    // Arithmetic
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    // Shift
    Shl,
    Shr,
    // Bitwise
    BitAnd,
    BitOr,
    BitXor,
    // Logical
    LogAnd,
    LogOr,
    LogXor,
    // Comparison
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Get integer width, handling const wrapper.
fn get_int_width(ty: &Ty) -> Option<(u32, bool)> {
    match ty.unconst() {
        Ty::Unsigned(w) => Some((*w, false)),
        Ty::Signed(w) => Some((*w, true)),
        Ty::Bool => Some((1, false)),
        _ => None,
    }
}

/// Addition: max(a,b)+1 bits, preserves signedness if both same, else signed
fn binary_add_type(lhs: &Ty, rhs: &Ty) -> Option<Ty> {
    let (lw, ls) = get_int_width(lhs)?;
    let (rw, rs) = get_int_width(rhs)?;

    let result_width = lw.max(rw) + 1;

    // If either is signed, result is signed
    if ls || rs {
        Some(Ty::Signed(result_width))
    } else {
        Some(Ty::Unsigned(result_width))
    }
}

/// Subtraction: always signed (can be negative), max(a,b)+1 bits
fn binary_sub_type(lhs: &Ty, rhs: &Ty) -> Option<Ty> {
    let (lw, ls) = get_int_width(lhs)?;
    let (rw, rs) = get_int_width(rhs)?;

    // For unsigned subtraction, we need to convert to signed first
    // because the result can be negative
    let lw_signed = if ls { lw } else { lw + 1 };
    let rw_signed = if rs { rw } else { rw + 1 };

    let result_width = lw_signed.max(rw_signed) + 1;
    Some(Ty::Signed(result_width))
}

/// Multiplication: a+b bits (full precision)
fn binary_mul_type(lhs: &Ty, rhs: &Ty) -> Option<Ty> {
    let (lw, ls) = get_int_width(lhs)?;
    let (rw, rs) = get_int_width(rhs)?;

    let result_width = lw + rw;

    if ls || rs {
        Some(Ty::Signed(result_width))
    } else {
        Some(Ty::Unsigned(result_width))
    }
}

/// Division/Modulo: same width as numerator
fn binary_div_mod_type(lhs: &Ty, _rhs: &Ty) -> Option<Ty> {
    match lhs.unconst() {
        Ty::Unsigned(w) => Some(Ty::Unsigned(*w)),
        Ty::Signed(w) => Some(Ty::Signed(*w)),
        _ => None,
    }
}

/// Shift: result has width of lhs, shift amount treated as unsigned
fn binary_shift_type(lhs: &Ty, _rhs: &Ty) -> Option<Ty> {
    match lhs.unconst() {
        Ty::Unsigned(w) => Some(Ty::Unsigned(*w)),
        Ty::Signed(w) => Some(Ty::Signed(*w)),
        _ => None,
    }
}

/// Bitwise ops: max width of operands
fn binary_bitwise_type(lhs: &Ty, rhs: &Ty) -> Option<Ty> {
    let (lw, ls) = get_int_width(lhs)?;
    let (rw, rs) = get_int_width(rhs)?;

    let result_width = lw.max(rw);

    // Bitwise on mixed signed/unsigned is typically unsigned
    if ls && rs {
        Some(Ty::Signed(result_width))
    } else {
        Some(Ty::Unsigned(result_width))
    }
}

/// Compute result type for unary operations.
pub fn unary_result_type(op: UnaryOp, operand: &Ty) -> Option<Ty> {
    match op {
        UnaryOp::Neg => {
            // Negation converts to signed and adds a bit
            let (w, _) = get_int_width(operand)?;
            Some(Ty::Signed(w + 1))
        }
        UnaryOp::Not => {
            // Logical not returns bool
            Some(Ty::Bool)
        }
        UnaryOp::BitNot => {
            // Bitwise not preserves type
            match operand.unconst() {
                Ty::Unsigned(w) => Some(Ty::Unsigned(*w)),
                Ty::Signed(w) => Some(Ty::Signed(*w)),
                _ => None,
            }
        }
    }
}

/// Unary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    /// Arithmetic negation (-)
    Neg,
    /// Logical not (!)
    Not,
    /// Bitwise not (~)
    BitNot,
}

/// Infer type for an integer literal based on value.
///
/// Selects the smallest unsigned type that can hold the value.
/// For negative values, returns signed type (minimum 2 bits).
pub fn infer_integer_literal_type(value: i128) -> Ty {
    if value < 0 {
        // Signed: need enough bits for magnitude + sign, minimum 2 bits
        let magnitude = value.unsigned_abs();
        let bits = if magnitude.is_power_of_two() {
            // -2^n needs exactly n+1 bits (e.g., -128 = -2^7 needs 8 bits)
            let n = magnitude.trailing_zeros();
            n + 1
        } else {
            // For non-powers-of-2, calculate bits needed for magnitude and add 1 for sign
            let bits_needed = 128 - magnitude.leading_zeros();
            bits_needed + 1
        };
        // Ensure minimum of 2 bits for signed integers
        Ty::Signed(bits.max(2))
    } else {
        // Unsigned: need enough bits for value
        let bits_needed = if value == 0 {
            1
        } else {
            128 - (value as u128).leading_zeros()
        };
        Ty::Unsigned(bits_needed)
    }
}

/// Infer type for an integer literal in a specific context.
///
/// If context type is known, try to fit the literal into that type.
pub fn infer_integer_literal_in_context(value: i128, context: Option<&Ty>) -> Ty {
    match context {
        Some(ctx) => {
            // Check if value fits in context type
            if can_represent(ctx, value) {
                ctx.clone()
            } else {
                // Fall back to natural inference
                infer_integer_literal_type(value)
            }
        }
        None => infer_integer_literal_type(value),
    }
}

/// Check if a type can represent a given integer value.
pub fn can_represent(ty: &Ty, value: i128) -> bool {
    match ty.unconst() {
        Ty::Unsigned(w) => {
            if value < 0 {
                false
            } else {
                let max = if *w >= 128 {
                    u128::MAX
                } else {
                    (1u128 << w) - 1
                };
                (value as u128) <= max
            }
        }
        Ty::Signed(w) => {
            if *w >= 128 {
                true
            } else {
                let min = -(1i128 << (w - 1));
                let max = (1i128 << (w - 1)) - 1;
                value >= min && value <= max
            }
        }
        Ty::Bool => value == 0 || value == 1,
        _ => false,
    }
}

/// Get the common type for two operands (type promotion).
///
/// Used when combining values in expressions.
pub fn common_type(a: &Ty, b: &Ty) -> Option<Ty> {
    let (aw, as_) = get_int_width(a)?;
    let (bw, bs) = get_int_width(b)?;

    let width = aw.max(bw);
    let signed = as_ || bs;

    if signed {
        Some(Ty::Signed(width))
    } else {
        Some(Ty::Unsigned(width))
    }
}

/// Check if a cast from one type to another is valid.
pub fn is_valid_cast(from: &Ty, to: &Ty) -> bool {
    match (from.unconst(), to.unconst()) {
        // Integer to integer: always valid (may truncate or extend)
        (Ty::Unsigned(_) | Ty::Signed(_) | Ty::Bool, Ty::Unsigned(_) | Ty::Signed(_) | Ty::Bool) => {
            true
        }
        // Float to int and int to float
        (Ty::Float, Ty::Unsigned(_) | Ty::Signed(_)) => true,
        (Ty::Unsigned(_) | Ty::Signed(_), Ty::Float) => true,
        // Same compound types
        (Ty::Struct { name: a, .. }, Ty::Struct { name: b, .. }) if a == b => true,
        (Ty::Class { name: a, .. }, Ty::Class { name: b, .. }) if a == b => true,
        (Ty::Union { name: a, .. }, Ty::Union { name: b, .. }) if a == b => true,
        // Everything else is invalid
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_integer_literal_inference() {
        assert_eq!(infer_integer_literal_type(0), Ty::Unsigned(1));
        assert_eq!(infer_integer_literal_type(1), Ty::Unsigned(1));
        assert_eq!(infer_integer_literal_type(255), Ty::Unsigned(8));
        assert_eq!(infer_integer_literal_type(256), Ty::Unsigned(9));
        assert_eq!(infer_integer_literal_type(-1), Ty::Signed(2));
        assert_eq!(infer_integer_literal_type(-128), Ty::Signed(8));
    }

    #[test]
    fn test_addition_type() {
        // u8 + u8 = u9
        assert_eq!(
            binary_add_type(&Ty::Unsigned(8), &Ty::Unsigned(8)),
            Some(Ty::Unsigned(9))
        );
        // u8 + u16 = u17
        assert_eq!(
            binary_add_type(&Ty::Unsigned(8), &Ty::Unsigned(16)),
            Some(Ty::Unsigned(17))
        );
        // i8 + i8 = i9
        assert_eq!(
            binary_add_type(&Ty::Signed(8), &Ty::Signed(8)),
            Some(Ty::Signed(9))
        );
        // u8 + i8 = i9 (mixed -> signed)
        assert_eq!(
            binary_add_type(&Ty::Unsigned(8), &Ty::Signed(8)),
            Some(Ty::Signed(9))
        );
    }

    #[test]
    fn test_subtraction_type() {
        // u8 - u8 = i10 (unsigned sub can be negative)
        assert_eq!(
            binary_sub_type(&Ty::Unsigned(8), &Ty::Unsigned(8)),
            Some(Ty::Signed(10))
        );
        // i8 - i8 = i9
        assert_eq!(
            binary_sub_type(&Ty::Signed(8), &Ty::Signed(8)),
            Some(Ty::Signed(9))
        );
    }

    #[test]
    fn test_multiplication_type() {
        // u8 * u8 = u16
        assert_eq!(
            binary_mul_type(&Ty::Unsigned(8), &Ty::Unsigned(8)),
            Some(Ty::Unsigned(16))
        );
        // i8 * i8 = i16
        assert_eq!(
            binary_mul_type(&Ty::Signed(8), &Ty::Signed(8)),
            Some(Ty::Signed(16))
        );
    }

    #[test]
    fn test_assignment_compatibility() {
        // Same types
        assert_eq!(
            check_assignment_compatibility(&Ty::Unsigned(32), &Ty::Unsigned(32)),
            Compatibility::Identical
        );
        // Widening
        assert_eq!(
            check_assignment_compatibility(&Ty::Unsigned(32), &Ty::Unsigned(16)),
            Compatibility::ImplicitWidening
        );
        // Narrowing
        assert_eq!(
            check_assignment_compatibility(&Ty::Unsigned(16), &Ty::Unsigned(32)),
            Compatibility::ExplicitCastRequired
        );
        // Signed to unsigned
        assert_eq!(
            check_assignment_compatibility(&Ty::Unsigned(32), &Ty::Signed(32)),
            Compatibility::ExplicitCastRequired
        );
    }

    #[test]
    fn test_can_represent() {
        assert!(can_represent(&Ty::Unsigned(8), 255));
        assert!(!can_represent(&Ty::Unsigned(8), 256));
        assert!(can_represent(&Ty::Signed(8), 127));
        assert!(can_represent(&Ty::Signed(8), -128));
        assert!(!can_represent(&Ty::Signed(8), 128));
    }
}
