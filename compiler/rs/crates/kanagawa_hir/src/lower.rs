//! AST to HIR lowering.
//!
//! This module converts the AST to HIR while performing name resolution
//! and building the symbol table.

use crate::def::{DefId, DefKind, Visibility};
use crate::global::GlobalTypeRegistry;
use crate::hir::*;
use crate::namespace::encode_module_namespace;
use crate::symbol::{ScopeKind, SymbolTable};
use crate::ty::{Ty, TyAttr, TyAttrFlag, TyAttrName, TyFuncParam, FunctionKind};
use crate::Span;

use kanagawa_ast as ast;

/// Errors that can occur during lowering.
#[derive(Debug, Clone)]
pub enum LowerError {
    /// A required child node was missing.
    MissingChild(String),
    /// An unsupported construct was encountered.
    Unsupported(String),
    /// Name resolution failed.
    UndefinedSymbol { name: String, span: Span },
    /// Duplicate definition.
    DuplicateDefinition { name: String, span: Span },
}

impl std::fmt::Display for LowerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LowerError::MissingChild(s) => write!(f, "missing child: {}", s),
            LowerError::Unsupported(s) => write!(f, "unsupported: {}", s),
            LowerError::UndefinedSymbol { name, .. } => write!(f, "undefined symbol: {}", name),
            LowerError::DuplicateDefinition { name, .. } => write!(f, "duplicate definition: {}", name),
        }
    }
}

impl std::error::Error for LowerError {}

/// Lower an AST file to HIR.
pub fn lower_file(file: &ast::File) -> Result<(HirFile, SymbolTable), Vec<LowerError>> {
    let mut lowerer = Lowerer::new(None);
    let hir = lowerer.lower_file(file)?;
    Ok((hir, lowerer.symbols))
}

/// Lower an AST file to HIR with access to a global type registry.
///
/// The global registry contains type definitions from imported modules,
/// allowing cross-module type resolution.
pub fn lower_file_with_registry<'a>(
    file: &ast::File,
    registry: &'a GlobalTypeRegistry,
) -> Result<(HirFile, SymbolTable), Vec<LowerError>> {
    let mut lowerer = Lowerer::new(Some(registry));
    let hir = lowerer.lower_file(file)?;
    Ok((hir, lowerer.symbols))
}

/// The lowering context.
struct Lowerer<'a> {
    symbols: SymbolTable,
    errors: Vec<LowerError>,
    /// Current module namespace prefix.
    module_namespace: Option<String>,
    /// Global type registry for cross-module resolution.
    global_registry: Option<&'a GlobalTypeRegistry>,
}

impl<'a> Lowerer<'a> {
    fn new(global_registry: Option<&'a GlobalTypeRegistry>) -> Self {
        let mut symbols = SymbolTable::new();
        // Register builtin symbols before processing any user code
        crate::builtin::register_builtins(&mut symbols);

        Self {
            symbols,
            errors: Vec::new(),
            module_namespace: None,
            global_registry,
        }
    }

    fn lower_file(&mut self, file: &ast::File) -> Result<HirFile, Vec<LowerError>> {
        // Lower module declaration first to set up namespace
        let module = file.module.as_ref().map(|m| self.lower_module(m));

        // Lower imports
        let imports: Vec<_> = file.imports.iter().map(|i| self.lower_import(i)).collect();

        // Lower top-level declarations
        let items: Vec<_> = file
            .decls
            .iter()
            .filter_map(|d| self.lower_decl(d).ok())
            .collect();

        if self.errors.is_empty() {
            Ok(HirFile {
                span: file.span,
                module,
                imports,
                items,
            })
        } else {
            Err(std::mem::take(&mut self.errors))
        }
    }

    fn lower_module(&mut self, module: &ast::ModuleDecl) -> HirModule {
        let segments: Vec<_> = module.name.segments.iter().map(|n| n.text.as_str()).collect();
        let namespace = encode_module_namespace(&segments);

        // Set the module namespace for this file
        self.module_namespace = Some(namespace.clone());
        self.symbols.set_scope_prefix(vec![namespace.clone()]);

        // Create module definition
        let def_id = self.symbols.define(
            &namespace,
            DefKind::Module,
            Ty::Untyped,
            module.span,
        );

        let exports = module.exports.iter().map(|e| self.lower_export(e)).collect();

        HirModule {
            span: module.span,
            def_id,
            namespace,
            exports,
        }
    }

    fn lower_export(&self, export: &ast::ModuleExport) -> HirExport {
        match export {
            ast::ModuleExport::Ident(name) => HirExport::Name(name.text.clone()),
            ast::ModuleExport::Module(m) => {
                let segments: Vec<_> = m.segments.iter().map(|n| n.text.as_str()).collect();
                HirExport::Module(encode_module_namespace(&segments))
            }
            ast::ModuleExport::ModuleDiff { include, exclude } => {
                let inc_segs: Vec<_> = include.segments.iter().map(|n| n.text.as_str()).collect();
                let exc_segs: Vec<_> = exclude.segments.iter().map(|n| n.text.as_str()).collect();
                HirExport::ModuleDiff {
                    include: encode_module_namespace(&inc_segs),
                    exclude: encode_module_namespace(&exc_segs),
                }
            }
        }
    }

    fn lower_import(&self, import: &ast::ImportDecl) -> HirImport {
        let segments: Vec<_> = import.name.segments.iter().map(|n| n.text.as_str()).collect();
        HirImport {
            span: import.span,
            namespace: encode_module_namespace(&segments),
            alias: import.alias.as_ref().map(|a| a.text.clone()),
        }
    }

    fn lower_decl(&mut self, decl: &ast::Decl) -> Result<HirItem, LowerError> {
        match decl {
            ast::Decl::Function(f) => {
                let func = self.lower_function(f)?;
                // Check if this function has auto parameters - if so, convert to template
                // This matches the Haskell frontend's "abbreviated function template" pattern:
                // inline void print(auto x) -> template<typename x$T> inline void print(x$T x)
                Ok(self.maybe_wrap_function_in_template(func))
            }
            ast::Decl::Variable(v) => {
                // Top-level variables (at file scope) are global
                let mut var = self.lower_variable(v)?;
                var.flags.is_global = true;
                Ok(HirItem::Variable(var))
            }
            ast::Decl::Struct(s) => Ok(HirItem::Struct(self.lower_struct(s)?)),
            ast::Decl::Enum(e) => Ok(HirItem::Enum(self.lower_enum(e)?)),
            ast::Decl::Class(c) => Ok(HirItem::Class(self.lower_class(c)?)),
            ast::Decl::Union(u) => Ok(HirItem::Union(self.lower_union(u)?)),
            ast::Decl::Using(u) => Ok(HirItem::Using(self.lower_using(u)?)),
            ast::Decl::Template(t) => Ok(HirItem::Template(self.lower_template(t)?)),
            ast::Decl::StaticIf(si) => Ok(HirItem::StaticIf(self.lower_static_if_decl(si)?)),
            ast::Decl::StaticAssert(sa) => Ok(HirItem::StaticAssert(self.lower_static_assert(sa)?)),
            ast::Decl::Extern(e) => Ok(HirItem::Extern(self.lower_extern(e)?)),
            ast::Decl::Export(e) => Ok(HirItem::Export(self.lower_export_decl(e)?)),
            ast::Decl::DeclBlock(db) => {
                // Lower all declarations in the block
                let mut items = Vec::new();
                for decl in &db.decls {
                    if let Ok(item) = self.lower_decl(decl) {
                        items.push(item);
                    }
                }
                Ok(HirItem::DeclBlock(HirDeclBlock {
                    span: db.span,
                    items,
                }))
            }
        }
    }

    fn lower_function(&mut self, func: &ast::FunctionDecl) -> Result<HirFunction, LowerError> {
        let name = func.name.text.clone();
        let mut return_ty = self.lower_type(&func.return_type);

        // Create function definition
        let def_id = self.symbols.define(
            &name,
            DefKind::Function,
            Ty::Unresolved, // Will be filled in with full function type
            func.span,
        );

        // Push function scope for parameters
        self.symbols.push_scope(ScopeKind::Function);
        self.symbols.set_scope_def(def_id);

        // Lower parameters
        let params: Vec<_> = func
            .params
            .iter()
            .map(|p| self.lower_param(p))
            .collect::<Result<_, _>>()?;

        // Build function type
        let param_tys: Vec<_> = params
            .iter()
            .map(|p| TyFuncParam {
                attrs: Vec::new(),
                ty: p.ty.clone(),
                name: Some(p.name.clone()),
            })
            .collect();

        let attrs = self.lower_attrs(&func.attrs);

        // Lower body (if present)
        let body = func.body.as_ref().map(|b| self.lower_block(b));

        // If return type is Auto, try to infer from return statements in the body
        // This matches the Haskell frontend behavior where:
        // returnType Auto = maybe TVoid typeOf $ find returnExp $ unfix body
        if matches!(return_ty, Ty::Auto) {
            if let Some(ref body) = body {
                if let Some(inferred_ty) = self.infer_return_type_from_body(body) {
                    return_ty = inferred_ty;
                } else {
                    // No return statements found - default to Void
                    return_ty = Ty::Void;
                }
            }
        }

        let func_ty = Ty::Function {
            kind: FunctionKind::Free,
            attrs: attrs.clone(),
            return_ty: Box::new(return_ty.clone()),
            params: param_tys,
        };

        // Update the definition with the function type
        if let Some(entry) = self.symbols.get_mut(def_id) {
            entry.ty = func_ty.clone();
        }

        self.symbols.pop_scope();

        let modifier = func.modifier.map(|m| match m {
            ast::FunctionModifier::Inline => HirFunctionModifier::Inline,
            ast::FunctionModifier::NoInline => HirFunctionModifier::NoInline,
        });

        Ok(HirFunction {
            span: func.span,
            def_id,
            ty: func_ty,
            kind: FunctionKind::Free,
            attrs,
            modifier,
            return_ty,
            name,
            params,
            body,
        })
    }

    /// Check if a function has auto parameters and wrap it in a template if so.
    /// This implements "abbreviated function template" syntax:
    /// `inline void print(auto x)` becomes `template<typename x$T> inline void print(x$T x)`
    fn maybe_wrap_function_in_template(&mut self, mut func: HirFunction) -> HirItem {
        // Find parameters with Ty::Auto
        let auto_params: Vec<(usize, String)> = func.params
            .iter()
            .enumerate()
            .filter(|(_, p)| matches!(p.ty, Ty::Auto))
            .map(|(i, p)| (i, p.name.clone()))
            .collect();

        if auto_params.is_empty() {
            // No auto params - return as regular function
            return HirItem::Function(func);
        }

        // Create template type parameters for each auto param
        // Named "{param_name}$T" following Haskell convention
        let mut template_params = Vec::new();
        for (idx, param_name) in &auto_params {
            let template_param_name = format!("{}$T", param_name);
            let template_def_id = self.symbols.define(
                &template_param_name,
                DefKind::TemplateParam,
                Ty::Template,
                func.span,
            );
            template_params.push(HirTemplateParam::Type {
                span: func.span,
                def_id: template_def_id,
                name: template_param_name.clone(),
                default: None,
            });

            // Update the parameter's type to reference the template type parameter
            // Use Ty::Reference with the template param name
            func.params[*idx].ty = Ty::Reference(vec![template_param_name]);
        }

        // Rebuild the function type with updated parameter types
        let param_tys: Vec<_> = func.params
            .iter()
            .map(|p| TyFuncParam {
                attrs: Vec::new(),
                ty: p.ty.clone(),
                name: Some(p.name.clone()),
            })
            .collect();

        func.ty = Ty::Function {
            kind: func.kind.clone(),
            attrs: func.attrs.clone(),
            return_ty: Box::new(func.return_ty.clone()),
            params: param_tys,
        };

        // Update the symbol table with the new function type
        if let Some(entry) = self.symbols.get_mut(func.def_id) {
            entry.ty = func.ty.clone();
        }

        // Create a template definition wrapping the function
        let template_def_id = self.symbols.define(
            &func.name,
            DefKind::Template,
            Ty::Template,
            func.span,
        );

        HirItem::Template(HirTemplate {
            span: func.span,
            def_id: template_def_id,
            params: template_params,
            item: Box::new(HirItem::Function(func)),
        })
    }

    /// Infer return type from a function body by looking at return statements.
    /// Returns the type of the first return statement found, or None if no returns.
    fn infer_return_type_from_body(&self, body: &HirBlock) -> Option<Ty> {
        self.find_return_type_in_stmts(&body.stmts)
    }

    fn find_return_type_in_stmts(&self, stmts: &[HirStmt]) -> Option<Ty> {
        for stmt in stmts {
            if let Some(ty) = self.find_return_type_in_stmt(stmt) {
                return Some(ty);
            }
        }
        None
    }

    fn find_return_type_in_stmt(&self, stmt: &HirStmt) -> Option<Ty> {
        match stmt {
            HirStmt::Return(ret) => {
                // Get type from the return expression
                ret.value.as_ref().map(|e| e.ty.clone())
            }
            HirStmt::Block(block) => {
                self.find_return_type_in_stmts(&block.stmts)
            }
            HirStmt::If(if_stmt) => {
                // Check both branches
                if let Some(ty) = self.find_return_type_in_stmt(&if_stmt.then_branch) {
                    return Some(ty);
                }
                if let Some(else_branch) = &if_stmt.else_branch {
                    return self.find_return_type_in_stmt(else_branch);
                }
                None
            }
            HirStmt::StaticIf(static_if) => {
                // Check both branches of static if
                if let Some(ty) = self.find_return_type_in_stmt(&static_if.then_branch) {
                    return Some(ty);
                }
                if let Some(else_branch) = &static_if.else_branch {
                    return self.find_return_type_in_stmt(else_branch);
                }
                None
            }
            // Other statements don't contain return statements directly
            _ => None,
        }
    }

    fn lower_param(&mut self, param: &ast::FunctionParam) -> Result<HirParam, LowerError> {
        let ty = self.lower_type(&param.ty);
        let name = param.name.text.clone();

        let def_id = self.symbols.define(&name, DefKind::Param, ty.clone(), param.span);

        let default = param.default.as_ref().map(|e| self.lower_expr(e));

        Ok(HirParam {
            span: param.span,
            def_id,
            ty,
            name,
            default,
        })
    }

    fn lower_variable(&mut self, var: &ast::VariableDecl) -> Result<HirVariable, LowerError> {
        let ty = self.lower_type(&var.ty);
        let name = var.name.text.clone();

        let def_id = self.symbols.define(&name, DefKind::Variable, ty.clone(), var.span);

        let init = var.init.as_ref().map(|e| self.lower_expr(e));

        Ok(HirVariable {
            span: var.span,
            def_id,
            ty,
            name,
            init,
            flags: HirDeclFlags {
                is_const: var.flags.is_const,
                is_static: var.flags.is_static,
                is_global: var.flags.is_global,
            },
        })
    }

    fn lower_struct(&mut self, s: &ast::StructDecl) -> Result<HirStruct, LowerError> {
        let name = s.name.text.clone();

        // Create struct type
        let def_id = self.symbols.define(&name, DefKind::Type, Ty::Unresolved, s.span);

        self.symbols.push_scope(ScopeKind::Struct);
        self.symbols.set_scope_def(def_id);

        let members: Vec<_> = s
            .members
            .iter()
            .map(|m| self.lower_struct_member(m))
            .collect::<Result<_, _>>()?;

        // Build struct type with fields
        let fields: Vec<_> = members.iter().map(|m| (m.name.clone(), m.ty.clone())).collect();
        let struct_ty = Ty::Struct {
            name: self.qualified_name(&name),
            fields,
        };

        // Update definition
        if let Some(entry) = self.symbols.get_mut(def_id) {
            entry.ty = Ty::Type(Box::new(struct_ty.clone()));
        }

        self.symbols.pop_scope();

        Ok(HirStruct {
            span: s.span,
            def_id,
            ty: struct_ty,
            name,
            members,
        })
    }

    fn lower_struct_member(&mut self, m: &ast::StructMember) -> Result<HirStructMember, LowerError> {
        let ty = self.lower_type(&m.ty);
        let name = m.name.text.clone();

        let def_id = self.symbols.define(&name, DefKind::Field, ty.clone(), m.span);

        let init = m.init.as_ref().map(|e| self.lower_expr(e));

        Ok(HirStructMember {
            span: m.span,
            def_id,
            ty,
            name,
            init,
        })
    }

    fn lower_enum(&mut self, e: &ast::EnumDecl) -> Result<HirEnum, LowerError> {
        let name = e.name.text.clone();
        let base_ty = self.lower_type(&e.base_type);

        let def_id = self.symbols.define(&name, DefKind::Type, Ty::Unresolved, e.span);

        self.symbols.push_scope(ScopeKind::Enum);
        self.symbols.set_scope_def(def_id);

        let variants: Vec<_> = e
            .variants
            .iter()
            .map(|v| self.lower_enum_variant(v))
            .collect::<Result<_, _>>()?;

        let enum_ty = Ty::Enum {
            name: self.qualified_name(&name),
            base: Box::new(base_ty.clone()),
        };

        if let Some(entry) = self.symbols.get_mut(def_id) {
            entry.ty = Ty::Type(Box::new(enum_ty.clone()));
        }

        self.symbols.pop_scope();

        Ok(HirEnum {
            span: e.span,
            def_id,
            ty: enum_ty,
            name,
            base_ty,
            variants,
        })
    }

    fn lower_enum_variant(&mut self, v: &ast::EnumVariant) -> Result<HirEnumVariant, LowerError> {
        let name = v.name.text.clone();
        let def_id = self.symbols.define(&name, DefKind::EnumVariant, Ty::Unresolved, v.span);

        let value = v.value.as_ref().map(|e| self.lower_expr(e));

        Ok(HirEnumVariant {
            span: v.span,
            def_id,
            name,
            value,
        })
    }

    fn lower_class(&mut self, c: &ast::ClassDecl) -> Result<HirClass, LowerError> {
        let name = c.name.text.clone();

        let def_id = self.symbols.define(&name, DefKind::Type, Ty::Unresolved, c.span);

        self.symbols.push_scope(ScopeKind::Class);
        self.symbols.set_scope_def(def_id);

        let mut members = Vec::new();
        let mut fields = Vec::new();
        let mut _current_visibility = Visibility::Private;

        for member in &c.members {
            match member {
                ast::ClassMember::Access(access) => {
                    let spec = match access {
                        ast::AccessSpecifier::Public => {
                            _current_visibility = Visibility::Public;
                            HirAccessSpecifier::Public
                        }
                        ast::AccessSpecifier::Private => {
                            _current_visibility = Visibility::Private;
                            HirAccessSpecifier::Private
                        }
                    };
                    members.push(HirClassMember::Access(spec));
                }
                ast::ClassMember::Variable(v) => {
                    let var = self.lower_variable(v)?;
                    fields.push((var.name.clone(), var.ty.clone()));
                    members.push(HirClassMember::Variable(var));
                }
                ast::ClassMember::Function(f) => {
                    let func = self.lower_function(f)?;
                    members.push(HirClassMember::Function(func));
                }
                ast::ClassMember::DefaultInit(e) => {
                    members.push(HirClassMember::DefaultInit(self.lower_expr(e)));
                }
                ast::ClassMember::NestedDecl(d) => {
                    if let Ok(item) = self.lower_decl(d) {
                        members.push(HirClassMember::Nested(Box::new(item)));
                    }
                }
            }
        }

        let class_ty = Ty::Class {
            name: self.qualified_name(&name),
            fields,
        };

        if let Some(entry) = self.symbols.get_mut(def_id) {
            entry.ty = Ty::Type(Box::new(class_ty.clone()));
        }

        self.symbols.pop_scope();

        Ok(HirClass {
            span: c.span,
            def_id,
            ty: class_ty,
            name,
            members,
        })
    }

    fn lower_union(&mut self, u: &ast::UnionDecl) -> Result<HirUnion, LowerError> {
        let name = u.name.text.clone();

        let def_id = self.symbols.define(&name, DefKind::Type, Ty::Unresolved, u.span);

        self.symbols.push_scope(ScopeKind::Union);
        self.symbols.set_scope_def(def_id);

        let members: Vec<_> = u
            .members
            .iter()
            .map(|m| self.lower_struct_member(m))
            .collect::<Result<_, _>>()?;

        let fields: Vec<_> = members.iter().map(|m| (m.name.clone(), m.ty.clone())).collect();
        let union_ty = Ty::Union {
            name: self.qualified_name(&name),
            fields,
        };

        if let Some(entry) = self.symbols.get_mut(def_id) {
            entry.ty = Ty::Type(Box::new(union_ty.clone()));
        }

        self.symbols.pop_scope();

        Ok(HirUnion {
            span: u.span,
            def_id,
            ty: union_ty,
            name,
            members,
        })
    }

    fn lower_using(&mut self, u: &ast::UsingDecl) -> Result<HirUsing, LowerError> {
        let name = u.name.text.clone();
        let ty = self.lower_type(&u.ty);

        let def_id = self.symbols.define(&name, DefKind::Type, Ty::Type(Box::new(ty.clone())), u.span);

        Ok(HirUsing {
            span: u.span,
            def_id,
            name,
            ty,
        })
    }

    fn lower_template(&mut self, t: &ast::TemplateDecl) -> Result<HirTemplate, LowerError> {
        self.symbols.push_scope(ScopeKind::Template);

        let params: Vec<_> = t
            .params
            .iter()
            .map(|p| self.lower_template_param(p))
            .collect::<Result<_, _>>()?;

        let item = self.lower_decl(&t.decl)?;

        // Get the definition from the inner item
        let def_id = match &item {
            HirItem::Function(f) => f.def_id,
            HirItem::Struct(s) => s.def_id,
            HirItem::Class(c) => c.def_id,
            HirItem::Union(u) => u.def_id,
            HirItem::Enum(e) => e.def_id,
            HirItem::Using(u) => u.def_id,
            _ => DefId::INVALID,
        };

        self.symbols.pop_scope();

        Ok(HirTemplate {
            span: t.span,
            def_id,
            params,
            item: Box::new(item),
        })
    }

    fn lower_template_param(&mut self, p: &ast::TemplateParam) -> Result<HirTemplateParam, LowerError> {
        match p {
            ast::TemplateParam::Type { span, name, default } => {
                let def_id = self.symbols.define(&name.text, DefKind::TemplateParam, Ty::Template, *span);
                let default_ty = default.as_ref().map(|t| self.lower_type(t));
                Ok(HirTemplateParam::Type {
                    span: *span,
                    def_id,
                    name: name.text.clone(),
                    default: default_ty,
                })
            }
            ast::TemplateParam::NonType { span, ty, name, default } => {
                let param_ty = self.lower_type(ty);
                let def_id = self.symbols.define(&name.text, DefKind::TemplateParam, param_ty.clone(), *span);
                let default_expr = default.as_ref().map(|e| self.lower_expr(e));
                Ok(HirTemplateParam::NonType {
                    span: *span,
                    def_id,
                    ty: param_ty,
                    name: name.text.clone(),
                    default: default_expr,
                })
            }
        }
    }

    fn lower_static_if_decl(&mut self, si: &ast::StaticIfDecl) -> Result<HirStaticIf, LowerError> {
        let condition = self.lower_expr(&si.condition);
        let then_item = self.lower_decl(&si.then_decl)?;
        let else_item = si
            .else_decl
            .as_ref()
            .map(|d| self.lower_decl(d))
            .transpose()?;

        Ok(HirStaticIf {
            span: si.span,
            condition,
            then_item: Box::new(then_item),
            else_item: else_item.map(Box::new),
        })
    }

    fn lower_static_assert(&mut self, sa: &ast::StaticAssertDecl) -> Result<HirStaticAssert, LowerError> {
        Ok(HirStaticAssert {
            span: sa.span,
            condition: self.lower_expr(&sa.condition),
        })
    }

    fn lower_extern(&mut self, e: &ast::ExternDecl) -> Result<HirExtern, LowerError> {
        let attrs = self.lower_attrs(&e.attrs);
        let extern_type = self.lower_type(&e.extern_type);
        Ok(HirExtern {
            span: e.span,
            attrs,
            extern_type,
        })
    }

    fn lower_export_decl(&mut self, e: &ast::ExportDecl) -> Result<HirExport2, LowerError> {
        let attrs = self.lower_attrs(&e.attrs);
        let exported_type = self.lower_type(&e.exported_type);
        Ok(HirExport2 {
            span: e.span,
            attrs,
            exported_type,
        })
    }

    // ========================================================================
    // Statements
    // ========================================================================

    fn lower_block(&mut self, block: &ast::Block) -> HirBlock {
        self.symbols.push_scope(ScopeKind::Block);
        let stmts: Vec<_> = block.stmts.iter().map(|s| self.lower_stmt(s)).collect();
        self.symbols.pop_scope();
        HirBlock {
            span: block.span,
            stmts,
        }
    }

    fn lower_stmt(&mut self, stmt: &ast::Stmt) -> HirStmt {
        match stmt {
            ast::Stmt::Block(b) => HirStmt::Block(self.lower_block(b)),
            ast::Stmt::Return(r) => HirStmt::Return(HirReturn {
                span: r.span,
                value: r.value.as_ref().map(|e| self.lower_expr(e)),
            }),
            ast::Stmt::If(i) => HirStmt::If(HirIf {
                span: i.span,
                condition: self.lower_expr(&i.condition),
                then_branch: Box::new(self.lower_stmt(&i.then_branch)),
                else_branch: i.else_branch.as_ref().map(|e| Box::new(self.lower_stmt(e))),
            }),
            ast::Stmt::Switch(s) => HirStmt::Switch(self.lower_switch(s)),
            ast::Stmt::DoWhile(d) => HirStmt::DoWhile(HirDoWhile {
                span: d.span,
                attrs: self.lower_attrs(&d.attrs),
                body: Box::new(self.lower_stmt(&d.body)),
                condition: self.lower_expr(&d.condition),
            }),
            ast::Stmt::RangeFor(r) => self.lower_range_for(r),
            ast::Stmt::StaticFor(s) => self.lower_static_for(s),
            ast::Stmt::UnrolledFor(u) => self.lower_unrolled_for(u),
            ast::Stmt::StaticIf(si) => HirStmt::StaticIf(HirStaticIfStmt {
                span: si.span,
                condition: self.lower_expr(&si.condition),
                then_branch: Box::new(self.lower_stmt(&si.then_branch)),
                else_branch: si.else_branch.as_ref().map(|e| Box::new(self.lower_stmt(e))),
            }),
            ast::Stmt::Barrier(span) => HirStmt::Barrier(*span),
            ast::Stmt::Reorder(r) => HirStmt::Reorder(HirReorder {
                span: r.span,
                body: Box::new(self.lower_stmt(&r.body)),
            }),
            ast::Stmt::Atomic(a) => HirStmt::Atomic(HirAtomic {
                span: a.span,
                body: Box::new(self.lower_stmt(&a.body)),
            }),
            ast::Stmt::Break(span) => HirStmt::Break(*span),
            ast::Stmt::Expr(e) => HirStmt::Expr(HirExprStmt {
                span: e.span,
                expr: self.lower_expr(&e.expr),
            }),
            ast::Stmt::Assign(a) => HirStmt::Assign(HirAssign {
                span: a.span,
                lhs: self.lower_expr(&a.lhs),
                op: self.lower_assign_op(a.op),
                rhs: self.lower_expr(&a.rhs),
            }),
            ast::Stmt::VarDecl(v) => {
                match self.lower_variable(v) {
                    Ok(var) => HirStmt::VarDecl(var),
                    Err(_) => HirStmt::Expr(HirExprStmt {
                        span: v.span,
                        expr: HirExpr::new(v.span, Ty::Error("lowering error".to_string()), HirExprKind::Error("lowering error".to_string())),
                    }),
                }
            }
            ast::Stmt::Annotated(a) => HirStmt::Annotated(HirAnnotated {
                span: a.span,
                attrs: self.lower_attrs(&a.attrs),
                stmt: Box::new(self.lower_stmt(&a.stmt)),
            }),
        }
    }

    fn lower_switch(&mut self, s: &ast::SwitchStmt) -> HirSwitch {
        let cases = s
            .cases
            .iter()
            .map(|c| {
                let label = match &c.label {
                    ast::SwitchLabel::Case(e) => HirSwitchLabel::Case(self.lower_expr(e)),
                    ast::SwitchLabel::Default => HirSwitchLabel::Default,
                };
                HirSwitchCase {
                    span: c.span,
                    label,
                    stmts: c.stmts.iter().map(|s| self.lower_stmt(s)).collect(),
                }
            })
            .collect();

        HirSwitch {
            span: s.span,
            expr: self.lower_expr(&s.expr),
            cases,
        }
    }

    fn lower_range_for(&mut self, r: &ast::RangeForStmt) -> HirStmt {
        let var_ty = self.lower_type(&r.var_type);
        let var_name = r.var_name.text.clone();

        self.symbols.push_scope(ScopeKind::Block);
        let var_def_id = self.symbols.define(&var_name, DefKind::Variable, var_ty.clone(), r.span);

        let limit = self.lower_expr(&r.limit);
        let body = self.lower_stmt(&r.body);

        self.symbols.pop_scope();

        HirStmt::RangeFor(HirRangeFor {
            span: r.span,
            attrs: self.lower_attrs(&r.attrs),
            var_def_id,
            var_ty,
            var_name,
            limit,
            body: Box::new(body),
        })
    }

    fn lower_static_for(&mut self, s: &ast::StaticForStmt) -> HirStmt {
        let var_ty = self.lower_type(&s.var_type);
        let var_name = s.var_name.text.clone();

        self.symbols.push_scope(ScopeKind::Block);
        let var_def_id = self.symbols.define(&var_name, DefKind::Variable, var_ty.clone(), s.span);

        let limit = self.lower_expr(&s.limit);
        let body = self.lower_stmt(&s.body);

        self.symbols.pop_scope();

        HirStmt::StaticFor(HirStaticFor {
            span: s.span,
            var_def_id,
            var_ty,
            var_name,
            limit,
            body: Box::new(body),
        })
    }

    fn lower_unrolled_for(&mut self, u: &ast::UnrolledForStmt) -> HirStmt {
        let var_ty = self.lower_type(&u.var_type);
        let var_name = u.var_name.text.clone();

        self.symbols.push_scope(ScopeKind::Block);
        let var_def_id = self.symbols.define(&var_name, DefKind::Variable, var_ty.clone(), u.span);

        let limit = self.lower_expr(&u.limit);
        let body = self.lower_stmt(&u.body);

        self.symbols.pop_scope();

        HirStmt::UnrolledFor(HirUnrolledFor {
            span: u.span,
            var_def_id,
            var_ty,
            var_name,
            limit,
            body: Box::new(body),
        })
    }

    fn lower_assign_op(&self, op: ast::AssignOp) -> HirAssignOp {
        match op {
            ast::AssignOp::Assign => HirAssignOp::Assign,
            ast::AssignOp::AddAssign => HirAssignOp::AddAssign,
            ast::AssignOp::SubAssign => HirAssignOp::SubAssign,
            ast::AssignOp::MulAssign => HirAssignOp::MulAssign,
            ast::AssignOp::DivAssign => HirAssignOp::DivAssign,
            ast::AssignOp::ModAssign => HirAssignOp::ModAssign,
            ast::AssignOp::ShlAssign => HirAssignOp::ShlAssign,
            ast::AssignOp::ShrAssign => HirAssignOp::ShrAssign,
            ast::AssignOp::AndAssign => HirAssignOp::AndAssign,
            ast::AssignOp::OrAssign => HirAssignOp::OrAssign,
            ast::AssignOp::XorAssign => HirAssignOp::XorAssign,
        }
    }

    // ========================================================================
    // Expressions
    // ========================================================================

    fn lower_expr(&mut self, expr: &ast::Expr) -> HirExpr {
        match expr {
            ast::Expr::IntLiteral(lit) => HirExpr::new(
                lit.span,
                self.infer_int_literal_type(lit.value, lit.suffix),
                HirExprKind::IntLiteral {
                    value: lit.value,
                    suffix: lit.suffix.map(|s| HirIntSuffix {
                        signed: s.signed,
                        width: s.width,
                    }),
                },
            ),
            ast::Expr::FloatLiteral(lit) => HirExpr::new(
                lit.span,
                Ty::Float,
                HirExprKind::FloatLiteral(lit.value),
            ),
            ast::Expr::BoolLiteral(lit) => HirExpr::new(
                lit.span,
                Ty::Bool,
                HirExprKind::BoolLiteral(lit.value),
            ),
            ast::Expr::StringLiteral(lit) => HirExpr::new(
                lit.span,
                Ty::String,
                HirExprKind::StringLiteral(lit.value.clone()),
            ),
            ast::Expr::InterpolatedString(s) => self.lower_interpolated_string(s),
            ast::Expr::Ident(id) => self.lower_ident_expr(id),
            ast::Expr::QualifiedIdent(qid) => self.lower_qualified_ident(qid),
            ast::Expr::Binary(b) => self.lower_binary_expr(b),
            ast::Expr::Unary(u) => self.lower_unary_expr(u),
            ast::Expr::Ternary(t) => self.lower_ternary_expr(t),
            ast::Expr::Call(c) => self.lower_call_expr(c),
            ast::Expr::Member(m) => self.lower_member_expr(m),
            ast::Expr::Subscript(s) => self.lower_subscript_expr(s),
            ast::Expr::Cast(c) => self.lower_cast_expr(c),
            ast::Expr::Mux(m) => self.lower_mux_expr(m),
            ast::Expr::Concat(c) => self.lower_concat_expr(c),
            ast::Expr::FanOut(f) => self.lower_fanout_expr(f),
            ast::Expr::Static(s) => {
                let inner = self.lower_expr(&s.expr);
                HirExpr::new(s.span, inner.ty.clone(), HirExprKind::Static(Box::new(inner)))
            }
            ast::Expr::InitializerList(i) => self.lower_initializer_list(i),
            ast::Expr::DesignatedInitializer(d) => self.lower_designated_init(d),
            ast::Expr::Paren(p) => {
                let inner = self.lower_expr(&p.expr);
                HirExpr::new(p.span, inner.ty.clone(), HirExprKind::Paren(Box::new(inner)))
            }
            ast::Expr::TypeExpr(t) => HirExpr::new(
                t.span,
                Ty::Type(Box::new(self.lower_type(&t.ty))),
                HirExprKind::TypeExpr(self.lower_type(&t.ty)),
            ),
            ast::Expr::Lambda(l) => self.lower_lambda(l),
            ast::Expr::Sizeof(s) => self.lower_sizeof(s),
            ast::Expr::Offsetof(o) => self.lower_offsetof(o),
            ast::Expr::Unit(span) => {
                // Unit expression `()` - represents void/unit type
                HirExpr::new(*span, Ty::Void, HirExprKind::Unit)
            }
        }
    }

    fn lower_ident_expr(&mut self, id: &ast::IdentExpr) -> HirExpr {
        let name = id.name.text.clone();

        // Handle the `this` keyword specially - it refers to the current class instance
        if name == "this" {
            // Get the current scope (class namespace) for the this reference
            let scope = self.module_namespace.as_ref()
                .map(|ns| ns.split('@').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
                .unwrap_or_default();
            return HirExpr::new(id.span, Ty::Unresolved, HirExprKind::This { scope });
        }

        // Try to resolve the name
        let def_id = self.symbols.lookup(&name).unwrap_or(DefId::INVALID);

        // Get type from symbol table if found.
        // Note: undefined symbols are NOT errors during single-file lowering
        // since they may come from imported modules or forward declarations.
        // Full resolution happens in a later multi-file pass.
        let ty = if def_id.is_valid() {
            self.symbols.ty(def_id).cloned().unwrap_or(Ty::Unresolved)
        } else {
            Ty::Unresolved
        };

        HirExpr::new(id.span, ty, HirExprKind::Ident { name, def_id })
    }

    fn lower_qualified_ident(&mut self, qid: &ast::QualifiedIdentExpr) -> HirExpr {
        let path: Vec<_> = qid.path.parts.iter().map(|n| n.text.clone()).collect();

        // Try to resolve the qualified name
        let def_id = self.symbols.lookup_qualified(&path).unwrap_or(DefId::INVALID);

        let ty = if def_id.is_valid() {
            self.symbols.ty(def_id).cloned().unwrap_or(Ty::Unresolved)
        } else {
            Ty::Unresolved
        };

        HirExpr::new(qid.span, ty, HirExprKind::QualifiedIdent { path, def_id })
    }

    fn lower_binary_expr(&mut self, b: &ast::BinaryExpr) -> HirExpr {
        let lhs = self.lower_expr(&b.lhs);
        let rhs = self.lower_expr(&b.rhs);
        let op = self.lower_binary_op(b.op);

        // Infer result type based on operator and operand types
        let ty = self.infer_binary_type(&lhs.ty, &rhs.ty, op);

        HirExpr::new(b.span, ty, HirExprKind::Binary {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        })
    }

    fn lower_unary_expr(&mut self, u: &ast::UnaryExpr) -> HirExpr {
        let operand = self.lower_expr(&u.operand);
        let op = self.lower_unary_op(u.op);

        // Infer result type based on operator
        let ty = self.infer_unary_type(&operand.ty, op);

        HirExpr::new(u.span, ty, HirExprKind::Unary {
            op,
            operand: Box::new(operand),
        })
    }

    fn lower_ternary_expr(&mut self, t: &ast::TernaryExpr) -> HirExpr {
        let condition = self.lower_expr(&t.condition);
        let then_expr = self.lower_expr(&t.then_expr);
        let else_expr = self.lower_expr(&t.else_expr);

        // Result type is the common supertype of then/else
        let ty = self.common_supertype(&then_expr.ty, &else_expr.ty);

        HirExpr::new(t.span, ty, HirExprKind::Ternary {
            condition: Box::new(condition),
            then_expr: Box::new(then_expr),
            else_expr: Box::new(else_expr),
        })
    }

    fn lower_call_expr(&mut self, c: &ast::CallExpr) -> HirExpr {
        // Special handling for decltype(expr) - it's a type expression, not a function call.
        // In expression context, decltype(expr) evaluates to the type of the expression,
        // wrapped in Ty::Type for metatype operations like type equality.
        if let ast::Expr::Ident(ident) = c.callee.as_ref() {
            if ident.name.text == "decltype" && c.args.len() == 1 {
                // Evaluate decltype(arg) to get the type of the argument
                let arg_expr = self.lower_expr(&c.args[0]);
                let arg_ty = arg_expr.ty.clone();
                // Return a type expression with the resolved type
                return HirExpr::new(c.span, Ty::Type(Box::new(arg_ty.clone())), HirExprKind::TypeExpr(arg_ty));
            }
        }

        let callee = self.lower_expr(&c.callee);
        let args: Vec<_> = c.args.iter().map(|a| self.lower_expr(a)).collect();
        let attrs = self.lower_attrs(&c.attrs);

        // Get return type from callee
        let ty = callee.ty.return_type().cloned().unwrap_or(Ty::Unresolved);

        HirExpr::new(c.span, ty, HirExprKind::Call {
            callee: Box::new(callee),
            args,
            attrs,
        })
    }

    fn lower_member_expr(&mut self, m: &ast::MemberExpr) -> HirExpr {
        let object = self.lower_expr(&m.object);
        let member = m.member.text.clone();

        // Try to resolve member type from object type
        let ty = self.resolve_member_type(&object.ty, &member);

        HirExpr::new(m.span, ty, HirExprKind::Member {
            object: Box::new(object),
            member,
            member_def_id: None, // TODO: Resolve member DefId
        })
    }

    fn lower_subscript_expr(&mut self, s: &ast::SubscriptExpr) -> HirExpr {
        let array = self.lower_expr(&s.array);
        let index = self.lower_expr(&s.index);

        let ty = array.ty.element().cloned().unwrap_or(Ty::Unresolved);

        HirExpr::new(s.span, ty, HirExprKind::Subscript {
            array: Box::new(array),
            index: Box::new(index),
        })
    }

    fn lower_cast_expr(&mut self, c: &ast::CastExpr) -> HirExpr {
        let ty = self.lower_type(&c.ty);
        let expr = self.lower_expr(&c.expr);

        HirExpr::new(c.span, ty.clone(), HirExprKind::Cast {
            ty,
            expr: Box::new(expr),
        })
    }

    fn lower_mux_expr(&mut self, m: &ast::MuxExpr) -> HirExpr {
        let selector = self.lower_expr(&m.selector);
        let args: Vec<_> = m.args.iter().map(|a| self.lower_expr(a)).collect();

        // Result type is the common supertype of all args
        let ty = args.iter().fold(Ty::Unresolved, |acc, arg| {
            self.common_supertype(&acc, &arg.ty)
        });

        HirExpr::new(m.span, ty, HirExprKind::Mux {
            selector: Box::new(selector),
            args,
        })
    }

    fn lower_concat_expr(&mut self, c: &ast::ConcatExpr) -> HirExpr {
        let args: Vec<_> = c.args.iter().map(|a| self.lower_expr(a)).collect();

        // Result type is unsigned with sum of widths
        let total_width: u32 = args.iter().filter_map(|a| a.ty.width()).sum();
        let ty = if total_width > 0 {
            Ty::Unsigned(total_width)
        } else {
            Ty::Unresolved
        };

        HirExpr::new(c.span, ty, HirExprKind::Concat(args))
    }

    fn lower_fanout_expr(&mut self, f: &ast::FanOutExpr) -> HirExpr {
        let count = self.lower_expr(&f.count);
        let value = self.lower_expr(&f.value);

        HirExpr::new(f.span, Ty::Unresolved, HirExprKind::FanOut {
            count: Box::new(count),
            value: Box::new(value),
        })
    }

    fn lower_initializer_list(&mut self, i: &ast::InitializerList) -> HirExpr {
        let elements: Vec<_> = i.elements.iter().map(|e| self.lower_expr(e)).collect();
        let elem_types: Vec<_> = elements.iter().map(|e| e.ty.clone()).collect();
        let ty = Ty::Initializer(elem_types);

        HirExpr::new(i.span, ty, HirExprKind::InitializerList(elements))
    }

    fn lower_designated_init(&mut self, d: &ast::DesignatedInitializer) -> HirExpr {
        let fields: Vec<_> = d
            .fields
            .iter()
            .map(|(name, expr)| (name.text.clone(), self.lower_expr(expr)))
            .collect();

        HirExpr::new(d.span, Ty::Unresolved, HirExprKind::DesignatedInitializer(fields))
    }

    fn lower_lambda(&mut self, l: &ast::LambdaExpr) -> HirExpr {
        self.symbols.push_scope(ScopeKind::Function);

        let captures: Vec<_> = l
            .captures
            .iter()
            .map(|c| {
                let def_id = self.symbols.define(&c.name.text, DefKind::Capture, Ty::Unresolved, c.span);
                let captured_def_id = self.symbols.lookup(&c.name.text).unwrap_or(DefId::INVALID);
                HirCapture {
                    span: c.span,
                    def_id,
                    name: c.name.text.clone(),
                    captured_def_id,
                }
            })
            .collect();

        let params: Vec<_> = l
            .params
            .iter()
            .filter_map(|p| self.lower_param(p).ok())
            .collect();

        let return_ty = l.return_type.as_ref().map(|t| self.lower_type(t));
        let body = self.lower_block(&l.body);

        let def_id = DefId::INVALID; // Lambda doesn't have a named definition

        self.symbols.pop_scope();

        HirExpr::new(l.span, Ty::Unresolved, HirExprKind::Lambda(Box::new(HirLambda {
            span: l.span,
            def_id,
            captures,
            params,
            return_ty,
            body,
        })))
    }

    fn lower_sizeof(&mut self, s: &ast::SizeofExpr) -> HirExpr {
        let operand = self.lower_expr(&s.operand);
        let kind = match s.kind {
            ast::SizeofKind::Bits => HirSizeofKind::Bits,
            ast::SizeofKind::Bytes => HirSizeofKind::Bytes,
            ast::SizeofKind::Clog2 => HirSizeofKind::Clog2,
        };

        HirExpr::new(s.span, Ty::Unresolved, HirExprKind::Sizeof {
            kind,
            operand: Box::new(operand),
        })
    }

    fn lower_offsetof(&mut self, o: &ast::OffsetofExpr) -> HirExpr {
        let ty = self.lower_type(&o.ty);
        let kind = match o.kind {
            ast::OffsetofKind::Bits => HirOffsetofKind::Bits,
            ast::OffsetofKind::Bytes => HirOffsetofKind::Bytes,
        };

        HirExpr::new(o.span, Ty::Unresolved, HirExprKind::Offsetof {
            kind,
            ty,
            field: o.field.text.clone(),
        })
    }

    fn lower_interpolated_string(&mut self, s: &ast::InterpolatedString) -> HirExpr {
        let parts: Vec<_> = s
            .parts
            .iter()
            .map(|p| match p {
                ast::StringPart::Text(t) => HirStringPart::Text(t.clone()),
                ast::StringPart::Interpolation { expr, show_name, format } => {
                    HirStringPart::Interpolation {
                        expr: Box::new(self.lower_expr(expr)),
                        show_name: *show_name,
                        format: format.as_ref().map(|f| HirFormatSpec {
                            kind: match f.kind {
                                ast::FormatKind::Binary => HirFormatKind::Binary,
                                ast::FormatKind::Octal => HirFormatKind::Octal,
                                ast::FormatKind::Decimal => HirFormatKind::Decimal,
                                ast::FormatKind::Hex => HirFormatKind::Hex,
                                ast::FormatKind::HexUpper => HirFormatKind::HexUpper,
                            },
                            precision: f.precision,
                        }),
                    }
                }
            })
            .collect();

        HirExpr::new(s.span, Ty::String, HirExprKind::InterpolatedString(parts))
    }

    // ========================================================================
    // Types
    // ========================================================================

    fn lower_type(&mut self, ty: &ast::Type) -> Ty {
        match ty {
            ast::Type::Primitive(p) => match p.kind {
                ast::PrimitiveKind::Void => Ty::Void,
                ast::PrimitiveKind::Bool => Ty::Bool,
                ast::PrimitiveKind::String => Ty::String,
                ast::PrimitiveKind::Float32 => Ty::Float,
                ast::PrimitiveKind::Auto => Ty::Auto,
            },
            ast::Type::Integer(i) => {
                let width = match &i.width {
                    ast::IntWidth::Fixed(w) => *w,
                    ast::IntWidth::Param(_) => return Ty::Unresolved, // TODO: Handle parameterized widths
                };
                if i.signed {
                    Ty::Signed(width)
                } else {
                    Ty::Unsigned(width)
                }
            }
            ast::Type::Named(n) => {
                let path: Vec<_> = n.path.parts.iter().map(|p| p.text.clone()).collect();

                // Try to resolve the type name in local symbol table
                if let Some(def_id) = self.symbols.lookup_qualified(&path) {
                    if let Some(entry) = self.symbols.get(def_id) {
                        if let Ty::Type(inner) = &entry.ty {
                            return (**inner).clone();
                        }
                    }
                }

                // Try simple lookup in local symbol table
                if let Some(last) = path.last() {
                    if let Some(def_id) = self.symbols.lookup(last) {
                        if let Some(entry) = self.symbols.get(def_id) {
                            if let Ty::Type(inner) = &entry.ty {
                                return (**inner).clone();
                            }
                        }
                    }
                }

                // Try global registry if available
                // We use lookup_*_as_reference to get a Ty::Reference that the backend
                // can resolve via DeferredType, rather than the full struct/enum type
                // which can cause issues with ParseArrayType.
                if let Some(registry) = &self.global_registry {
                    // First try by path
                    if let Some(ty) = registry.lookup_path_as_reference(&path) {
                        return ty;
                    }
                    // Then try by simple name if path has one element
                    if path.len() == 1 {
                        if let Some(ty) = registry.lookup_as_reference(&path[0]) {
                            return ty;
                        }
                    }
                }

                // Type not found in local symbol table or global registry.
                // Preserve the path as a Reference type so codegen
                // can emit a named type reference that the backend will resolve.
                //
                // The backend's TypeCheck pass has access to all types from all files,
                // so it can resolve these deferred type references.
                if !path.is_empty() {
                    // Build qualified name with module namespace if available
                    let qualified_path = if path.len() == 1 {
                        // Simple name like "MemoryConfiguration" - could be from imported module
                        // Just use the name as-is; the backend will resolve it
                        path
                    } else {
                        // Already qualified like "device::MemoryConfiguration"
                        path
                    };
                    Ty::Reference(qualified_path)
                } else {
                    Ty::Unresolved
                }
            }
            ast::Type::Array(a) => {
                let element = self.lower_type(&a.element);
                let dims: Vec<_> = a
                    .dims
                    .iter()
                    .filter_map(|d| self.eval_const_expr(d))
                    .collect();
                let attrs = self.lower_attrs(&a.attrs);

                Ty::Array {
                    attrs,
                    element: Box::new(element),
                    dims,
                }
            }
            ast::Type::Function(f) => {
                let return_ty = self.lower_type(&f.return_type);
                let params: Vec<_> = f
                    .params
                    .iter()
                    .map(|p| TyFuncParam {
                        attrs: Vec::new(),
                        ty: self.lower_type(&p.ty),
                        name: p.name.as_ref().map(|n| n.text.clone()),
                    })
                    .collect();
                let attrs = self.lower_attrs(&f.attrs);

                Ty::Function {
                    kind: FunctionKind::Free,
                    attrs,
                    return_ty: Box::new(return_ty),
                    params,
                }
            }
            ast::Type::Const(c) => Ty::Const(Box::new(self.lower_type(&c.inner))),
            ast::Type::Typename(_) => {
                // Typename is for dependent types - just mark as unresolved
                Ty::Unresolved
            }
            ast::Type::Decltype(d) => {
                // Decltype resolves to the type of its expression.
                // This matches the Haskell frontend behavior where:
                // infer (DecltypeF _ a) = TType $ typeOf a
                let expr = self.lower_expr(&d.expr);
                expr.ty.clone()
            }
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    fn lower_attrs(&self, attrs: &[ast::Attribute]) -> Vec<TyAttr> {
        attrs
            .iter()
            .filter_map(|a| self.lower_attr(a))
            .collect()
    }

    fn lower_attr(&self, attr: &ast::Attribute) -> Option<TyAttr> {
        match &attr.kind {
            ast::AttributeKind::Flag(flag) => {
                let ty_flag = match flag {
                    ast::AttributeFlag::Async => TyAttrFlag::Async,
                    ast::AttributeFlag::Atomic => TyAttrFlag::Atomic,
                    ast::AttributeFlag::Initialize => TyAttrFlag::Initialize,
                    ast::AttributeFlag::Memory => TyAttrFlag::Memory,
                    ast::AttributeFlag::NoBackPressure => TyAttrFlag::NoBackPressure,
                    ast::AttributeFlag::NonReplicated => TyAttrFlag::NonReplicated,
                    ast::AttributeFlag::Pipelined => TyAttrFlag::Pipelined,
                    ast::AttributeFlag::Pure => TyAttrFlag::Pure,
                    ast::AttributeFlag::QuadPort => TyAttrFlag::QuadPort,
                    ast::AttributeFlag::ReorderByLooping => TyAttrFlag::ReorderByLooping,
                    ast::AttributeFlag::Reset => TyAttrFlag::Reset,
                    ast::AttributeFlag::Unordered => TyAttrFlag::Unordered,
                };
                Some(TyAttr::Flag(ty_flag))
            }
            ast::AttributeKind::WithArg { name, arg } => {
                let ty_name = match name {
                    ast::AttributeName::CallRate => TyAttrName::CallRate,
                    ast::AttributeName::FifoDepth => TyAttrName::FifoDepth,
                    ast::AttributeName::Latency => TyAttrName::Latency,
                    ast::AttributeName::MaxThreads => TyAttrName::MaxThreads,
                    ast::AttributeName::Name => TyAttrName::Rename,
                    ast::AttributeName::Schedule => TyAttrName::Schedule,
                    ast::AttributeName::ThreadRate => TyAttrName::ThreadRate,
                    ast::AttributeName::TransactionSize => TyAttrName::TransactionSize,
                };
                let value = self.eval_const_expr(arg)?;
                Some(TyAttr::Int { name: ty_name, value })
            }
        }
    }

    fn lower_binary_op(&self, op: ast::BinaryOp) -> HirBinaryOp {
        match op {
            ast::BinaryOp::Add => HirBinaryOp::Add,
            ast::BinaryOp::Sub => HirBinaryOp::Sub,
            ast::BinaryOp::Mul => HirBinaryOp::Mul,
            ast::BinaryOp::Div => HirBinaryOp::Div,
            ast::BinaryOp::Mod => HirBinaryOp::Mod,
            ast::BinaryOp::BitwiseAnd => HirBinaryOp::BitwiseAnd,
            ast::BinaryOp::BitwiseOr => HirBinaryOp::BitwiseOr,
            ast::BinaryOp::BitwiseXor => HirBinaryOp::BitwiseXor,
            ast::BinaryOp::LogicalAnd => HirBinaryOp::LogicalAnd,
            ast::BinaryOp::LogicalOr => HirBinaryOp::LogicalOr,
            ast::BinaryOp::LogicalXor => HirBinaryOp::LogicalXor,
            ast::BinaryOp::Shl => HirBinaryOp::Shl,
            ast::BinaryOp::Shr => HirBinaryOp::Shr,
            ast::BinaryOp::Eq => HirBinaryOp::Eq,
            ast::BinaryOp::Ne => HirBinaryOp::Ne,
            ast::BinaryOp::Lt => HirBinaryOp::Lt,
            ast::BinaryOp::Le => HirBinaryOp::Le,
            ast::BinaryOp::Gt => HirBinaryOp::Gt,
            ast::BinaryOp::Ge => HirBinaryOp::Ge,
        }
    }

    fn lower_unary_op(&self, op: ast::UnaryOp) -> HirUnaryOp {
        match op {
            ast::UnaryOp::Neg => HirUnaryOp::Neg,
            ast::UnaryOp::Not => HirUnaryOp::Not,
            ast::UnaryOp::Invert => HirUnaryOp::Invert,
            ast::UnaryOp::PostInc => HirUnaryOp::PostInc,
            ast::UnaryOp::PostDec => HirUnaryOp::PostDec,
            ast::UnaryOp::PreInc => HirUnaryOp::PreInc,
            ast::UnaryOp::PreDec => HirUnaryOp::PreDec,
        }
    }

    fn qualified_name(&self, name: &str) -> Vec<String> {
        if let Some(ns) = &self.module_namespace {
            vec![ns.clone(), name.to_string()]
        } else {
            vec![name.to_string()]
        }
    }

    fn eval_const_expr(&self, expr: &ast::Expr) -> Option<i64> {
        match expr {
            ast::Expr::IntLiteral(lit) => Some(lit.value as i64),
            _ => None, // TODO: Implement constant expression evaluation
        }
    }

    fn infer_int_literal_type(&self, value: i128, suffix: Option<ast::IntSuffix>) -> Ty {
        if let Some(s) = suffix {
            if s.signed {
                Ty::Signed(s.width as u32)
            } else {
                Ty::Unsigned(s.width as u32)
            }
        } else {
            // Infer minimal type
            if value == 0 {
                Ty::Unsigned(1)
            } else if value < 0 {
                let abs_val = value.unsigned_abs();
                let bits = 128 - abs_val.leading_zeros();
                Ty::Signed(bits + 1)
            } else {
                let bits = 128 - (value as u128).leading_zeros();
                Ty::Unsigned(bits)
            }
        }
    }

    fn infer_binary_type(&self, lhs: &Ty, rhs: &Ty, op: HirBinaryOp) -> Ty {
        match op {
            // Comparison operators always return bool
            HirBinaryOp::Eq | HirBinaryOp::Ne | HirBinaryOp::Lt |
            HirBinaryOp::Le | HirBinaryOp::Gt | HirBinaryOp::Ge => Ty::Bool,

            // Logical operators return bool
            HirBinaryOp::LogicalAnd | HirBinaryOp::LogicalOr | HirBinaryOp::LogicalXor => Ty::Bool,

            // Arithmetic operators - return common supertype
            HirBinaryOp::Add | HirBinaryOp::Sub | HirBinaryOp::Mul |
            HirBinaryOp::Div | HirBinaryOp::Mod |
            HirBinaryOp::BitwiseAnd | HirBinaryOp::BitwiseOr | HirBinaryOp::BitwiseXor |
            HirBinaryOp::Shl | HirBinaryOp::Shr => self.common_supertype(lhs, rhs),
        }
    }

    fn infer_unary_type(&self, operand: &Ty, op: HirUnaryOp) -> Ty {
        match op {
            HirUnaryOp::Not => Ty::Bool,
            HirUnaryOp::Neg => {
                // Negation widens by 1 bit and makes signed
                match operand {
                    Ty::Signed(w) => Ty::Signed(w + 1),
                    Ty::Unsigned(w) => Ty::Signed(w + 1),
                    _ => Ty::Unresolved,
                }
            }
            HirUnaryOp::Invert => operand.clone(),
            HirUnaryOp::PostInc | HirUnaryOp::PostDec |
            HirUnaryOp::PreInc | HirUnaryOp::PreDec => operand.clone(),
        }
    }

    fn common_supertype(&self, a: &Ty, b: &Ty) -> Ty {
        if a == b {
            return a.clone();
        }

        match (a, b) {
            (Ty::Unresolved, _) | (_, Ty::Unresolved) => Ty::Unresolved,
            (Ty::Signed(w1), Ty::Signed(w2)) => Ty::Signed((*w1).max(*w2)),
            (Ty::Unsigned(w1), Ty::Unsigned(w2)) => Ty::Unsigned((*w1).max(*w2)),
            (Ty::Signed(w1), Ty::Unsigned(w2)) => Ty::Signed((*w1).max(*w2 + 1)),
            (Ty::Unsigned(w1), Ty::Signed(w2)) => Ty::Signed((*w1 + 1).max(*w2)),
            _ => Ty::Unresolved,
        }
    }

    fn resolve_member_type(&self, object_ty: &Ty, member: &str) -> Ty {
        match object_ty {
            Ty::Struct { fields, .. } | Ty::Class { fields, .. } | Ty::Union { fields, .. } => {
                fields
                    .iter()
                    .find(|(n, _)| n == member)
                    .map(|(_, t)| t.clone())
                    .unwrap_or(Ty::Unresolved)
            }
            Ty::Const(inner) | Ty::Instance { template: inner, .. } => {
                self.resolve_member_type(inner, member)
            }
            _ => Ty::Unresolved,
        }
    }
}
