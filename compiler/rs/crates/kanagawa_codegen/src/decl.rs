//! Declaration emission to ParseTree.

use kanagawa_hir::{
    HirClass, HirClassMember, HirAccessSpecifier, HirDeclBlock, HirEnum, HirExtern, HirExport2,
    HirFunction, HirFunctionModifier, HirItem, HirParam, HirStaticAssert, HirStaticIf, HirStruct,
    HirStructMember, HirTemplate, HirTemplateParam, HirUnion, HirUsing, HirVariable, HirDeclFlags,
};
use kanagawa_parsetree::build_list;
use kanagawa_parsetree_sys::{self as sys, ParseTreeNodePtr};

use crate::emit::{CodeGen, CodeGenError, CodeGenResult};

/// Emit a top-level item.
pub(crate) fn emit_item(cg: &mut CodeGen, item: &HirItem) -> CodeGenResult<Option<ParseTreeNodePtr>> {
    if std::env::var("KANAGAWA_DEBUG").is_ok() {
        eprintln!("emit_item: {:?}", std::mem::discriminant(item));
    }
    match item {
        HirItem::Function(func) => Ok(Some(cg.emit_function(func)?)),
        HirItem::Variable(var) => Ok(Some(emit_variable(cg, var)?)),
        HirItem::Struct(s) => Ok(Some(cg.emit_struct(s)?)),
        HirItem::Enum(e) => Ok(Some(cg.emit_enum(e)?)),
        HirItem::Class(c) => Ok(Some(cg.emit_class(c)?)),
        HirItem::Union(u) => Ok(Some(cg.emit_union(u)?)),
        HirItem::Using(u) => Ok(Some(cg.emit_using(u)?)),
        HirItem::Template(t) => Ok(Some(cg.emit_template(t)?)),
        HirItem::StaticIf(si) => cg.emit_static_if(si),
        HirItem::StaticAssert(sa) => Ok(Some(cg.emit_static_assert(sa)?)),
        HirItem::Extern(ext) => Ok(Some(cg.emit_extern(ext)?)),
        HirItem::Export(exp) => Ok(Some(cg.emit_export(exp)?)),
        HirItem::DeclBlock(block) => cg.emit_decl_block(block),
    }
}

/// Emit a variable declaration.
pub(crate) fn emit_variable(cg: &mut CodeGen, var: &HirVariable) -> CodeGenResult<ParseTreeNodePtr> {
    cg.set_location(&var.span);

    let ty = cg.emit_type(&var.ty)?;
    let name = cg.identifier(&var.name);

    let init = if let Some(init_expr) = &var.init {
        cg.emit_expr(init_expr)?
    } else {
        std::ptr::null_mut()
    };

    // Build declaration flags
    let flags = emit_decl_flags(&var.flags);

    let namespace = cg.namespace_scope();

    // ParseDeclare signature: (attributeList, type, name, val, flags, namespaceScope)
    Ok(unsafe { sys::ParseDeclare(std::ptr::null_mut(), ty, name, init, flags, namespace) })
}

/// Convert declaration flags to backend flags.
fn emit_decl_flags(flags: &HirDeclFlags) -> u32 {
    let mut result = 0u32;

    if flags.is_const {
        result |= sys::DECLARE_FLAG_CONST;
    }
    if flags.is_global {
        result |= sys::DECLARE_FLAG_GLOBAL;
    }
    if flags.is_static {
        result |= sys::DECLARE_FLAG_STATIC;
    }

    result
}

impl CodeGen {
    /// Emit a function definition.
    pub(crate) fn emit_function(&mut self, func: &HirFunction) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function: {}", func.name);
        }
        self.set_location(&func.span);

        // Emit return type
        let return_ty = self.emit_type(&func.return_ty)?;
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function: return type emitted");
        }

        // Emit function name
        let name = self.identifier(&func.name);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function: name identifier created");
        }

        // Emit parameters
        let mut param_nodes = Vec::new();
        for param in &func.params {
            let param_node = self.emit_param(param)?;
            param_nodes.push(param_node);
        }
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function: {} params emitted", param_nodes.len());
        }
        let params_list = build_list(&param_nodes);

        // Emit body if present
        // NOTE: We emit the statement list directly, NOT wrapped in ParseNestedScope.
        // ParseFunction wraps the FunctionNode in ParseNestedScope internally.
        let body = if let Some(body_block) = &func.body {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_function: emitting body ({} stmts)", body_block.stmts.len());
            }
            self.set_location(&body_block.span);
            let mut stmt_nodes = Vec::new();
            for (i, stmt) in body_block.stmts.iter().enumerate() {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_function: emitting stmt {}: {:?}", i, std::mem::discriminant(stmt));
                }
                let node = self.emit_stmt(stmt)?;
                if !node.is_null() {
                    stmt_nodes.push(node);
                }
            }
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_function: body stmts emitted");
            }
            build_list(&stmt_nodes)
        } else {
            std::ptr::null_mut()
        };

        // Emit function modifier
        let modifier = self.emit_function_modifier(func.modifier, &func.attrs);

        // Emit attributes as modifierList
        // NOTE: modifierList must always be a valid NodeList (never null)
        // The C++ backend's GetFunctionFixedLatency crashes on null.
        let attrs = self.emit_attrs(&func.attrs)?;
        // Ensure we always have a valid list (empty list if no attrs)
        let modifier_list = if attrs.is_null() {
            build_list(&[])
        } else {
            attrs
        };

        // Get namespace scope
        let scope_str = func.name.clone();
        let scope_ptr = self.intern(&scope_str);

        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function: calling ParseFunction");
        }
        // Argument order: modifierList, modifier, returnType, name, params, statements, unmangledName
        let result = unsafe {
            sys::ParseFunction(modifier_list, modifier, return_ty, name, params_list, body, scope_ptr)
        };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_function: ParseFunction returned");
        }
        Ok(result)
    }

    /// Emit a function parameter.
    ///
    /// NOTE: ParseFunctionParam takes (attributes, type, name, namespace).
    /// Default parameter values are not directly supported by ParseFunctionParam;
    /// they need to be handled at a higher level (e.g., by the type system).
    fn emit_param(&mut self, param: &HirParam) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&param.span);

        // Emit parameter type
        let ty = self.emit_type(&param.ty)?;

        // Emit parameter name
        let name = self.identifier(&param.name);

        // Parameter attributes (empty list for now)
        // The C++ backend expects a NodeList, not null
        let attrs = build_list(&[]);

        let namespace = self.namespace_scope();

        // ParseFunctionParam signature: (attributes, type, name, namespace)
        Ok(unsafe { sys::ParseFunctionParam(attrs, ty, name, namespace) })
    }

    /// Emit function modifier flags.
    fn emit_function_modifier(
        &self,
        modifier: Option<HirFunctionModifier>,
        attrs: &[kanagawa_hir::TyAttr],
    ) -> ParseTreeNodePtr {
        use kanagawa_hir::TyAttrFlag;

        let mut flags: u32 = 0;

        // Handle explicit modifier
        match modifier {
            Some(HirFunctionModifier::Inline) => {
                flags |= sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierInline as u32;
            }
            Some(HirFunctionModifier::NoInline) => {
                flags |= sys::_ParseTreeFunctionModifier_ParseTreeFunctionModifierNoInline as u32;
            }
            None => {}
        }

        // Handle attribute-based modifiers
        for attr in attrs {
            if let kanagawa_hir::TyAttr::Flag(flag) = attr {
                flags |= match flag {
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

        if flags == 0 {
            std::ptr::null_mut()
        } else {
            unsafe { sys::ParseFunctionModifier(flags as sys::ParseTreeFunctionModifier) }
        }
    }

    /// Emit a struct definition.
    pub(crate) fn emit_struct(&mut self, s: &HirStruct) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: {}", s.name);
        }
        self.set_location(&s.span);

        let name = self.identifier(&s.name);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: name identifier = {:?}", name);
        }

        // Emit members
        let mut member_nodes = Vec::new();
        for (i, member) in s.members.iter().enumerate() {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_struct: emitting member {}: {}", i, member.name);
            }
            let member_node = self.emit_struct_member(member)?;
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_struct: member {} node = {:?}", i, member_node);
            }
            member_nodes.push(member_node);
        }
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: building members_list from {} nodes", member_nodes.len());
        }
        let members_list = build_list(&member_nodes);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: members_list = {:?}", members_list);
        }

        let namespace = self.namespace_scope();
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: namespace = {:?}", namespace);
        }
        let scope_str = s.name.clone();
        let scope_ptr = self.intern(&scope_str);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: calling ParseStruct(name={:?}, members={:?}, ns={:?}, scope={:?})",
                      name, members_list, namespace, scope_ptr);
        }

        let result = unsafe { sys::ParseStruct(name, members_list, namespace, scope_ptr) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct: ParseStruct returned {:?}", result);
        }
        Ok(result)
    }

    /// Emit a struct member.
    fn emit_struct_member(&mut self, member: &HirStructMember) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_struct_member: {} : {:?}", member.name, member.ty);
        }
        self.set_location(&member.span);

        let ty = self.emit_type(&member.ty)?;
        let name = self.identifier(&member.name);

        let init = if let Some(init_expr) = &member.init {
            self.emit_expr(init_expr)?
        } else {
            std::ptr::null_mut()
        };

        let namespace = self.namespace_scope();

        // ParseDeclare signature: (attributeList, type, name, val, flags, namespaceScope)
        // Struct members don't have attributes or special flags typically
        Ok(unsafe { sys::ParseDeclare(std::ptr::null_mut(), ty, name, init, 0, namespace) })
    }

    /// Emit an enum definition.
    pub(crate) fn emit_enum(&mut self, e: &HirEnum) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_enum: {}", e.name);
        }
        self.set_location(&e.span);

        let name = self.identifier(&e.name);
        let base_ty = self.emit_type(&e.base_ty)?;
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_enum: base_ty emitted");
        }

        // Build list directly (don't store in Vec first - to rule out Rust memory issues)
        let mut variants_list = unsafe { sys::ParseBaseList(std::ptr::null_mut()) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_enum: initial variants_list = {:?}", variants_list);
        }

        for (i, variant) in e.variants.iter().enumerate() {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_enum: variant {}: {}", i, variant.name);
            }
            self.set_location(&variant.span);

            let variant_name = self.identifier(&variant.name);
            // C++ backend requires a valid IntegerNode or UnaryOpNode for enum constant values.
            // Always generate the value directly using ParseDecimalLiteral to test if emit_expr is the issue.
            let val_str = i.to_string();
            let val_ptr = self.intern(&val_str);
            let variant_value = unsafe { sys::ParseDecimalLiteral(val_ptr) };
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_enum: variant_name={:?}, variant_value={:?}", variant_name, variant_value);
            }

            // Try with simpler scope: just use namespace_scope() like struct members do
            let namespace = self.namespace_scope();
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_enum: namespace for {} = {:?}", variant.name, namespace);
            }

            let variant_node = unsafe { sys::ParseEnumConstant(variant_name, variant_value, namespace) };
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_enum: ParseEnumConstant returned {:?}", variant_node);
            }

            // Append directly to list
            variants_list = unsafe { sys::ParseAppendList(variants_list, variant_node) };
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_enum: after append, variants_list = {:?}", variants_list);
            }
        }
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_enum: variants_list = {:?}", variants_list);
        }

        // Use namespace_scope() like structs do
        let namespace = self.namespace_scope();

        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_enum: namespace = {:?}", namespace);
            eprintln!("emit_enum: calling ParseEnum with name={:?}, base_ty={:?}, variants_list={:?}, scope={:?}",
                name, base_ty, variants_list, namespace);
        }

        // WORKAROUND: There's a known issue with ParseEnum and non-empty variants
        // where the C++ backend crashes with a dynamic_cast assertion failure.
        // For now, skip non-empty enums until this is resolved.
        // See: https://github.com/your-org/kanagawa/issues/XXX
        if !e.variants.is_empty() {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_enum: WARNING - skipping enum with variants due to known ParseEnum crash");
            }
            // Return Unsupported error to skip this item gracefully
            return Err(CodeGenError::Unsupported(format!(
                "enum {} with {} variants (ParseEnum crash workaround)",
                e.name, e.variants.len()
            )));
        }

        let result = unsafe { sys::ParseEnum(name, base_ty, variants_list, namespace) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_enum: ParseEnum returned");
        }
        Ok(result)
    }

    /// Emit a class definition.
    pub(crate) fn emit_class(&mut self, c: &HirClass) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: {}, {} members", c.name, c.members.len());
        }

        // WORKAROUND: Classes with member functions crash due to C++ RTTI issues
        // with dynamic_cast across shared library boundaries. Skip them for now.
        let has_functions = c.members.iter().any(|m| matches!(m, HirClassMember::Function(_)));
        if has_functions {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_class: WARNING - skipping class {} with member functions (RTTI workaround)", c.name);
            }
            return Err(CodeGenError::Unsupported(format!(
                "class {} with member functions (RTTI workaround)",
                c.name
            )));
        }

        self.set_location(&c.span);

        let name = self.identifier(&c.name);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: name identifier created");
        }

        // Emit members
        let mut member_nodes = Vec::new();
        for (i, member) in c.members.iter().enumerate() {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_class: emitting member {}: {:?}", i, std::mem::discriminant(member));
            }
            if let Some(node) = self.emit_class_member(member)? {
                member_nodes.push(node);
            }
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_class: member {} emitted", i);
            }
        }
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: {} member nodes total", member_nodes.len());
        }
        let members_list = build_list(&member_nodes);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: members list built");
        }

        let namespace = self.namespace_scope();
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: namespace = {:?}", namespace);
        }
        let scope_str = c.name.clone();

        let unmangled = self.intern(&scope_str);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: calling ParseClass(name={:?}, members={:?}, template=null, ns={:?}, unmangled={:?})",
                      name, members_list, namespace, unmangled);
        }

        // Classes have no explicit base type list (third parameter)
        let result = unsafe { sys::ParseClass(name, members_list, std::ptr::null_mut(), namespace, unmangled) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_class: ParseClass returned {:?}", result);
        }
        Ok(result)
    }

    /// Emit a class member.
    fn emit_class_member(&mut self, member: &HirClassMember) -> CodeGenResult<Option<ParseTreeNodePtr>> {
        match member {
            HirClassMember::Access(access) => {
                let modifier = match access {
                    HirAccessSpecifier::Public => sys::_ParseTreeMemberProtectionModifier_ParseTreeMemberProtectionModifierPublic,
                    HirAccessSpecifier::Private => sys::_ParseTreeMemberProtectionModifier_ParseTreeMemberProtectionModifierPrivate,
                };
                Ok(Some(unsafe { sys::ParseMemberModifier(modifier) }))
            }
            HirClassMember::Variable(var) => Ok(Some(emit_variable(self, var)?)),
            HirClassMember::Function(func) => Ok(Some(self.emit_function(func)?)),
            HirClassMember::DefaultInit(init_expr) => {
                let init = self.emit_expr(init_expr)?;
                Ok(Some(unsafe { sys::ParseDefaultInitialization(init) }))
            }
            HirClassMember::Nested(item) => {
                emit_item(self, item)
            }
        }
    }

    /// Emit a union definition.
    pub(crate) fn emit_union(&mut self, u: &HirUnion) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&u.span);

        let name = self.identifier(&u.name);

        // Emit members
        let mut member_nodes = Vec::new();
        for member in &u.members {
            let member_node = self.emit_struct_member(member)?;
            member_nodes.push(member_node);
        }
        let members_list = build_list(&member_nodes);

        let namespace = self.namespace_scope();
        let scope_str = u.name.clone();

        Ok(unsafe { sys::ParseUnion(name, members_list, namespace, self.intern(&scope_str)) })
    }

    /// Emit a type alias (using).
    pub(crate) fn emit_using(&mut self, u: &HirUsing) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_using: {} -> {:?}", u.name, u.ty);
        }
        self.set_location(&u.span);

        let name = self.identifier(&u.name);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_using: name={:?}", name);
        }
        let ty = self.emit_type(&u.ty)?;
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_using: ty={:?}", ty);
        }
        let namespace = self.namespace_scope();
        let scope_str = u.name.clone();
        let scope_ptr = self.intern(&scope_str);
        // ParseTypedef signature: (typeNode, aliasNode, namespace, unmangledName)
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_using: calling ParseTypedef(ty={:?}, name={:?}, ns={:?}, scope={:?})",
                      ty, name, namespace, scope_ptr);
        }

        let result = unsafe { sys::ParseTypedef(ty, name, namespace, scope_ptr) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_using: ParseTypedef returned {:?}", result);
        }
        Ok(result)
    }

    /// Emit a template definition.
    pub(crate) fn emit_template(&mut self, t: &HirTemplate) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&t.span);

        // Emit template parameters
        let mut param_nodes = Vec::new();
        for param in &t.params {
            let param_node = self.emit_template_param(param)?;
            param_nodes.push(param_node);
        }
        let _params_list = build_list(&param_nodes);

        // Emit the templated item
        // Note: The backend expects template arguments to be part of the item itself
        // This is a simplification - proper template emission needs more work
        if let Some(node) = emit_item(self, &t.item)? {
            Ok(node)
        } else {
            Err(CodeGenError::Internal("template with no item".to_string()))
        }
    }

    /// Emit a template parameter.
    fn emit_template_param(&mut self, param: &HirTemplateParam) -> CodeGenResult<ParseTreeNodePtr> {
        match param {
            HirTemplateParam::Type { span, name, default, .. } => {
                self.set_location(span);
                let _name_id = self.identifier(name);

                let default_ty = if let Some(ty) = default {
                    self.emit_type(ty)?
                } else {
                    std::ptr::null_mut()
                };

                // Template type params are emitted as ParseTemplateArg
                Ok(unsafe { sys::ParseTemplateArg(self.intern(name), default_ty) })
            }
            HirTemplateParam::NonType { span, ty, name, default, .. } => {
                self.set_location(span);
                let param_ty = self.emit_type(ty)?;
                let _name_id = self.identifier(name);

                let _default_val = if let Some(expr) = default {
                    self.emit_expr(expr)?
                } else {
                    std::ptr::null_mut()
                };

                // Non-type template params need the type
                Ok(unsafe { sys::ParseTemplateArg(self.intern(name), param_ty) })
            }
        }
    }

    /// Emit a static if declaration.
    pub(crate) fn emit_static_if(&mut self, si: &HirStaticIf) -> CodeGenResult<Option<ParseTreeNodePtr>> {
        self.set_location(&si.span);

        // Static if at declaration level - evaluate condition at compile time
        // For now, emit both branches and let the backend handle it
        let _cond = self.emit_expr(&si.condition)?;

        let then_item = emit_item(self, &si.then_item)?;
        let _else_item = if let Some(else_item) = &si.else_item {
            emit_item(self, else_item)?
        } else {
            None
        };

        // The backend expects conditional compilation to be resolved
        // For now, return the then branch
        Ok(then_item)
    }

    /// Emit a static assert.
    pub(crate) fn emit_static_assert(&mut self, sa: &HirStaticAssert) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&sa.span);

        let cond = self.emit_expr(&sa.condition)?;
        Ok(unsafe { sys::ParseStaticAssert(cond) })
    }

    /// Emit an extern declaration.
    pub(crate) fn emit_extern(&mut self, ext: &HirExtern) -> CodeGenResult<ParseTreeNodePtr> {
        self.set_location(&ext.span);

        let ty = self.emit_type(&ext.extern_type)?;
        let attrs = self.emit_attrs(&ext.attrs)?;

        Ok(unsafe { sys::ParseExtern(ty, attrs) })
    }

    /// Emit an export declaration.
    pub(crate) fn emit_export(&mut self, exp: &HirExport2) -> CodeGenResult<ParseTreeNodePtr> {
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_export: exported_type = {:?}", exp.exported_type);
        }
        self.set_location(&exp.span);

        let ty = self.emit_type(&exp.exported_type)?;
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_export: type emitted");
        }
        let attrs = self.emit_attrs(&exp.attrs)?;
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_export: attrs emitted, calling ParseExportType");
        }

        let result = unsafe { sys::ParseExportType(ty, attrs) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("emit_export: ParseExportType returned");
        }
        Ok(result)
    }

    /// Emit a declaration block.
    pub(crate) fn emit_decl_block(&mut self, block: &HirDeclBlock) -> CodeGenResult<Option<ParseTreeNodePtr>> {
        self.set_location(&block.span);

        let mut nodes = Vec::new();
        for item in &block.items {
            if let Some(node) = emit_item(self, item)? {
                nodes.push(node);
            }
        }

        if nodes.is_empty() {
            Ok(None)
        } else if nodes.len() == 1 {
            Ok(Some(nodes.into_iter().next().unwrap()))
        } else {
            Ok(Some(build_list(&nodes)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirBlock, Span, Ty, FunctionKind};

    // Note: These tests require the C++ backend to be initialized (InitCompiler called).
    // They are ignored by default because unit tests cannot easily initialize the backend.
    // Run integration tests with the full driver for end-to-end testing.

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_simple_function() {
        let mut cg = CodeGen::new();

        let func = HirFunction {
            span: Span::default(),
            def_id: kanagawa_hir::DefId(0),
            ty: Ty::Void,
            kind: FunctionKind::Free,
            attrs: vec![],
            modifier: None,
            return_ty: Ty::Void,
            name: "test".to_string(),
            params: vec![],
            body: Some(HirBlock {
                span: Span::default(),
                stmts: vec![],
            }),
        };

        let result = cg.emit_function(&func);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_variable() {
        let mut cg = CodeGen::new();

        let var = HirVariable {
            span: Span::default(),
            def_id: kanagawa_hir::DefId(0),
            ty: Ty::Signed(32),
            name: "x".to_string(),
            init: None,
            flags: HirDeclFlags::default(),
        };

        let result = emit_variable(&mut cg, &var);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_struct() {
        let mut cg = CodeGen::new();

        let s = HirStruct {
            span: Span::default(),
            def_id: kanagawa_hir::DefId(0),
            ty: Ty::Struct { name: vec!["Point".to_string()], fields: vec![] },
            name: "Point".to_string(),
            members: vec![
                HirStructMember {
                    span: Span::default(),
                    def_id: kanagawa_hir::DefId(1),
                    ty: Ty::Signed(32),
                    name: "x".to_string(),
                    init: None,
                },
                HirStructMember {
                    span: Span::default(),
                    def_id: kanagawa_hir::DefId(2),
                    ty: Ty::Signed(32),
                    name: "y".to_string(),
                    init: None,
                },
            ],
        };

        let result = cg.emit_struct(&s);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_enum() {
        let mut cg = CodeGen::new();

        let e = HirEnum {
            span: Span::default(),
            def_id: kanagawa_hir::DefId(0),
            ty: Ty::Enum { name: vec!["Color".to_string()], base: Box::new(Ty::Unsigned(8)) },
            name: "Color".to_string(),
            base_ty: Ty::Unsigned(8),
            variants: vec![],
        };

        let result = cg.emit_enum(&e);
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_emit_using() {
        let mut cg = CodeGen::new();

        let u = HirUsing {
            span: Span::default(),
            def_id: kanagawa_hir::DefId(0),
            name: "MyInt".to_string(),
            ty: Ty::Signed(32),
        };

        let result = cg.emit_using(&u);
        assert!(result.is_ok());
    }
}
