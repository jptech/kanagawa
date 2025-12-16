//! Expression emission to ParseTree.

use kanagawa_hir::{
    HirBinaryOp, HirExpr, HirExprKind, HirFormatKind, HirSizeofKind, HirStringPart, HirUnaryOp,
};
use kanagawa_parsetree::build_list;
use kanagawa_parsetree_sys::{self as sys, ParseTreeNodePtr};

use crate::emit::{CodeGen, CodeGenError, CodeGenResult};

impl CodeGen {
    /// Emit an expression as a ParseTree node.
    pub(crate) fn emit_expr(&mut self, expr: &HirExpr) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_expr: {:?}", std::mem::discriminant(&expr.kind));
        }
        self.set_location(&expr.span);

        match &expr.kind {
            // Literals
            HirExprKind::IntLiteral { value, suffix } => {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_expr: IntLiteral value={}, suffix={:?}", value, suffix);
                }
                self.emit_int_literal(*value, suffix.as_ref())
            }
            HirExprKind::FloatLiteral(val) => Ok(unsafe { sys::ParseFloatLiteral(*val as f32) }),
            HirExprKind::BoolLiteral(val) => Ok(unsafe { sys::ParseBoolLiteral(if *val { 1 } else { 0 }) }),
            HirExprKind::StringLiteral(s) => {
                let ptr = self.intern(s);
                Ok(unsafe { sys::ParseStringLiteral(ptr) })
            }
            HirExprKind::InterpolatedString(parts) => self.emit_interpolated_string(parts),

            // Names - must use ParseScopedIdentifier for ParseNamedVariable
            HirExprKind::Ident { name, .. } => {
                let scoped = self.scoped_identifier(name);
                Ok(unsafe { sys::ParseNamedVariable(scoped) })
            }
            HirExprKind::QualifiedIdent { path, .. } => {
                // For qualified names, build a scoped identifier from the path
                let scoped = self.qualified_scoped_identifier(path);
                Ok(unsafe { sys::ParseNamedVariable(scoped) })
            }
            HirExprKind::This { .. } => {
                let scope = self.namespace_scope();
                Ok(unsafe { sys::ParseThis(scope) })
            }

            // Binary operations
            HirExprKind::Binary { op, lhs, rhs } => {
                let lhs_node = self.emit_expr(lhs)?;
                let rhs_node = self.emit_expr(rhs)?;
                let op_type = self.binary_op_type(*op);
                Ok(unsafe { sys::ParseBinaryOp(op_type, lhs_node, rhs_node) })
            }

            // Unary operations
            HirExprKind::Unary { op, operand } => {
                let operand_node = self.emit_expr(operand)?;
                match op {
                    HirUnaryOp::Neg => Ok(unsafe {
                        sys::ParseUnaryOp(sys::_ParseTreeUnaryOpType_ParseTreeUnaryOpTypeNegate, operand_node)
                    }),
                    HirUnaryOp::Not => Ok(unsafe {
                        sys::ParseUnaryOp(sys::_ParseTreeUnaryOpType_ParseTreeUnaryOpTypeLogicalInvert, operand_node)
                    }),
                    HirUnaryOp::Invert => Ok(unsafe {
                        sys::ParseUnaryOp(sys::_ParseTreeUnaryOpType_ParseTreeUnaryOpTypeInvert, operand_node)
                    }),
                    HirUnaryOp::PostInc | HirUnaryOp::PostDec | HirUnaryOp::PreInc | HirUnaryOp::PreDec => {
                        // Increment/decrement are typically handled at statement level
                        // For expression context, treat as the operand (simplified)
                        Ok(operand_node)
                    }
                }
            }

            // Ternary conditional
            HirExprKind::Ternary { condition, then_expr, else_expr } => {
                // Emit as mux(condition, else, then) - note order reversal for Kanagawa mux
                let cond = self.emit_expr(condition)?;
                let then_val = self.emit_expr(then_expr)?;
                let else_val = self.emit_expr(else_expr)?;
                // Mux takes (selector, args_list) where args are [else, then]
                let args = build_list(&[else_val, then_val]);
                Ok(unsafe { sys::ParseMux(cond, args) })
            }

            // Function call
            // NOTE: ParseFunctionCall expects a FunctionSpecifierNode, not a raw identifier.
            // We must create the specifier based on the callee expression type:
            // - Ident/QualifiedIdent: free function call → ParseFunctionSpecifier(null, name)
            // - Member: method call → ParseFunctionSpecifier(object, member)
            HirExprKind::Call { callee, args, attrs } => {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_expr::Call: callee kind = {:?}", std::mem::discriminant(&callee.kind));
                }

                // Build the function specifier based on callee type
                // NOTE: ParseFunctionSpecifier expects a ScopedIdentifierNode for the name
                let specifier = match &callee.kind {
                    // Free function call: specifier = (null, scoped_name)
                    HirExprKind::Ident { name, .. } => {
                        // Must use scoped identifier, not plain identifier
                        let name_node = self.scoped_identifier(name);
                        if std::env::var("KANAGAWA_DEBUG").is_ok() {
                            eprintln!("emit_expr::Call: free function '{}', scoped_name={:?}", name, name_node);
                        }
                        let spec = unsafe { sys::ParseFunctionSpecifier(std::ptr::null_mut(), name_node) };
                        if std::env::var("KANAGAWA_DEBUG").is_ok() {
                            eprintln!("emit_expr::Call: ParseFunctionSpecifier = {:?}", spec);
                        }
                        spec
                    }
                    HirExprKind::QualifiedIdent { path, .. } => {
                        // Use qualified scoped identifier for namespaced functions
                        let name_node = self.qualified_scoped_identifier(path);
                        if std::env::var("KANAGAWA_DEBUG").is_ok() {
                            eprintln!("emit_expr::Call: qualified function '{}'", path.join("::"));
                        }
                        unsafe { sys::ParseFunctionSpecifier(std::ptr::null_mut(), name_node) }
                    }
                    // Method call: specifier = (object, scoped_member)
                    HirExprKind::Member { object, member, .. } => {
                        let obj_node = self.emit_expr(object)?;
                        // Member name also needs to be scoped identifier
                        let member_node = self.scoped_identifier(member);
                        if std::env::var("KANAGAWA_DEBUG").is_ok() {
                            eprintln!("emit_expr::Call: method call '{}'", member);
                        }
                        unsafe { sys::ParseFunctionSpecifier(obj_node, member_node) }
                    }
                    // For other expressions (e.g., function pointers), emit as-is
                    // This may need refinement for complex callable expressions
                    _ => {
                        if std::env::var("KANAGAWA_DEBUG").is_ok() {
                            eprintln!("emit_expr::Call: complex callee expression");
                        }
                        let callee_node = self.emit_expr(callee)?;
                        unsafe { sys::ParseFunctionSpecifier(std::ptr::null_mut(), callee_node) }
                    }
                };

                // Emit arguments
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_expr::Call: emitting {} args", args.len());
                }
                let mut arg_nodes = Vec::new();
                for arg in args {
                    arg_nodes.push(self.emit_expr(arg)?);
                }
                let args_list = build_list(&arg_nodes);

                // Emit call attributes/modifiers
                // NOTE: modifiers must always be a valid NodeList (never null)
                // because CallNode::TypeCheck dereferences it without null check
                let attrs_node = self.emit_attrs(attrs)?;
                let modifiers = if attrs_node.is_null() {
                    build_list(&[])
                } else {
                    attrs_node
                };

                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_expr::Call: calling ParseFunctionCall, modifiers={:?}", modifiers);
                }
                let result = unsafe { sys::ParseFunctionCall(specifier, args_list, modifiers) };
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_expr::Call: ParseFunctionCall returned");
                }
                Ok(result)
            }

            // Member access
            HirExprKind::Member { object, member, .. } => {
                let obj = self.emit_expr(object)?;
                let member_id = self.identifier(member);
                Ok(unsafe { sys::ParseAccessMember(obj, member_id) })
            }

            // Array subscript
            HirExprKind::Subscript { array, index } => {
                let arr = self.emit_expr(array)?;
                let idx = self.emit_expr(index)?;
                Ok(unsafe { sys::ParseAccessArray(arr, idx) })
            }

            // Type cast
            HirExprKind::Cast { ty, expr } => {
                let ty_node = self.emit_type(ty)?;
                let expr_node = self.emit_expr(expr)?;
                Ok(unsafe { sys::ParseCast(ty_node, expr_node) })
            }

            // Built-in expressions
            HirExprKind::Mux { selector, args } => {
                let sel = self.emit_expr(selector)?;
                let mut arg_nodes = Vec::new();
                for arg in args {
                    arg_nodes.push(self.emit_expr(arg)?);
                }
                let args_list = build_list(&arg_nodes);
                Ok(unsafe { sys::ParseMux(sel, args_list) })
            }

            HirExprKind::Concat(exprs) => {
                let mut nodes = Vec::new();
                for e in exprs {
                    nodes.push(self.emit_expr(e)?);
                }
                let list = build_list(&nodes);
                Ok(unsafe { sys::ParseConcat(list) })
            }

            HirExprKind::FanOut { count, value } => {
                let count_node = self.emit_expr(count)?;
                let value_node = self.emit_expr(value)?;
                Ok(unsafe { sys::ParseFanOut(count_node, value_node) })
            }

            HirExprKind::Static(inner) => {
                let inner_node = self.emit_expr(inner)?;
                Ok(unsafe { sys::ParseStatic(inner_node) })
            }

            // Initializers
            HirExprKind::InitializerList(exprs) => {
                let mut nodes = Vec::new();
                for e in exprs {
                    nodes.push(self.emit_expr(e)?);
                }
                let list = build_list(&nodes);
                Ok(unsafe { sys::ParseInitializerList(list) })
            }

            HirExprKind::DesignatedInitializer(fields) => {
                let mut nodes = Vec::new();
                for (name, expr) in fields {
                    let name_id = self.identifier(name);
                    let val = self.emit_expr(expr)?;
                    let designator = unsafe { sys::ParseDesignator(name_id, val) };
                    nodes.push(designator);
                }
                let list = build_list(&nodes);
                Ok(unsafe { sys::ParseInitializerList(list) })
            }

            // Parenthesized expression (just emit inner)
            HirExprKind::Paren(inner) => self.emit_expr(inner),

            // Type expression (for sizeof, etc.)
            HirExprKind::TypeExpr(ty) => self.emit_type(ty),

            // Lambda
            HirExprKind::Lambda(_lambda) => {
                // Lambdas are complex - emit as a nested function for now
                Err(CodeGenError::Unsupported("lambda expression".to_string()))
            }

            // Sizeof
            HirExprKind::Sizeof { kind, operand } => {
                let operand_node = self.emit_expr(operand)?;
                let sizeof_type = match kind {
                    HirSizeofKind::Bits => sys::_ParseTreeSizeofType_ParseTreeSizeofTypeBit,
                    HirSizeofKind::Bytes => sys::_ParseTreeSizeofType_ParseTreeSizeofTypeByte,
                    HirSizeofKind::Clog2 => {
                        // clog2 is typically a unary operation, not sizeof
                        return Err(CodeGenError::Unsupported("clog2 in sizeof context".to_string()));
                    }
                };
                Ok(unsafe { sys::ParseSizeOf(sizeof_type, operand_node) })
            }

            // Offsetof (not directly supported by ParseTree API)
            HirExprKind::Offsetof { .. } => {
                Err(CodeGenError::Unsupported("offsetof expression".to_string()))
            }

            // Unit expression
            HirExprKind::Unit => {
                // Emit as void/null
                Ok(std::ptr::null_mut())
            }

            // Enum value
            HirExprKind::EnumValue { enum_ty, variant, value } => {
                // Emit as qualified name access
                if let Some(name) = enum_ty.qualified_name() {
                    let full_name = format!("{}::{}", name.join("::"), variant);
                    let id = self.identifier(&full_name);
                    Ok(unsafe { sys::ParseNamedVariable(id) })
                } else {
                    self.emit_expr(value)
                }
            }

            // Named value
            HirExprKind::NamedValue(inner) => self.emit_expr(inner),

            // Error
            HirExprKind::Error(msg) => {
                Err(CodeGenError::Internal(format!("error expression: {}", msg)))
            }
        }
    }

    /// Emit an integer literal.
    fn emit_int_literal(
        &mut self,
        value: i128,
        suffix: Option<&kanagawa_hir::HirIntSuffix>,
    ) -> CodeGenResult<ParseTreeNodePtr> {
        // Format the literal as a string
        let literal_str = if let Some(suffix) = suffix {
            if suffix.signed {
                format!("{}i{}", value, suffix.width)
            } else {
                format!("{}u{}", value, suffix.width)
            }
        } else {
            value.to_string()
        };

        let ptr = self.intern(&literal_str);
        Ok(unsafe { sys::ParseDecimalLiteral(ptr) })
    }

    /// Emit an interpolated string.
    fn emit_interpolated_string(&mut self, parts: &[HirStringPart]) -> CodeGenResult<ParseTreeNodePtr> {
        let mut segment_nodes = Vec::new();

        for part in parts {
            match part {
                HirStringPart::Text(text) => {
                    let ptr = self.intern(text);
                    let text_node = unsafe { sys::ParseStringLiteral(ptr) };
                    segment_nodes.push(text_node);
                }
                HirStringPart::Interpolation { expr, show_name, format } => {
                    let expr_node = self.emit_expr(expr)?;
                    let show_name_node = if *show_name {
                        unsafe { sys::ParseBoolLiteral(1) }
                    } else {
                        std::ptr::null_mut()
                    };
                    let format_spec = format.as_ref().map(|f| match f.kind {
                        HirFormatKind::Binary => sys::_ParseTreeFormatSpecifier_ParseTreeFormatSpecifierBin,
                        HirFormatKind::Octal => sys::_ParseTreeFormatSpecifier_ParseTreeFormatSpecifierOct,
                        HirFormatKind::Decimal => sys::_ParseTreeFormatSpecifier_ParseTreeFormatSpecifierDec,
                        HirFormatKind::Hex => sys::_ParseTreeFormatSpecifier_ParseTreeFormatSpecifierHex,
                        HirFormatKind::HexUpper => sys::_ParseTreeFormatSpecifier_ParseTreeFormatSpecifierHexUpper,
                    }).unwrap_or(sys::_ParseTreeFormatSpecifier_ParseTreeFormatSpecifierNone);
                    let precision = format.as_ref().and_then(|f| f.precision).unwrap_or(0);

                    let interp_node = unsafe {
                        sys::ParseInterpolationExpression(expr_node, show_name_node, format_spec, precision)
                    };
                    segment_nodes.push(interp_node);
                }
            }
        }

        // Build segments into interpolated string
        let mut result = std::ptr::null_mut();
        for (i, segment) in segment_nodes.iter().enumerate() {
            if i == 0 {
                result = *segment;
            } else {
                result = unsafe { sys::ParseInterpolatedStringSegment(result, *segment) };
            }
        }

        Ok(unsafe { sys::ParseInterpolatedString(result) })
    }

    /// Convert HIR binary operator to ParseTree binary op type.
    fn binary_op_type(&self, op: HirBinaryOp) -> sys::_ParseTreeBinaryOpType {
        match op {
            HirBinaryOp::Add => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeAdd,
            HirBinaryOp::Sub => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeSub,
            HirBinaryOp::Mul => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeMul,
            HirBinaryOp::Div => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeDiv,
            HirBinaryOp::Mod => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeMod,
            HirBinaryOp::BitwiseAnd => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeAnd,
            HirBinaryOp::BitwiseOr => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeOr,
            HirBinaryOp::BitwiseXor => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeXor,
            HirBinaryOp::LogicalAnd => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeLogicalAnd,
            HirBinaryOp::LogicalOr => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeLogicalOr,
            HirBinaryOp::LogicalXor => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeLogicalXor,
            HirBinaryOp::Shl => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeShl,
            HirBinaryOp::Shr => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeShr,
            HirBinaryOp::Eq => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeEQ,
            HirBinaryOp::Ne => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeNE,
            HirBinaryOp::Lt => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeLT,
            HirBinaryOp::Le => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeLE,
            HirBinaryOp::Gt => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeGT,
            HirBinaryOp::Ge => sys::_ParseTreeBinaryOpType_ParseTreeBinaryOpTypeGE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{Span, Ty};

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
    fn test_emit_int_literal() {
        let mut cg = CodeGen::new();
        let expr = make_int_expr(42);
        let result = cg.emit_expr(&expr);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_bool_literal() {
        let mut cg = CodeGen::new();
        let expr = HirExpr::new(
            Span::default(),
            Ty::Bool,
            HirExprKind::BoolLiteral(true),
        );
        let result = cg.emit_expr(&expr);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_binary_op() {
        let mut cg = CodeGen::new();
        let lhs = make_int_expr(1);
        let rhs = make_int_expr(2);
        let expr = HirExpr::new(
            Span::default(),
            Ty::Signed(32),
            HirExprKind::Binary {
                op: HirBinaryOp::Add,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            },
        );
        let result = cg.emit_expr(&expr);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_identifier() {
        let mut cg = CodeGen::new();
        let expr = HirExpr::new(
            Span::default(),
            Ty::Signed(32),
            HirExprKind::Ident {
                name: "foo".to_string(),
                def_id: kanagawa_hir::DefId(0),
            },
        );
        let result = cg.emit_expr(&expr);
        assert!(result.is_ok());
    }

    #[test]
    fn test_emit_string_literal() {
        let mut cg = CodeGen::new();
        let expr = HirExpr::new(
            Span::default(),
            Ty::String,
            HirExprKind::StringLiteral("hello".to_string()),
        );
        let result = cg.emit_expr(&expr);
        assert!(result.is_ok());
    }
}
