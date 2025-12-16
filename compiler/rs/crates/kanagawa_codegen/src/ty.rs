//! Type emission to ParseTree.

use kanagawa_hir::{Ty, TyAttr, TyAttrFlag, TyAttrName, TyFuncParam, FunctionKind, TyArg};
use kanagawa_parsetree::build_list;
use kanagawa_parsetree_sys::{self as sys, ParseTreeNodePtr};

use crate::emit::{CodeGen, CodeGenError, CodeGenResult};

impl CodeGen {
    /// Emit a type as a ParseTree node.
    pub(crate) fn emit_type(&mut self, ty: &Ty) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_type: {:?}", ty);
        }
        match ty {
            // Primitive types
            Ty::Void => Ok(unsafe { sys::ParseVoidType() }),
            Ty::Bool => Ok(unsafe { sys::ParseBoolType() }),
            Ty::Float => Ok(unsafe { sys::ParseFloatType() }),
            Ty::String => Ok(unsafe { sys::ParseStringType() }),

            // Integer types
            Ty::Signed(width) => Ok(unsafe { sys::ParseIntType(*width as i32) }),
            Ty::Unsigned(width) => Ok(unsafe { sys::ParseUintType(*width as i32) }),

            // Const-qualified type
            Ty::Const(inner) => {
                let inner_ty = self.emit_type(inner)?;
                Ok(unsafe { sys::ParseConst(inner_ty) })
            }

            // Array type
            Ty::Array { attrs, element, dims } => {
                let elem_ty = self.emit_type(element)?;
                self.emit_array_type(elem_ty, dims, attrs)
            }

            // Function type
            // WORKAROUND: Function types crash in ParseFunctionType due to C++ RTTI issues.
            // Skip them for now - they're typically used in callbacks/closures.
            Ty::Function { .. } => {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("Warning: skipping function type due to RTTI workaround");
                }
                Err(CodeGenError::Unsupported(
                    "function types (RTTI workaround)".to_string()
                ))
            }

            // Named types (struct, enum, class, union)
            Ty::Struct { name, .. } => self.emit_named_type(name),
            Ty::Enum { name, .. } => self.emit_named_type(name),
            Ty::Class { name, .. } => self.emit_named_type(name),
            Ty::Union { name, .. } => self.emit_named_type(name),

            // Template instance
            Ty::Instance { name, args, .. } => {
                self.emit_template_instance(name, args)
            }

            // Reference type
            Ty::Reference(name) => {
                let named = self.emit_named_type(name)?;
                Ok(unsafe { sys::ParseReference(named) })
            }

            // Dependent type (template parameter)
            Ty::Dependent(inner) => self.emit_type(inner),

            // Type of type (metatype)
            Ty::Type(inner) => self.emit_type(inner),

            // Auto type - used in templates for type inference
            // These need type resolution before emission
            Ty::Auto => {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("Warning: unresolved 'auto' type reached codegen");
                }
                Err(CodeGenError::Unsupported(
                    "auto type requires type resolution before emission".to_string()
                ))
            }

            // Template type - represents a template parameter placeholder
            Ty::Template => {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("Warning: unresolved 'template' type reached codegen");
                }
                Err(CodeGenError::Unsupported(
                    "template type requires resolution before emission".to_string()
                ))
            }

            // These types require resolution before emission
            // They can appear in templates or forward declarations
            Ty::Undefined | Ty::Untyped | Ty::Unresolved => {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("Warning: unresolved type {:?} reached codegen", ty);
                }
                Err(CodeGenError::Unsupported(format!(
                    "{:?} type requires resolution before emission",
                    ty
                )))
            }

            Ty::Error(msg) => {
                Err(CodeGenError::Internal(format!("error type: {}", msg)))
            }

            // Closure type
            Ty::Closure { func_ty, .. } => {
                // Emit as the underlying function type
                self.emit_type(func_ty)
            }

            // Initializer types (shouldn't be emitted directly)
            Ty::Initializer(_) | Ty::Designator { .. } | Ty::Positional { .. } => {
                Err(CodeGenError::Unsupported(format!(
                    "initializer type in type position: {:?}",
                    ty
                )))
            }
        }
    }

    /// Emit an array type with dimensions.
    fn emit_array_type(
        &mut self,
        element: ParseTreeNodePtr,
        dims: &[i64],
        attrs: &[TyAttr],
    ) -> CodeGenResult<ParseTreeNodePtr> {
        // Build dimension list
        let mut dim_nodes = Vec::new();
        for dim in dims {
            let dim_str = dim.to_string();
            let dim_ptr = self.intern(&dim_str);
            let dim_node = unsafe { sys::ParseDecimalLiteral(dim_ptr) };
            dim_nodes.push(dim_node);
        }
        let dims_list = build_list(&dim_nodes);

        // Emit memory type attributes if present
        let mem_type = self.emit_memory_attrs(attrs);

        Ok(unsafe { sys::ParseArrayType(element, dims_list, mem_type) })
    }

    /// Emit memory type attributes.
    fn emit_memory_attrs(&self, attrs: &[TyAttr]) -> ParseTreeNodePtr {
        // Check for specific memory attributes
        for attr in attrs {
            match attr {
                TyAttr::Flag(TyAttrFlag::NonReplicated) => {
                    return unsafe {
                        sys::ParseFlagAttribute(sys::_ParseTreeMemoryType_ParseTreeMemoryTypeNoReplication as u32)
                    };
                }
                TyAttr::Flag(TyAttrFlag::QuadPort) => {
                    return unsafe {
                        sys::ParseFlagAttribute(sys::_ParseTreeMemoryType_ParseTreeMemoryTypeQuadPort as u32)
                    };
                }
                TyAttr::Flag(TyAttrFlag::Initialize) => {
                    return unsafe {
                        sys::ParseFlagAttribute(sys::_ParseTreeMemoryType_ParseTreeMemoryTypeInitialize as u32)
                    };
                }
                _ => {}
            }
        }

        std::ptr::null_mut()
    }

    /// Emit a function type.
    fn emit_function_type(
        &mut self,
        _kind: FunctionKind,
        attrs: &[TyAttr],
        return_ty: &Ty,
        params: &[TyFuncParam],
    ) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function_type: {} params, return_ty={:?}", params.len(), return_ty);
        }
        // Emit return type
        let ret_ty = self.emit_type(return_ty)?;
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function_type: ret_ty={:?}", ret_ty);
        }

        // Emit parameters
        let mut param_nodes = Vec::new();
        for (i, param) in params.iter().enumerate() {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_function_type: param {} ty={:?}", i, param.ty);
            }
            let param_ty = self.emit_type(&param.ty)?;
            let param_attrs = self.emit_attrs(&param.attrs)?;
            let param_name = if let Some(name) = &param.name {
                self.identifier(name)
            } else {
                std::ptr::null_mut()
            };
            let param_node = unsafe { sys::ParseFunctionTypeParam(param_ty, param_attrs, param_name) };
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_function_type: param {} node={:?}", i, param_node);
            }
            param_nodes.push(param_node);
        }
        let params_list = build_list(&param_nodes);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function_type: params_list={:?}", params_list);
        }

        // Emit function modifiers from attributes
        let modifiers = self.emit_function_attrs(attrs);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function_type: modifiers={:?}", modifiers);
            eprintln!("emit_function_type: calling ParseFunctionType(modifiers={:?}, ret={:?}, params={:?})",
                      modifiers, ret_ty, params_list);
        }

        let result = unsafe { sys::ParseFunctionType(modifiers, ret_ty, params_list) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function_type: ParseFunctionType returned {:?}", result);
        }
        Ok(result)
    }

    /// Emit a named type reference.
    fn emit_named_type(&mut self, name: &[String]) -> CodeGenResult<ParseTreeNodePtr> {
        if name.is_empty() {
            return Err(CodeGenError::Internal("empty type name".to_string()));
        }

        // Build qualified name
        if name.len() == 1 {
            Ok(self.identifier(&name[0]))
        } else {
            // Build scoped identifier
            let full_name = name.join("::");
            let ptr = self.intern(&full_name);
            Ok(unsafe { sys::ParseIdentifier(ptr) })
        }
    }

    /// Emit a template instance.
    fn emit_template_instance(
        &mut self,
        name: &[String],
        args: &[(String, TyArg)],
    ) -> CodeGenResult<ParseTreeNodePtr> {

        let template_name = self.emit_named_type(name)?;

        // Build template arguments
        let mut arg_nodes = Vec::new();
        for (arg_name, arg_val) in args {
            let arg_name_ptr = self.intern(arg_name);
            let arg_node = match arg_val {
                TyArg::Type(ty) => self.emit_type(ty)?,
                TyArg::Int(val) => {
                    let val_str = val.to_string();
                    let ptr = self.intern(&val_str);
                    unsafe { sys::ParseDecimalLiteral(ptr) }
                }
                TyArg::Str(s) => {
                    let ptr = self.intern(s);
                    unsafe { sys::ParseStringLiteral(ptr) }
                }
                TyArg::Named { ty, .. } => self.emit_type(ty)?,
            };
            let template_arg = unsafe { sys::ParseTemplateArg(arg_name_ptr, arg_node) };
            arg_nodes.push(template_arg);
        }
        let args_list = build_list(&arg_nodes);

        Ok(unsafe { sys::ParseTemplateInstance(template_name, args_list) })
    }

    /// Emit type attributes as a list.
    pub(crate) fn emit_attrs(&mut self, attrs: &[TyAttr]) -> CodeGenResult<ParseTreeNodePtr> {
        if attrs.is_empty() {
            return Ok(std::ptr::null_mut());
        }

        let mut attr_nodes = Vec::new();
        for attr in attrs {
            if let Some(node) = self.emit_attr(attr)? {
                attr_nodes.push(node);
            }
        }

        if attr_nodes.is_empty() {
            Ok(std::ptr::null_mut())
        } else {
            Ok(build_list(&attr_nodes))
        }
    }

    /// Emit a single attribute.
    fn emit_attr(&mut self, attr: &TyAttr) -> CodeGenResult<Option<ParseTreeNodePtr>> {
        match attr {
            TyAttr::Flag(flag) => {
                #[allow(unused_variables)]
                let _attr_kind = match flag {
                    TyAttrFlag::Async => return Ok(None), // Handled via function modifier
                    TyAttrFlag::Atomic => return Ok(None),
                    TyAttrFlag::EndTransaction => return Ok(None),
                    TyAttrFlag::Initialize => return Ok(None),
                    TyAttrFlag::Memory => return Ok(None),
                    TyAttrFlag::NoBackPressure => return Ok(None),
                    TyAttrFlag::Pure => return Ok(None),
                    TyAttrFlag::NonReplicated => return Ok(None),
                    TyAttrFlag::Pipelined => return Ok(None),
                    TyAttrFlag::QuadPort => return Ok(None),
                    TyAttrFlag::ReorderByLooping => return Ok(None),
                    TyAttrFlag::Reset => return Ok(None),
                    TyAttrFlag::Unordered => return Ok(None),
                };
                #[allow(unreachable_code)]
                Ok(Some(unsafe { sys::ParseFlagAttribute(_attr_kind) }))
            }
            TyAttr::Int { name, value } => {
                let attr_kind = match name {
                    TyAttrName::CallRate => sys::_ParseTreeAttribute_ParseTreeCallRateAttr,
                    TyAttrName::FifoDepth => sys::_ParseTreeAttribute_ParseTreeFifoDepthAttr,
                    TyAttrName::Latency => sys::_ParseTreeAttribute_ParseTreeLatencyAttr,
                    TyAttrName::MaxThreads => sys::_ParseTreeAttribute_ParseTreeMaxThreadsAttr,
                    TyAttrName::ThreadRate => sys::_ParseTreeAttribute_ParseTreeThreadRateAttr,
                    TyAttrName::TransactionSize => sys::_ParseTreeAttribute_ParseTreeTransactionSizeAttr,
                    TyAttrName::Ecc | TyAttrName::Rename | TyAttrName::Schedule => {
                        return Ok(None); // Not integer attributes
                    }
                };
                let val_str = value.to_string();
                let val_ptr = self.intern(&val_str);
                let val_node = unsafe { sys::ParseDecimalLiteral(val_ptr) };
                Ok(Some(unsafe { sys::ParseIntAttribute(attr_kind as u32, val_node) }))
            }
            TyAttr::Named { name, .. } => {
                let attr_kind = match name {
                    TyAttrName::Schedule => sys::_ParseTreeAttribute_ParseTreeScheduleAttr,
                    TyAttrName::Rename => sys::_ParseTreeAttribute_ParseTreeNameAttr,
                    _ => return Ok(None),
                };
                // Named attributes need the value - simplified for now
                Ok(Some(unsafe { sys::ParseFlagAttribute(attr_kind as u32) }))
            }
        }
    }

    /// Emit function attributes as modifier flags.
    pub(crate) fn emit_function_attrs(&self, attrs: &[TyAttr]) -> ParseTreeNodePtr {
        let mut modifiers: u32 = 0;

        for attr in attrs {
            if let TyAttr::Flag(flag) = attr {
                modifiers |= match flag {
                    TyAttrFlag::Async => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierAsync as u32,
                    TyAttrFlag::Pipelined => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierPipelined as u32,
                    TyAttrFlag::Unordered => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierUnordered as u32,
                    TyAttrFlag::NoBackPressure => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierNoBackPressure as u32,
                    TyAttrFlag::ReorderByLooping => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierReorderByLooping as u32,
                    TyAttrFlag::Reset => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierReset as u32,
                    TyAttrFlag::Pure => sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierPure as u32,
                    _ => 0,
                };
            }
        }

        if modifiers == 0 {
            std::ptr::null_mut()
        } else {
            unsafe { sys::ParseFunctionModifier(modifiers as sys::_ParseTreeFunctionModifier) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests require the C++ backend to be initialized (InitCompiler called).
    // They are ignored by default because unit tests cannot easily initialize the backend.

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_void_type() {
        let mut cg = CodeGen::new();
        let result = cg.emit_type(&Ty::Void);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_int_types() {
        let mut cg = CodeGen::new();

        let signed = cg.emit_type(&Ty::Signed(32));
        assert!(signed.is_ok());

        let unsigned = cg.emit_type(&Ty::Unsigned(8));
        assert!(unsigned.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_bool_type() {
        let mut cg = CodeGen::new();
        let result = cg.emit_type(&Ty::Bool);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_const_type() {
        let mut cg = CodeGen::new();
        let result = cg.emit_type(&Ty::Const(Box::new(Ty::Signed(32))));
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_array_type() {
        let mut cg = CodeGen::new();
        let result = cg.emit_type(&Ty::Array {
            attrs: vec![],
            element: Box::new(Ty::Unsigned(8)),
            dims: vec![10],
        });
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_unresolved_type_errors() {
        let mut cg = CodeGen::new();
        assert!(cg.emit_type(&Ty::Unresolved).is_err());
        // Auto and Template types also error (unsupported) since they need resolution
        assert!(cg.emit_type(&Ty::Auto).is_err());
        assert!(cg.emit_type(&Ty::Template).is_err());
    }
}
