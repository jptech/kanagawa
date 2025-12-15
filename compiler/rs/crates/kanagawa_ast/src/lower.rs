//! CST to AST lowering.
//!
//! This module converts the lossless CST from `kanagawa_syntax` into a typed AST.
//! The lowering is intentionally permissive and recovers from partial/malformed
//! CST nodes to produce a best-effort AST.

use crate::span::Span;
use crate::types::*;
use kanagawa_syntax::{SyntaxKind, SyntaxNode, SyntaxToken};
use thiserror::Error;

/// Errors that can occur during CST→AST lowering.
#[derive(Debug, Error)]
pub enum LowerError {
    #[error("expected {expected} but found {found:?}")]
    UnexpectedNode {
        expected: &'static str,
        found: SyntaxKind,
    },
    #[error("missing required child node: {0}")]
    MissingChild(&'static str),
    #[error("invalid syntax: {0}")]
    InvalidSyntax(String),
}

type Result<T> = std::result::Result<T, LowerError>;

/// Lower a parsed CST file into an AST [`File`].
pub fn lower_file(root: &SyntaxNode) -> Result<File> {
    Lowerer::new().lower_file(root)
}

/// The lowering context.
struct Lowerer {
    /// Current file index for spans.
    file_index: u32,
}

impl Lowerer {
    fn new() -> Self {
        Self { file_index: 0 }
    }

    /// Create a span from a syntax node.
    fn span(&self, node: &SyntaxNode) -> Span {
        let range = node.text_range();
        Span {
            start: range.start().into(),
            end: range.end().into(),
            file_index: self.file_index,
        }
    }

    /// Create a span from a syntax token.
    fn token_span(&self, token: &SyntaxToken) -> Span {
        let range = token.text_range();
        Span {
            start: range.start().into(),
            end: range.end().into(),
            file_index: self.file_index,
        }
    }

    /// Lower a file node.
    fn lower_file(&mut self, root: &SyntaxNode) -> Result<File> {
        if root.kind() != SyntaxKind::File {
            return Err(LowerError::UnexpectedNode {
                expected: "File",
                found: root.kind(),
            });
        }

        let span = self.span(root);
        let mut module = None;
        let mut imports = Vec::new();
        let mut decls = Vec::new();

        for child in root.children() {
            match child.kind() {
                SyntaxKind::ModuleDecl => {
                    module = Some(self.lower_module_decl(&child)?);
                }
                SyntaxKind::ImportDecl => {
                    imports.push(self.lower_import_decl(&child)?);
                }
                // Top-level declarations
                kind if self.is_decl_kind(kind) => {
                    if let Some(decl) = self.lower_decl(&child)? {
                        decls.push(decl);
                    }
                }
                // Skip unknown nodes for now (permissive lowering)
                _ => {}
            }
        }

        Ok(File {
            span,
            module,
            imports,
            decls,
        })
    }

    fn is_decl_kind(&self, kind: SyntaxKind) -> bool {
        matches!(
            kind,
            SyntaxKind::FunctionDef
                | SyntaxKind::FunctionDecl
                | SyntaxKind::GlobalVarDecl
                | SyntaxKind::StaticVarDecl
                | SyntaxKind::StructDecl
                | SyntaxKind::EnumDecl
                | SyntaxKind::ClassDecl
                | SyntaxKind::UnionDecl
                | SyntaxKind::UsingDecl
                | SyntaxKind::TemplateDecl
                | SyntaxKind::StaticIfDecl
                | SyntaxKind::StaticAssertDecl
                | SyntaxKind::ExternDecl
                | SyntaxKind::ExportDecl
        )
    }

    fn is_expr_kind(&self, kind: SyntaxKind) -> bool {
        matches!(
            kind,
            SyntaxKind::Expr
                | SyntaxKind::LiteralExpr
                | SyntaxKind::IdentExpr
                | SyntaxKind::QualifiedIdentExpr
                | SyntaxKind::BinaryExpr
                | SyntaxKind::UnaryExpr
                | SyntaxKind::TernaryExpr
                | SyntaxKind::AssignExpr
                | SyntaxKind::CallExpr
                | SyntaxKind::MemberExpr
                | SyntaxKind::SubscriptExpr
                | SyntaxKind::CastExpr
                | SyntaxKind::ParenExpr
                | SyntaxKind::InitializerListExpr
                | SyntaxKind::DesignatedInitializerListExpr
                | SyntaxKind::StringLiteralExpr
                | SyntaxKind::InterpolatedStringExpr
                | SyntaxKind::LambdaExpr
        )
    }

    // ========================================================================
    // Module / Import
    // ========================================================================

    fn lower_module_decl(&mut self, node: &SyntaxNode) -> Result<ModuleDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut exports = Vec::new();

        for child in node.children() {
            match child.kind() {
                SyntaxKind::ModuleName => {
                    name = Some(self.lower_module_name(&child)?);
                }
                SyntaxKind::ModuleExports => {
                    for export_child in child.children() {
                        if export_child.kind() == SyntaxKind::ExportItem {
                            if let Some(export) = self.lower_module_export(&export_child) {
                                exports.push(export);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let name = name.ok_or(LowerError::MissingChild("module name"))?;
        Ok(ModuleDecl {
            span,
            name,
            exports,
        })
    }

    fn lower_module_name(&mut self, node: &SyntaxNode) -> Result<ModuleName> {
        let span = self.span(node);
        let mut segments = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::ModuleNameSegment {
                // Get the text content of the segment
                let text = child.text().to_string();
                let child_span = self.span(&child);
                segments.push(Name::new(child_span, text));
            }
        }

        // Also check for direct ident tokens (for simple module names)
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                segments.push(Name::new(self.token_span(&token), token.text().to_string()));
            }
        }

        Ok(ModuleName { span, segments })
    }

    fn lower_module_export(&mut self, node: &SyntaxNode) -> Option<ModuleExport> {
        // Look for ident, module reference, or module diff
        for child in node.children() {
            match child.kind() {
                SyntaxKind::ModuleReference => {
                    // Re-export of a module
                    for mc in child.children() {
                        if mc.kind() == SyntaxKind::ModuleName {
                            if let Ok(name) = self.lower_module_name(&mc) {
                                return Some(ModuleExport::Module(name));
                            }
                        }
                    }
                }
                SyntaxKind::ModuleDiff => {
                    // Module difference
                    let names: Vec<_> = child
                        .children()
                        .filter(|c| c.kind() == SyntaxKind::ModuleName)
                        .collect();
                    if names.len() >= 2 {
                        if let (Ok(include), Ok(exclude)) =
                            (self.lower_module_name(&names[0]), self.lower_module_name(&names[1]))
                        {
                            return Some(ModuleExport::ModuleDiff { include, exclude });
                        }
                    }
                }
                _ => {}
            }
        }

        // Simple identifier export
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                return Some(ModuleExport::Ident(Name::new(
                    self.token_span(&token),
                    token.text().to_string(),
                )));
            }
        }

        None
    }

    fn lower_import_decl(&mut self, node: &SyntaxNode) -> Result<ImportDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut alias = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::ModuleName {
                name = Some(self.lower_module_name(&child)?);
            }
        }

        // Look for alias (identifier after 'as')
        let mut saw_as = false;
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::KwAs {
                saw_as = true;
            } else if saw_as && token.kind() == SyntaxKind::Ident {
                alias = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        let name = name.ok_or(LowerError::MissingChild("import module name"))?;
        Ok(ImportDecl { span, name, alias })
    }

    // ========================================================================
    // Declarations
    // ========================================================================

    fn lower_decl(&mut self, node: &SyntaxNode) -> Result<Option<Decl>> {
        match node.kind() {
            SyntaxKind::FunctionDef => Ok(Some(Decl::Function(self.lower_function_def(node)?))),
            SyntaxKind::FunctionDecl => Ok(Some(Decl::Function(self.lower_function_decl(node)?))),
            SyntaxKind::GlobalVarDecl | SyntaxKind::StaticVarDecl => {
                Ok(Some(Decl::Variable(self.lower_variable_decl(node)?)))
            }
            SyntaxKind::StructDecl => Ok(Some(Decl::Struct(self.lower_struct_decl(node)?))),
            SyntaxKind::EnumDecl => Ok(Some(Decl::Enum(self.lower_enum_decl(node)?))),
            SyntaxKind::ClassDecl => Ok(Some(Decl::Class(self.lower_class_decl(node)?))),
            SyntaxKind::UnionDecl => Ok(Some(Decl::Union(self.lower_union_decl(node)?))),
            SyntaxKind::UsingDecl => Ok(Some(Decl::Using(self.lower_using_decl(node)?))),
            SyntaxKind::TemplateDecl => Ok(Some(Decl::Template(self.lower_template_decl(node)?))),
            SyntaxKind::StaticIfDecl => Ok(Some(Decl::StaticIf(self.lower_static_if_decl(node)?))),
            SyntaxKind::StaticAssertDecl => {
                Ok(Some(Decl::StaticAssert(self.lower_static_assert_decl(node)?)))
            }
            SyntaxKind::ExternDecl => Ok(Some(Decl::Extern(self.lower_extern_decl(node)?))),
            SyntaxKind::ExportDecl => Ok(Some(Decl::Export(self.lower_export_decl(node)?))),
            _ => Ok(None),
        }
    }

    fn lower_function_def(&mut self, node: &SyntaxNode) -> Result<FunctionDecl> {
        let span = self.span(node);
        let mut attrs = Vec::new();
        let mut modifier = None;
        let mut return_type = None;
        let mut name = None;
        let mut params = Vec::new();
        let mut body = None;

        // First pass: collect attrs
        for child in node.children() {
            if child.kind() == SyntaxKind::Attrs {
                attrs.extend(self.lower_attrs(&child)?);
            }
        }

        // Look for modifier keywords
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            match token.kind() {
                SyntaxKind::KwInline => modifier = Some(FunctionModifier::Inline),
                SyntaxKind::KwNoinline => modifier = Some(FunctionModifier::NoInline),
                _ => {}
            }
        }

        // Look for type and name
        for child in node.children() {
            match child.kind() {
                SyntaxKind::Type => {
                    return_type = Some(self.lower_type(&child)?);
                }
                SyntaxKind::FuncParams => {
                    params = self.lower_func_params(&child)?;
                }
                SyntaxKind::Block => {
                    body = Some(self.lower_block(&child)?);
                }
                _ => {}
            }
        }

        // Find function name (ident token after type, before params)
        let mut saw_type = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Node(n) if n.kind() == SyntaxKind::Type => {
                    saw_type = true;
                }
                rowan::NodeOrToken::Token(t) if saw_type && t.kind() == SyntaxKind::Ident => {
                    name = Some(Name::new(self.token_span(&t), t.text().to_string()));
                    break;
                }
                rowan::NodeOrToken::Node(n) if n.kind() == SyntaxKind::FuncParams => {
                    break;
                }
                _ => {}
            }
        }

        // If no explicit type node, try to infer from tokens
        let return_type = return_type.unwrap_or_else(|| self.make_auto_type(span));
        let name = name.ok_or(LowerError::MissingChild("function name"))?;

        Ok(FunctionDecl {
            span,
            attrs,
            modifier,
            return_type,
            name,
            params,
            body,
        })
    }

    fn lower_function_decl(&mut self, node: &SyntaxNode) -> Result<FunctionDecl> {
        // Same as lower_function_def but body will be None
        let mut decl = self.lower_function_def(node)?;
        decl.body = None;
        Ok(decl)
    }

    fn lower_func_params(&mut self, node: &SyntaxNode) -> Result<Vec<FunctionParam>> {
        let mut params = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::TypeFunctionParam {
                params.push(self.lower_func_param(&child)?);
            }
        }

        Ok(params)
    }

    fn lower_func_param(&mut self, node: &SyntaxNode) -> Result<FunctionParam> {
        let span = self.span(node);
        let mut ty = None;
        let mut name = None;
        let mut default = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Type => ty = Some(self.lower_type(&child)?),
                SyntaxKind::Expr => {
                    // This is the default value expression (comes after '=')
                    default = Some(self.lower_expr(&child)?);
                }
                _ => {}
            }
        }

        // Find param name (ident after type but before '=')
        let mut saw_type = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Node(n) if n.kind() == SyntaxKind::Type => saw_type = true,
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::Eq => break, // Stop at '='
                rowan::NodeOrToken::Token(t) if saw_type && t.kind() == SyntaxKind::Ident => {
                    name = Some(Name::new(self.token_span(&t), t.text().to_string()));
                }
                _ => {}
            }
        }

        let ty = ty.unwrap_or_else(|| self.make_auto_type(span));
        let name = name.unwrap_or_else(|| Name::new(span, "_"));

        Ok(FunctionParam {
            span,
            ty,
            name,
            default,
        })
    }

    fn lower_variable_decl(&mut self, node: &SyntaxNode) -> Result<VariableDecl> {
        let span = self.span(node);
        let mut ty = None;
        let mut name = None;
        let mut init = None;
        let mut flags = DeclFlags::default();

        // Check for static/const
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            match token.kind() {
                SyntaxKind::KwStatic => flags.is_static = true,
                SyntaxKind::KwConst => flags.is_const = true,
                _ => {}
            }
        }

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Type => ty = Some(self.lower_type(&child)?),
                SyntaxKind::Expr => init = Some(self.lower_expr(&child)?),
                SyntaxKind::InitializerListExpr => {
                    init = Some(Expr::InitializerList(self.lower_initializer_list(&child)?))
                }
                SyntaxKind::DesignatedInitializerListExpr => {
                    init = Some(Expr::DesignatedInitializer(
                        self.lower_designated_initializer(&child)?,
                    ))
                }
                _ => {}
            }
        }

        // Find variable name
        let mut saw_type = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Node(n) if n.kind() == SyntaxKind::Type => saw_type = true,
                rowan::NodeOrToken::Token(t) if saw_type && t.kind() == SyntaxKind::Ident => {
                    name = Some(Name::new(self.token_span(&t), t.text().to_string()));
                    break;
                }
                _ => {}
            }
        }

        let ty = ty.unwrap_or_else(|| self.make_auto_type(span));
        let name = name.unwrap_or_else(|| Name::new(span, "_"));

        Ok(VariableDecl {
            span,
            ty,
            name,
            init,
            flags,
        })
    }

    fn lower_struct_decl(&mut self, node: &SyntaxNode) -> Result<StructDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut members = Vec::new();

        // Find name
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        // Find body
        for child in node.children() {
            if child.kind() == SyntaxKind::StructBody {
                for member in child.children() {
                    if member.kind() == SyntaxKind::StructMemberDecl {
                        members.push(self.lower_struct_member(&member)?);
                    }
                }
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        Ok(StructDecl {
            span,
            name,
            members,
        })
    }

    fn lower_struct_member(&mut self, node: &SyntaxNode) -> Result<StructMember> {
        let span = self.span(node);
        let mut ty = None;
        let mut name = None;
        let mut init = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Type => ty = Some(self.lower_type(&child)?),
                SyntaxKind::Expr => init = Some(self.lower_expr(&child)?),
                _ => {}
            }
        }

        // Find member name
        let mut saw_type = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Node(n) if n.kind() == SyntaxKind::Type => saw_type = true,
                rowan::NodeOrToken::Token(t) if saw_type && t.kind() == SyntaxKind::Ident => {
                    name = Some(Name::new(self.token_span(&t), t.text().to_string()));
                    break;
                }
                _ => {}
            }
        }

        let ty = ty.unwrap_or_else(|| self.make_auto_type(span));
        let name = name.unwrap_or_else(|| Name::new(span, "_"));

        Ok(StructMember {
            span,
            ty,
            name,
            init,
        })
    }

    fn lower_enum_decl(&mut self, node: &SyntaxNode) -> Result<EnumDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut base_type = None;
        let mut variants = Vec::new();

        // Find name
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Type => base_type = Some(self.lower_type(&child)?),
                SyntaxKind::EnumBody => {
                    for variant in child.children() {
                        if variant.kind() == SyntaxKind::EnumVariant {
                            variants.push(self.lower_enum_variant(&variant)?);
                        }
                    }
                }
                _ => {}
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        let base_type = base_type.unwrap_or_else(|| self.make_auto_type(span));

        Ok(EnumDecl {
            span,
            name,
            base_type,
            variants,
        })
    }

    fn lower_enum_variant(&mut self, node: &SyntaxNode) -> Result<EnumVariant> {
        let span = self.span(node);
        let mut name = None;
        let mut value = None;

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident && name.is_none() {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
            }
        }

        for child in node.children() {
            if child.kind() == SyntaxKind::Expr {
                value = Some(self.lower_expr(&child)?);
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        Ok(EnumVariant { span, name, value })
    }

    fn lower_class_decl(&mut self, node: &SyntaxNode) -> Result<ClassDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut members = Vec::new();

        // Find name
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        for child in node.children() {
            if child.kind() == SyntaxKind::ClassBody {
                for member in child.children() {
                    if let Some(m) = self.lower_class_member(&member)? {
                        members.push(m);
                    }
                }
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        Ok(ClassDecl {
            span,
            name,
            members,
        })
    }

    fn lower_class_member(&mut self, node: &SyntaxNode) -> Result<Option<ClassMember>> {
        match node.kind() {
            SyntaxKind::AccessSpecifier => {
                for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
                    match token.kind() {
                        SyntaxKind::KwPublic => return Ok(Some(ClassMember::Access(AccessSpecifier::Public))),
                        SyntaxKind::KwPrivate => return Ok(Some(ClassMember::Access(AccessSpecifier::Private))),
                        _ => {}
                    }
                }
                Ok(None)
            }
            SyntaxKind::ClassVarDecl => {
                Ok(Some(ClassMember::Variable(self.lower_variable_decl(node)?)))
            }
            SyntaxKind::FunctionDef => {
                Ok(Some(ClassMember::Function(self.lower_function_def(node)?)))
            }
            SyntaxKind::FunctionDecl => {
                Ok(Some(ClassMember::Function(self.lower_function_decl(node)?)))
            }
            SyntaxKind::DefaultInitDecl => {
                for child in node.children() {
                    if child.kind() == SyntaxKind::Expr {
                        return Ok(Some(ClassMember::DefaultInit(self.lower_expr(&child)?)));
                    }
                }
                Ok(None)
            }
            _ if self.is_decl_kind(node.kind()) => {
                if let Some(decl) = self.lower_decl(node)? {
                    Ok(Some(ClassMember::NestedDecl(Box::new(decl))))
                } else {
                    Ok(None)
                }
            }
            _ => Ok(None),
        }
    }

    fn lower_union_decl(&mut self, node: &SyntaxNode) -> Result<UnionDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut members = Vec::new();

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        for child in node.children() {
            if child.kind() == SyntaxKind::UnionBody {
                for member in child.children() {
                    if member.kind() == SyntaxKind::UnionMemberDecl {
                        members.push(self.lower_struct_member(&member)?);
                    }
                }
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        Ok(UnionDecl {
            span,
            name,
            members,
        })
    }

    fn lower_using_decl(&mut self, node: &SyntaxNode) -> Result<UsingDecl> {
        let span = self.span(node);
        let mut name = None;
        let mut ty = None;

        // Name comes after 'using' keyword
        let mut saw_using = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::KwUsing => {
                    saw_using = true;
                }
                rowan::NodeOrToken::Token(t) if saw_using && t.kind() == SyntaxKind::Ident => {
                    name = Some(Name::new(self.token_span(&t), t.text().to_string()));
                }
                rowan::NodeOrToken::Node(n) if n.kind() == SyntaxKind::Type => {
                    ty = Some(self.lower_type(&n)?);
                }
                _ => {}
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        let ty = ty.unwrap_or_else(|| self.make_auto_type(span));

        Ok(UsingDecl { span, name, ty })
    }

    fn lower_template_decl(&mut self, node: &SyntaxNode) -> Result<TemplateDecl> {
        let span = self.span(node);
        let mut params = Vec::new();
        let mut decl = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::TemplateParams => {
                    params = self.lower_template_params(&child)?;
                }
                _ if self.is_decl_kind(child.kind()) => {
                    decl = self.lower_decl(&child)?;
                }
                _ => {}
            }
        }

        let decl = decl.ok_or(LowerError::MissingChild("template declaration"))?;

        Ok(TemplateDecl {
            span,
            params,
            decl: Box::new(decl),
        })
    }

    fn lower_template_params(&mut self, node: &SyntaxNode) -> Result<Vec<TemplateParam>> {
        let mut params = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::TemplateParam {
                params.push(self.lower_template_param(&child)?);
            }
        }

        Ok(params)
    }

    fn lower_template_param(&mut self, node: &SyntaxNode) -> Result<TemplateParam> {
        let span = self.span(node);

        // Check if this is a type parameter (has typename keyword)
        let mut is_type_param = false;
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::KwTypename {
                is_type_param = true;
                break;
            }
        }

        let mut ty: Option<Type> = None;
        let mut name: Option<Name> = None;
        let mut default_type: Option<Type> = None;
        let mut default_expr: Option<Expr> = None;

        // Collect Type and Expr children
        let mut saw_eq = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::Eq => {
                    saw_eq = true;
                }
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::Ident => {
                    // This could be the param name
                    if !saw_eq {
                        name = Some(Name::new(self.token_span(&t), t.text().to_string()));
                    }
                }
                rowan::NodeOrToken::Node(n) => {
                    if n.kind() == SyntaxKind::Type {
                        if saw_eq {
                            default_type = Some(self.lower_type(&n)?);
                        } else if ty.is_none() {
                            ty = Some(self.lower_type(&n)?);
                        }
                    } else if n.kind() == SyntaxKind::Expr {
                        if saw_eq {
                            default_expr = Some(self.lower_expr(&n)?);
                        }
                    }
                }
                _ => {}
            }
        }

        // For type parameters, the Type node contains the parameter name
        if is_type_param {
            // If we have a type but no separate name, extract name from type
            let param_name = if let Some(n) = name {
                n
            } else if let Some(Type::Named(named)) = &ty {
                if let Some(part) = named.path.parts.first() {
                    part.clone()
                } else {
                    Name::new(span, "_")
                }
            } else {
                Name::new(span, "_")
            };

            Ok(TemplateParam::Type {
                span,
                name: param_name,
                default: default_type,
            })
        } else {
            // Non-type parameter
            let param_ty = ty.unwrap_or_else(|| self.make_auto_type(span));
            let param_name = name.unwrap_or_else(|| Name::new(span, "_"));

            Ok(TemplateParam::NonType {
                span,
                ty: param_ty,
                name: param_name,
                default: default_expr,
            })
        }
    }

    fn lower_static_if_decl(&mut self, node: &SyntaxNode) -> Result<StaticIfDecl> {
        let span = self.span(node);
        let mut condition = None;
        let mut then_decl = None;
        let mut else_decl = None;

        // Find the condition in ParenExpr
        for child in node.children() {
            if child.kind() == SyntaxKind::ParenExpr {
                for inner in child.children() {
                    if inner.kind() == SyntaxKind::Expr {
                        condition = Some(self.lower_expr(&inner)?);
                        break;
                    }
                }
            }
        }

        // Find then/else decls
        let mut saw_else = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::KwElse => {
                    saw_else = true;
                }
                rowan::NodeOrToken::Node(n) if self.is_decl_kind(n.kind()) => {
                    if saw_else {
                        else_decl = self.lower_decl(&n)?;
                    } else if then_decl.is_none() {
                        then_decl = self.lower_decl(&n)?;
                    }
                }
                _ => {}
            }
        }

        let condition = condition.ok_or(LowerError::MissingChild("static if condition"))?;
        let then_decl = then_decl.ok_or(LowerError::MissingChild("static if then branch"))?;

        Ok(StaticIfDecl {
            span,
            condition,
            then_decl: Box::new(then_decl),
            else_decl: else_decl.map(Box::new),
        })
    }

    fn lower_static_assert_decl(&mut self, node: &SyntaxNode) -> Result<StaticAssertDecl> {
        let span = self.span(node);
        let mut condition = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::ParenExpr {
                for inner in child.children() {
                    if inner.kind() == SyntaxKind::Expr {
                        condition = Some(self.lower_expr(&inner)?);
                        break;
                    }
                }
            }
        }

        let condition = condition.ok_or(LowerError::MissingChild("static_assert condition"))?;
        Ok(StaticAssertDecl { span, condition })
    }

    fn lower_extern_decl(&mut self, node: &SyntaxNode) -> Result<ExternDecl> {
        let span = self.span(node);
        let mut attrs = Vec::new();
        let mut decl = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Attrs => attrs.extend(self.lower_attrs(&child)?),
                _ if self.is_decl_kind(child.kind()) => {
                    decl = self.lower_decl(&child)?;
                }
                _ => {}
            }
        }

        let decl = decl.ok_or(LowerError::MissingChild("extern declaration"))?;
        Ok(ExternDecl {
            span,
            attrs,
            decl: Box::new(decl),
        })
    }

    fn lower_export_decl(&mut self, node: &SyntaxNode) -> Result<ExportDecl> {
        let span = self.span(node);
        let mut attrs = Vec::new();
        let mut decl = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Attrs => attrs.extend(self.lower_attrs(&child)?),
                _ if self.is_decl_kind(child.kind()) => {
                    decl = self.lower_decl(&child)?;
                }
                _ => {}
            }
        }

        let decl = decl.ok_or(LowerError::MissingChild("export declaration"))?;
        Ok(ExportDecl {
            span,
            attrs,
            decl: Box::new(decl),
        })
    }

    // ========================================================================
    // Attributes
    // ========================================================================

    fn lower_attrs(&mut self, node: &SyntaxNode) -> Result<Vec<Attribute>> {
        let mut attrs = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::AttrBlock {
                for item in child.children() {
                    if item.kind() == SyntaxKind::AttrItem {
                        if let Some(attr) = self.lower_attr_item(&item)? {
                            attrs.push(attr);
                        }
                    }
                }
            }
        }

        Ok(attrs)
    }

    fn lower_attr_item(&mut self, node: &SyntaxNode) -> Result<Option<Attribute>> {
        let span = self.span(node);

        // Get attribute name
        let mut name_text = String::new();
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                name_text = token.text().to_string();
                break;
            }
        }

        // Match known attributes
        let kind = match name_text.as_str() {
            "async" => AttributeKind::Flag(AttributeFlag::Async),
            "atomic" => AttributeKind::Flag(AttributeFlag::Atomic),
            "initialize" => AttributeKind::Flag(AttributeFlag::Initialize),
            "memory" => AttributeKind::Flag(AttributeFlag::Memory),
            "no_backpressure" => AttributeKind::Flag(AttributeFlag::NoBackPressure),
            "non_replicated" => AttributeKind::Flag(AttributeFlag::NonReplicated),
            "pipelined" => AttributeKind::Flag(AttributeFlag::Pipelined),
            "pure" => AttributeKind::Flag(AttributeFlag::Pure),
            "quad_port" => AttributeKind::Flag(AttributeFlag::QuadPort),
            "reorder_by_looping" => AttributeKind::Flag(AttributeFlag::ReorderByLooping),
            "reset" => AttributeKind::Flag(AttributeFlag::Reset),
            "unordered" => AttributeKind::Flag(AttributeFlag::Unordered),
            // Attributes with args - we'd need to parse the arg expression
            "call_rate" | "fifo_depth" | "latency" | "max_threads" | "name" | "schedule"
            | "thread_rate" | "transaction_size" => {
                // For now, skip attributes with args until we implement arg lowering
                return Ok(None);
            }
            _ => return Ok(None),
        };

        Ok(Some(Attribute { span, kind }))
    }

    // ========================================================================
    // Statements
    // ========================================================================

    fn lower_block(&mut self, node: &SyntaxNode) -> Result<Block> {
        let span = self.span(node);
        let mut stmts = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::StmtList {
                for stmt_node in child.children() {
                    if let Some(stmt) = self.lower_stmt(&stmt_node)? {
                        stmts.push(stmt);
                    }
                }
            }
        }

        Ok(Block { span, stmts })
    }

    fn lower_stmt(&mut self, node: &SyntaxNode) -> Result<Option<Stmt>> {
        match node.kind() {
            SyntaxKind::Block => Ok(Some(Stmt::Block(self.lower_block(node)?))),
            SyntaxKind::ReturnStmt => Ok(Some(Stmt::Return(self.lower_return_stmt(node)?))),
            SyntaxKind::IfStmt => Ok(Some(Stmt::If(self.lower_if_stmt(node)?))),
            SyntaxKind::SwitchStmt => Ok(Some(Stmt::Switch(self.lower_switch_stmt(node)?))),
            SyntaxKind::DoWhileStmt => Ok(Some(Stmt::DoWhile(self.lower_do_while_stmt(node)?))),
            SyntaxKind::RangeForStmt => Ok(Some(Stmt::RangeFor(self.lower_range_for_stmt(node)?))),
            SyntaxKind::StaticForStmt => Ok(Some(Stmt::StaticFor(self.lower_static_for_stmt(node)?))),
            SyntaxKind::UnrolledForStmt => {
                Ok(Some(Stmt::UnrolledFor(self.lower_unrolled_for_stmt(node)?)))
            }
            SyntaxKind::StaticIfStmt => Ok(Some(Stmt::StaticIf(self.lower_static_if_stmt(node)?))),
            SyntaxKind::BarrierStmt => Ok(Some(Stmt::Barrier(self.span(node)))),
            SyntaxKind::BreakStmt => Ok(Some(Stmt::Break(self.span(node)))),
            SyntaxKind::ReorderStmt => Ok(Some(Stmt::Reorder(self.lower_reorder_stmt(node)?))),
            SyntaxKind::AtomicStmt => Ok(Some(Stmt::Atomic(self.lower_atomic_stmt(node)?))),
            SyntaxKind::ExprStmt => Ok(Some(Stmt::Expr(self.lower_expr_stmt(node)?))),
            SyntaxKind::IncDecStmt => Ok(Some(Stmt::Expr(self.lower_expr_stmt(node)?))),
            SyntaxKind::AssignStmt => Ok(Some(Stmt::Assign(self.lower_assign_stmt(node)?))),
            SyntaxKind::LocalVarDecl | SyntaxKind::StaticVarDecl => {
                Ok(Some(Stmt::VarDecl(self.lower_variable_decl(node)?)))
            }
            SyntaxKind::AnnotatedStmt => {
                Ok(Some(Stmt::Annotated(self.lower_annotated_stmt(node)?)))
            }
            _ => Ok(None),
        }
    }

    fn lower_return_stmt(&mut self, node: &SyntaxNode) -> Result<ReturnStmt> {
        let span = self.span(node);
        let mut value = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::Expr {
                value = Some(self.lower_expr(&child)?);
                break;
            }
        }

        Ok(ReturnStmt { span, value })
    }

    fn lower_if_stmt(&mut self, node: &SyntaxNode) -> Result<IfStmt> {
        let span = self.span(node);
        let mut condition = None;
        let mut then_branch = None;
        let mut else_branch = None;

        // Find condition in ParenExpr
        for child in node.children() {
            if child.kind() == SyntaxKind::ParenExpr {
                for inner in child.children() {
                    if inner.kind() == SyntaxKind::Expr {
                        condition = Some(self.lower_expr(&inner)?);
                        break;
                    }
                }
            }
        }

        // Find branches
        let mut saw_else = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::KwElse => {
                    saw_else = true;
                }
                rowan::NodeOrToken::Node(n) => {
                    if let Some(stmt) = self.lower_stmt(&n)? {
                        if saw_else {
                            else_branch = Some(Box::new(stmt));
                        } else if then_branch.is_none() && n.kind() != SyntaxKind::ParenExpr {
                            then_branch = Some(Box::new(stmt));
                        }
                    }
                }
                _ => {}
            }
        }

        let condition = condition.ok_or(LowerError::MissingChild("if condition"))?;
        let then_branch = then_branch.ok_or(LowerError::MissingChild("if then branch"))?;

        Ok(IfStmt {
            span,
            condition,
            then_branch,
            else_branch,
        })
    }

    fn lower_switch_stmt(&mut self, node: &SyntaxNode) -> Result<SwitchStmt> {
        let span = self.span(node);
        let mut expr = None;
        let mut cases = Vec::new();

        // Find switch expression
        for child in node.children() {
            if child.kind() == SyntaxKind::ParenExpr {
                for inner in child.children() {
                    if inner.kind() == SyntaxKind::Expr {
                        expr = Some(self.lower_expr(&inner)?);
                        break;
                    }
                }
            }
        }

        // Find cases - they are direct children of SwitchStmt, not inside a Block
        let mut current_label: Option<SwitchLabel> = None;
        let mut current_stmts = Vec::new();
        let mut case_span = span;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::CaseLabel => {
                    // Save previous case
                    if let Some(label) = current_label.take() {
                        cases.push(SwitchCase {
                            span: case_span,
                            label,
                            stmts: std::mem::take(&mut current_stmts),
                        });
                    }
                    case_span = self.span(&child);
                    // Parse case value
                    for inner in child.children() {
                        if inner.kind() == SyntaxKind::Expr {
                            current_label = Some(SwitchLabel::Case(self.lower_expr(&inner)?));
                            break;
                        }
                    }
                }
                SyntaxKind::DefaultLabel => {
                    // Save previous case
                    if let Some(label) = current_label.take() {
                        cases.push(SwitchCase {
                            span: case_span,
                            label,
                            stmts: std::mem::take(&mut current_stmts),
                        });
                    }
                    case_span = self.span(&child);
                    current_label = Some(SwitchLabel::Default);
                }
                // Collect statements for current case
                _ if current_label.is_some() => {
                    if let Some(stmt) = self.lower_stmt(&child)? {
                        current_stmts.push(stmt);
                    }
                }
                _ => {}
            }
        }

        // Save last case
        if let Some(label) = current_label {
            cases.push(SwitchCase {
                span: case_span,
                label,
                stmts: current_stmts,
            });
        }

        let expr = expr.ok_or(LowerError::MissingChild("switch expression"))?;
        Ok(SwitchStmt { span, expr, cases })
    }

    fn lower_do_while_stmt(&mut self, node: &SyntaxNode) -> Result<DoWhileStmt> {
        let span = self.span(node);
        let mut body = None;
        let mut condition = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Block => {
                    body = Some(Box::new(Stmt::Block(self.lower_block(&child)?)));
                }
                SyntaxKind::ParenExpr => {
                    for inner in child.children() {
                        if inner.kind() == SyntaxKind::Expr {
                            condition = Some(self.lower_expr(&inner)?);
                            break;
                        }
                    }
                }
                _ => {
                    if let Some(stmt) = self.lower_stmt(&child)? {
                        body = Some(Box::new(stmt));
                    }
                }
            }
        }

        let body = body.ok_or(LowerError::MissingChild("do-while body"))?;
        let condition = condition.ok_or(LowerError::MissingChild("do-while condition"))?;

        Ok(DoWhileStmt {
            span,
            attrs: Vec::new(),
            body,
            condition,
        })
    }

    fn lower_range_for_stmt(&mut self, node: &SyntaxNode) -> Result<RangeForStmt> {
        let span = self.span(node);
        let (var_type, var_name, limit) = self.lower_for_header(node)?;
        let body = self.lower_for_body(node)?;

        Ok(RangeForStmt {
            span,
            attrs: Vec::new(),
            var_type,
            var_name,
            limit,
            body: Box::new(body),
        })
    }

    fn lower_static_for_stmt(&mut self, node: &SyntaxNode) -> Result<StaticForStmt> {
        let span = self.span(node);
        let (var_type, var_name, limit) = self.lower_for_header(node)?;
        let body = self.lower_for_body(node)?;

        Ok(StaticForStmt {
            span,
            var_type,
            var_name,
            limit,
            body: Box::new(body),
        })
    }

    fn lower_unrolled_for_stmt(&mut self, node: &SyntaxNode) -> Result<UnrolledForStmt> {
        let span = self.span(node);
        let (var_type, var_name, limit) = self.lower_for_header(node)?;
        let body = self.lower_for_body(node)?;

        Ok(UnrolledForStmt {
            span,
            var_type,
            var_name,
            limit,
            body: Box::new(body),
        })
    }

    fn lower_for_header(&mut self, node: &SyntaxNode) -> Result<(Type, Name, Expr)> {
        let span = self.span(node);
        let mut var_type = None;
        let mut var_name = None;
        let mut limit = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::ParenExpr {
                for inner in child.children() {
                    match inner.kind() {
                        SyntaxKind::Type => var_type = Some(self.lower_type(&inner)?),
                        SyntaxKind::Expr => limit = Some(self.lower_expr(&inner)?),
                        _ => {}
                    }
                }
                // Find variable name
                for token in child.children_with_tokens().filter_map(|it| it.into_token()) {
                    if token.kind() == SyntaxKind::Ident {
                        var_name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                    }
                }
            }
        }

        let var_type = var_type.unwrap_or_else(|| self.make_auto_type(span));
        let var_name = var_name.unwrap_or_else(|| Name::new(span, "_"));
        let limit = limit.ok_or(LowerError::MissingChild("for limit"))?;

        Ok((var_type, var_name, limit))
    }

    fn lower_for_body(&mut self, node: &SyntaxNode) -> Result<Stmt> {
        for child in node.children() {
            match child.kind() {
                SyntaxKind::Block => {
                    return Ok(Stmt::Block(self.lower_block(&child)?));
                }
                SyntaxKind::ParenExpr => continue,
                _ => {
                    if let Some(stmt) = self.lower_stmt(&child)? {
                        return Ok(stmt);
                    }
                }
            }
        }
        Err(LowerError::MissingChild("for body"))
    }

    fn lower_static_if_stmt(&mut self, node: &SyntaxNode) -> Result<StaticIfStmt> {
        let span = self.span(node);
        let mut condition = None;
        let mut then_branch = None;
        let mut else_branch = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::ParenExpr {
                for inner in child.children() {
                    if inner.kind() == SyntaxKind::Expr {
                        condition = Some(self.lower_expr(&inner)?);
                        break;
                    }
                }
            }
        }

        let mut saw_else = false;
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Token(t) if t.kind() == SyntaxKind::KwElse => {
                    saw_else = true;
                }
                rowan::NodeOrToken::Node(n) if n.kind() != SyntaxKind::ParenExpr => {
                    if let Some(stmt) = self.lower_stmt(&n)? {
                        if saw_else {
                            else_branch = Some(Box::new(stmt));
                        } else if then_branch.is_none() {
                            then_branch = Some(Box::new(stmt));
                        }
                    }
                }
                _ => {}
            }
        }

        let condition = condition.ok_or(LowerError::MissingChild("static if condition"))?;
        let then_branch = then_branch.ok_or(LowerError::MissingChild("static if then branch"))?;

        Ok(StaticIfStmt {
            span,
            condition,
            then_branch,
            else_branch,
        })
    }

    fn lower_reorder_stmt(&mut self, node: &SyntaxNode) -> Result<ReorderStmt> {
        let span = self.span(node);
        let mut body = None;

        for child in node.children() {
            if let Some(stmt) = self.lower_stmt(&child)? {
                body = Some(Box::new(stmt));
                break;
            }
        }

        let body = body.ok_or(LowerError::MissingChild("reorder body"))?;
        Ok(ReorderStmt { span, body })
    }

    fn lower_atomic_stmt(&mut self, node: &SyntaxNode) -> Result<AtomicStmt> {
        let span = self.span(node);
        let mut body = None;

        for child in node.children() {
            if let Some(stmt) = self.lower_stmt(&child)? {
                body = Some(Box::new(stmt));
                break;
            }
        }

        let body = body.ok_or(LowerError::MissingChild("atomic body"))?;
        Ok(AtomicStmt { span, body })
    }

    fn lower_expr_stmt(&mut self, node: &SyntaxNode) -> Result<ExprStmt> {
        let span = self.span(node);
        let mut expr = None;

        for child in node.children() {
            if self.is_expr_kind(child.kind()) {
                expr = Some(self.lower_expr(&child)?);
                break;
            }
        }

        let expr = expr.ok_or(LowerError::MissingChild("expression"))?;
        Ok(ExprStmt { span, expr })
    }

    fn lower_assign_stmt(&mut self, node: &SyntaxNode) -> Result<AssignStmt> {
        let span = self.span(node);
        let mut lhs = None;
        let mut rhs = None;
        let mut op = AssignOp::Assign;

        // Find the AssignExpr - it may be wrapped inside an Expr node
        let assign_expr = node.descendants().find(|n| n.kind() == SyntaxKind::AssignExpr);

        if let Some(assign_node) = assign_expr {
            // Binary assignment expression
            let exprs: Vec<_> = assign_node
                .children()
                .filter(|c| self.is_expr_kind(c.kind()))
                .collect();
            if exprs.len() >= 2 {
                lhs = Some(self.lower_expr(&exprs[0])?);
                rhs = Some(self.lower_expr(&exprs[1])?);
            }
            // Find operator
            for token in assign_node.children_with_tokens().filter_map(|it| it.into_token()) {
                op = match token.kind() {
                    SyntaxKind::Eq => AssignOp::Assign,
                    SyntaxKind::PlusEq => AssignOp::AddAssign,
                    SyntaxKind::MinusEq => AssignOp::SubAssign,
                    SyntaxKind::StarEq => AssignOp::MulAssign,
                    SyntaxKind::SlashEq => AssignOp::DivAssign,
                    SyntaxKind::PercentEq => AssignOp::ModAssign,
                    SyntaxKind::ShlEq => AssignOp::ShlAssign,
                    SyntaxKind::ShrEq => AssignOp::ShrAssign,
                    SyntaxKind::AmpEq => AssignOp::AndAssign,
                    SyntaxKind::PipeEq => AssignOp::OrAssign,
                    SyntaxKind::CaretEq => AssignOp::XorAssign,
                    _ => continue,
                };
                break;
            }
        }

        let lhs = lhs.ok_or(LowerError::MissingChild("assignment lhs"))?;
        let rhs = rhs.ok_or(LowerError::MissingChild("assignment rhs"))?;

        Ok(AssignStmt { span, lhs, op, rhs })
    }

    fn lower_annotated_stmt(&mut self, node: &SyntaxNode) -> Result<AnnotatedStmt> {
        let span = self.span(node);
        let mut attrs = Vec::new();
        let mut stmt = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::Attrs => attrs.extend(self.lower_attrs(&child)?),
                _ => {
                    if let Some(s) = self.lower_stmt(&child)? {
                        stmt = Some(Box::new(s));
                    }
                }
            }
        }

        let stmt = stmt.ok_or(LowerError::MissingChild("annotated statement body"))?;
        Ok(AnnotatedStmt { span, attrs, stmt })
    }

    // ========================================================================
    // Expressions
    // ========================================================================

    fn lower_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        // Unwrap Expr wrapper if present
        if node.kind() == SyntaxKind::Expr {
            for child in node.children() {
                return self.lower_expr(&child);
            }
            return Err(LowerError::MissingChild("expression content"));
        }

        match node.kind() {
            SyntaxKind::LiteralExpr => self.lower_literal_expr(node),
            SyntaxKind::IdentExpr => self.lower_ident_expr(node),
            SyntaxKind::QualifiedIdentExpr => self.lower_qualified_ident_expr(node),
            SyntaxKind::BinaryExpr => self.lower_binary_expr(node),
            SyntaxKind::UnaryExpr => self.lower_unary_expr(node),
            SyntaxKind::TernaryExpr => self.lower_ternary_expr(node),
            SyntaxKind::AssignExpr => self.lower_assign_expr(node),
            SyntaxKind::CallExpr => self.lower_call_expr(node),
            SyntaxKind::MemberExpr => self.lower_member_expr(node),
            SyntaxKind::SubscriptExpr => self.lower_subscript_expr(node),
            SyntaxKind::CastExpr => self.lower_cast_expr(node),
            SyntaxKind::ParenExpr => self.lower_paren_expr(node),
            SyntaxKind::InitializerListExpr => {
                Ok(Expr::InitializerList(self.lower_initializer_list(node)?))
            }
            SyntaxKind::DesignatedInitializerListExpr => Ok(Expr::DesignatedInitializer(
                self.lower_designated_initializer(node)?,
            )),
            SyntaxKind::StringLiteralExpr => self.lower_string_literal(node),
            SyntaxKind::InterpolatedStringExpr => self.lower_interpolated_string(node),
            SyntaxKind::LambdaExpr => self.lower_lambda_expr(node),
            _ => {
                // Fallback: try to extract something meaningful
                let span = self.span(node);
                Ok(Expr::Ident(IdentExpr {
                    span,
                    name: Name::new(span, "_unknown_"),
                    template_args: None,
                }))
            }
        }
    }

    fn lower_literal_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            match token.kind() {
                SyntaxKind::IntDec | SyntaxKind::IntHex | SyntaxKind::IntBin | SyntaxKind::IntOct => {
                    let text = token.text();
                    let (value, suffix) = self.parse_int_literal(text);
                    return Ok(Expr::IntLiteral(IntLiteral { span, value, suffix }));
                }
                SyntaxKind::Float => {
                    let value = token.text().parse().unwrap_or(0.0);
                    return Ok(Expr::FloatLiteral(FloatLiteral { span, value }));
                }
                SyntaxKind::KwTrue => {
                    return Ok(Expr::BoolLiteral(BoolLiteral { span, value: true }));
                }
                SyntaxKind::KwFalse => {
                    return Ok(Expr::BoolLiteral(BoolLiteral { span, value: false }));
                }
                SyntaxKind::String => {
                    let text = token.text();
                    let value = self.unescape_string(text);
                    return Ok(Expr::StringLiteral(StringLiteral { span, value }));
                }
                _ => {}
            }
        }

        Err(LowerError::MissingChild("literal value"))
    }

    fn parse_int_literal(&self, text: &str) -> (i128, Option<IntSuffix>) {
        let text = text.replace('_', "");
        let (num_str, suffix_str) = self.split_int_suffix(&text);

        let value = if num_str.starts_with("0x") || num_str.starts_with("0X") {
            i128::from_str_radix(&num_str[2..], 16).unwrap_or(0)
        } else if num_str.starts_with("0b") || num_str.starts_with("0B") {
            i128::from_str_radix(&num_str[2..], 2).unwrap_or(0)
        } else if num_str.starts_with("0o") || num_str.starts_with("0O") {
            i128::from_str_radix(&num_str[2..], 8).unwrap_or(0)
        } else {
            num_str.parse().unwrap_or(0)
        };

        let suffix = if !suffix_str.is_empty() {
            let signed = suffix_str.starts_with('i');
            let width_str = if signed {
                &suffix_str[1..]
            } else if suffix_str.starts_with('u') {
                &suffix_str[1..]
            } else {
                suffix_str
            };
            let width = width_str.parse().unwrap_or(32);
            Some(IntSuffix { signed, width })
        } else {
            None
        };

        (value, suffix)
    }

    fn split_int_suffix<'a>(&self, text: &'a str) -> (&'a str, &'a str) {
        // Find where the suffix starts (i or u followed by digits)
        for (i, c) in text.char_indices() {
            if (c == 'i' || c == 'u') && i > 0 {
                let rest = &text[i + 1..];
                if rest.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() {
                    return (&text[..i], &text[i..]);
                }
            }
        }
        (text, "")
    }

    fn unescape_string(&self, text: &str) -> String {
        // Remove quotes and unescape
        let inner = if text.starts_with('"') && text.ends_with('"') {
            &text[1..text.len() - 1]
        } else {
            text
        };
        // Basic unescaping
        inner
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\r", "\r")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    }

    fn lower_string_literal(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let text = node.text().to_string();
        let value = self.unescape_string(&text);
        Ok(Expr::StringLiteral(StringLiteral { span, value }))
    }

    fn lower_interpolated_string(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        // For now, just capture the raw text
        let parts = vec![StringPart::Text(node.text().to_string())];
        Ok(Expr::InterpolatedString(InterpolatedString { span, parts }))
    }

    fn lower_ident_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let mut name = None;

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            // Accept both Ident tokens and keyword tokens that can be used as identifiers
            // (e.g., mux, concat, static when used in expression position)
            if Self::is_ident_like_token(token.kind()) {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        let name = name.unwrap_or_else(|| Name::new(span, "_"));
        Ok(Expr::Ident(IdentExpr {
            span,
            name,
            template_args: None,
        }))
    }

    /// Check if a token kind can be used as an identifier.
    /// This includes `Ident` and all keyword tokens (KwAs through KwWhile).
    fn is_ident_like_token(kind: SyntaxKind) -> bool {
        kind == SyntaxKind::Ident || (kind >= SyntaxKind::KwAs && kind <= SyntaxKind::KwWhile)
    }

    fn lower_qualified_ident_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let mut parts = Vec::new();

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            // Accept both Ident tokens and keyword tokens that can be used as identifiers
            if Self::is_ident_like_token(token.kind()) {
                parts.push(Name::new(self.token_span(&token), token.text().to_string()));
            }
        }

        Ok(Expr::QualifiedIdent(QualifiedIdentExpr {
            span,
            path: QualifiedName { span, parts },
            template_args: None,
        }))
    }

    fn lower_binary_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let exprs: Vec<_> = node
            .children()
            .filter(|c| self.is_expr_kind(c.kind()))
            .collect();

        if exprs.len() < 2 {
            return Err(LowerError::MissingChild("binary expression operands"));
        }

        let lhs = self.lower_expr(&exprs[0])?;
        let rhs = self.lower_expr(&exprs[1])?;

        let mut op = BinaryOp::Add;
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            op = match token.kind() {
                SyntaxKind::Plus => BinaryOp::Add,
                SyntaxKind::Minus => BinaryOp::Sub,
                SyntaxKind::Star => BinaryOp::Mul,
                SyntaxKind::Slash => BinaryOp::Div,
                SyntaxKind::Percent => BinaryOp::Mod,
                SyntaxKind::Amp => BinaryOp::BitwiseAnd,
                SyntaxKind::Pipe => BinaryOp::BitwiseOr,
                SyntaxKind::Caret => BinaryOp::BitwiseXor,
                SyntaxKind::AndAnd => BinaryOp::LogicalAnd,
                SyntaxKind::OrOr => BinaryOp::LogicalOr,
                SyntaxKind::XorXor => BinaryOp::LogicalXor,
                SyntaxKind::Shl => BinaryOp::Shl,
                SyntaxKind::Shr => BinaryOp::Shr,
                SyntaxKind::EqEq => BinaryOp::Eq,
                SyntaxKind::NotEq => BinaryOp::Ne,
                SyntaxKind::Lt => BinaryOp::Lt,
                SyntaxKind::Le => BinaryOp::Le,
                SyntaxKind::Gt => BinaryOp::Gt,
                SyntaxKind::Ge => BinaryOp::Ge,
                _ => continue,
            };
            break;
        }

        Ok(Expr::Binary(BinaryExpr {
            span,
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        }))
    }

    fn lower_unary_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let mut operand = None;
        let mut op = UnaryOp::Neg;
        let mut op_first = false;
        let mut found_op = false;
        let mut found_operand = false;

        // Iterate through children in order to detect prefix vs postfix
        for elem in node.children_with_tokens() {
            match elem {
                rowan::NodeOrToken::Token(token) => {
                    let matched_op = match token.kind() {
                        SyntaxKind::Minus => Some(UnaryOp::Neg),
                        SyntaxKind::Not => Some(UnaryOp::Not),
                        SyntaxKind::Tilde => Some(UnaryOp::Invert),
                        SyntaxKind::PlusPlus => Some(UnaryOp::PostInc), // Will be corrected if prefix
                        SyntaxKind::MinusMinus => Some(UnaryOp::PostDec), // Will be corrected if prefix
                        _ => None,
                    };
                    if let Some(matched) = matched_op {
                        op = matched;
                        found_op = true;
                        if !found_operand {
                            // Operator came first, this is a prefix operation
                            op_first = true;
                        }
                    }
                }
                rowan::NodeOrToken::Node(child) => {
                    if self.is_expr_kind(child.kind()) && operand.is_none() {
                        operand = Some(self.lower_expr(&child)?);
                        found_operand = true;
                    }
                }
            }
        }

        // Adjust inc/dec operators based on prefix vs postfix
        if found_op && op_first {
            op = match op {
                UnaryOp::PostInc => UnaryOp::PreInc,
                UnaryOp::PostDec => UnaryOp::PreDec,
                other => other,
            };
        }

        let operand = operand.ok_or(LowerError::MissingChild("unary operand"))?;
        Ok(Expr::Unary(UnaryExpr {
            span,
            op,
            operand: Box::new(operand),
        }))
    }

    fn lower_ternary_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let exprs: Vec<_> = node
            .children()
            .filter(|c| self.is_expr_kind(c.kind()))
            .collect();

        if exprs.len() < 3 {
            return Err(LowerError::MissingChild("ternary expression parts"));
        }

        Ok(Expr::Ternary(TernaryExpr {
            span,
            condition: Box::new(self.lower_expr(&exprs[0])?),
            then_expr: Box::new(self.lower_expr(&exprs[1])?),
            else_expr: Box::new(self.lower_expr(&exprs[2])?),
        }))
    }

    fn lower_assign_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        // Assignment expressions become binary expressions for now
        let span = self.span(node);
        let exprs: Vec<_> = node
            .children()
            .filter(|c| c.kind() == SyntaxKind::Expr)
            .collect();

        if exprs.len() < 2 {
            return Err(LowerError::MissingChild("assignment expression operands"));
        }

        let lhs = self.lower_expr(&exprs[0])?;
        let rhs = self.lower_expr(&exprs[1])?;

        // For now, treat assignment expression as binary eq
        Ok(Expr::Binary(BinaryExpr {
            span,
            op: BinaryOp::Eq, // This isn't quite right but works for our purposes
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        }))
    }

    fn lower_call_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let mut callee = None;
        let mut args = Vec::new();

        for child in node.children() {
            match child.kind() {
                SyntaxKind::ArgList => {
                    for arg in child.children() {
                        if self.is_expr_kind(arg.kind()) {
                            args.push(self.lower_expr(&arg)?);
                        }
                    }
                }
                kind if self.is_expr_kind(kind) && callee.is_none() => {
                    callee = Some(self.lower_expr(&child)?);
                }
                _ => {}
            }
        }

        let callee = callee.ok_or(LowerError::MissingChild("call callee"))?;

        // Check for built-in function calls
        if let Some(builtin) = self.try_lower_builtin_call(span, &callee, &args) {
            return Ok(builtin);
        }

        Ok(Expr::Call(CallExpr {
            span,
            attrs: Vec::new(),
            callee: Box::new(callee),
            args,
        }))
    }

    /// Try to lower a call to a built-in function.
    fn try_lower_builtin_call(&self, span: Span, callee: &Expr, args: &[Expr]) -> Option<Expr> {
        // Extract the function name and template args from the callee
        let (name, template_args) = match callee {
            Expr::Ident(ident) => (ident.name.text.as_str(), &ident.template_args),
            _ => return None,
        };

        match name {
            "fan_out" => {
                // fan_out<count>(value)
                if args.len() != 1 {
                    return None;
                }
                // Extract the count from template args
                let count = template_args.as_ref().and_then(|ta| ta.first()).cloned();
                let count_expr = match count {
                    Some(TemplateArg::Expr(e)) => e,
                    // Fallback: if no template arg, use a placeholder
                    _ => Expr::IntLiteral(IntLiteral {
                        span,
                        value: 1,
                        suffix: None,
                    }),
                };
                Some(Expr::FanOut(FanOutExpr {
                    span,
                    count: Box::new(count_expr),
                    value: Box::new(args[0].clone()),
                }))
            }
            "mux" => {
                // mux(selector, arg1, arg2, ...)
                if args.is_empty() {
                    return None;
                }
                Some(Expr::Mux(MuxExpr {
                    span,
                    selector: Box::new(args[0].clone()),
                    args: args[1..].to_vec(),
                }))
            }
            "concat" => {
                // concat(arg1, arg2, ...)
                Some(Expr::Concat(ConcatExpr {
                    span,
                    args: args.to_vec(),
                }))
            }
            "bitsizeof" => {
                if args.len() != 1 {
                    return None;
                }
                Some(Expr::Sizeof(SizeofExpr {
                    span,
                    kind: SizeofKind::Bits,
                    operand: Box::new(args[0].clone()),
                }))
            }
            "bytesizeof" => {
                if args.len() != 1 {
                    return None;
                }
                Some(Expr::Sizeof(SizeofExpr {
                    span,
                    kind: SizeofKind::Bytes,
                    operand: Box::new(args[0].clone()),
                }))
            }
            "clog2" => {
                if args.len() != 1 {
                    return None;
                }
                Some(Expr::Sizeof(SizeofExpr {
                    span,
                    kind: SizeofKind::Clog2,
                    operand: Box::new(args[0].clone()),
                }))
            }
            // Note: bitoffsetof and byteoffsetof require Type and Name arguments,
            // which can't be easily extracted from expression args. Leave as regular calls.
            // "bitoffsetof" | "byteoffsetof" => None,
            "static" => {
                // static(expr) - compile-time evaluation
                if args.len() != 1 {
                    return None;
                }
                Some(Expr::Static(StaticExpr {
                    span,
                    expr: Box::new(args[0].clone()),
                }))
            }
            _ => None,
        }
    }

    fn lower_member_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let mut object = None;
        let mut member = None;

        for child in node.children() {
            if self.is_expr_kind(child.kind()) && object.is_none() {
                object = Some(self.lower_expr(&child)?);
            }
        }

        // Find member name after dot
        let mut saw_dot = false;
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Dot {
                saw_dot = true;
            } else if saw_dot && token.kind() == SyntaxKind::Ident {
                member = Some(Name::new(self.token_span(&token), token.text().to_string()));
                break;
            }
        }

        let object = object.ok_or(LowerError::MissingChild("member access object"))?;
        let member = member.unwrap_or_else(|| Name::new(span, "_"));

        Ok(Expr::Member(MemberExpr {
            span,
            object: Box::new(object),
            member,
        }))
    }

    fn lower_subscript_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let exprs: Vec<_> = node
            .children()
            .filter(|c| self.is_expr_kind(c.kind()))
            .collect();

        if exprs.len() < 2 {
            return Err(LowerError::MissingChild("subscript expression parts"));
        }

        Ok(Expr::Subscript(SubscriptExpr {
            span,
            array: Box::new(self.lower_expr(&exprs[0])?),
            index: Box::new(self.lower_expr(&exprs[1])?),
        }))
    }

    fn lower_cast_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        let mut ty = None;
        let mut expr = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::Type {
                ty = Some(self.lower_type(&child)?);
            } else if self.is_expr_kind(child.kind()) {
                expr = Some(self.lower_expr(&child)?);
            }
        }

        let ty = ty.ok_or(LowerError::MissingChild("cast type"))?;
        let expr = expr.ok_or(LowerError::MissingChild("cast expression"))?;

        Ok(Expr::Cast(CastExpr {
            span,
            ty,
            expr: Box::new(expr),
        }))
    }

    fn lower_paren_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);

        for child in node.children() {
            if self.is_expr_kind(child.kind()) {
                let inner = self.lower_expr(&child)?;
                return Ok(Expr::Paren(ParenExpr {
                    span,
                    expr: Box::new(inner),
                }));
            }
        }

        Err(LowerError::MissingChild("parenthesized expression"))
    }

    fn lower_initializer_list(&mut self, node: &SyntaxNode) -> Result<InitializerList> {
        let span = self.span(node);
        let mut elements = Vec::new();

        for child in node.children() {
            if self.is_expr_kind(child.kind()) {
                elements.push(self.lower_expr(&child)?);
            }
        }

        Ok(InitializerList { span, elements })
    }

    fn lower_designated_initializer(&mut self, node: &SyntaxNode) -> Result<DesignatedInitializer> {
        let span = self.span(node);
        let mut fields = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::DesignatedInitializer {
                let mut name = None;
                let mut value = None;

                for token in child.children_with_tokens().filter_map(|it| it.into_token()) {
                    if token.kind() == SyntaxKind::Ident && name.is_none() {
                        name = Some(Name::new(self.token_span(&token), token.text().to_string()));
                    }
                }

                for inner in child.children() {
                    if self.is_expr_kind(inner.kind()) {
                        value = Some(self.lower_expr(&inner)?);
                    }
                }

                if let (Some(n), Some(v)) = (name, value) {
                    fields.push((n, v));
                }
            }
        }

        Ok(DesignatedInitializer { span, fields })
    }

    fn lower_lambda_expr(&mut self, node: &SyntaxNode) -> Result<Expr> {
        let span = self.span(node);
        // Simplified lambda lowering
        let captures = Vec::new();
        let params = Vec::new();
        let return_type = None;
        let body = Block {
            span,
            stmts: Vec::new(),
        };

        Ok(Expr::Lambda(LambdaExpr {
            span,
            captures,
            params,
            return_type,
            body,
        }))
    }

    // ========================================================================
    // Types
    // ========================================================================

    fn lower_type(&mut self, node: &SyntaxNode) -> Result<Type> {
        // Unwrap Type wrapper if present
        if node.kind() == SyntaxKind::Type {
            for child in node.children() {
                return self.lower_type(&child);
            }
            // Fall back to checking tokens for primitive types
            return self.lower_type_from_tokens(node);
        }

        match node.kind() {
            SyntaxKind::TypeConst => self.lower_const_type(node),
            SyntaxKind::TypeTypename => self.lower_typename_type(node),
            SyntaxKind::TypeDecltype => self.lower_decltype_type(node),
            SyntaxKind::TypePath => self.lower_type_path(node),
            SyntaxKind::TypeArray => self.lower_array_type(node),
            SyntaxKind::TypeFunction => self.lower_function_type(node),
            _ => self.lower_type_from_tokens(node),
        }
    }

    fn lower_type_from_tokens(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            match token.kind() {
                SyntaxKind::KwVoid => {
                    return Ok(Type::Primitive(PrimitiveType {
                        span,
                        kind: PrimitiveKind::Void,
                    }));
                }
                SyntaxKind::KwBool => {
                    return Ok(Type::Primitive(PrimitiveType {
                        span,
                        kind: PrimitiveKind::Bool,
                    }));
                }
                SyntaxKind::KwString => {
                    return Ok(Type::Primitive(PrimitiveType {
                        span,
                        kind: PrimitiveKind::String,
                    }));
                }
                SyntaxKind::KwFloat32 => {
                    return Ok(Type::Primitive(PrimitiveType {
                        span,
                        kind: PrimitiveKind::Float32,
                    }));
                }
                SyntaxKind::KwAuto => {
                    return Ok(Type::Primitive(PrimitiveType {
                        span,
                        kind: PrimitiveKind::Auto,
                    }));
                }
                SyntaxKind::KwInt => {
                    return Ok(Type::Integer(IntegerType {
                        span,
                        signed: true,
                        width: IntWidth::Fixed(32),
                    }));
                }
                SyntaxKind::KwUint => {
                    return Ok(Type::Integer(IntegerType {
                        span,
                        signed: false,
                        width: IntWidth::Fixed(32),
                    }));
                }
                SyntaxKind::Ident => {
                    let text = token.text();
                    // Check for int32, uint16, etc.
                    if let Some(ty) = self.parse_int_type_name(text, span) {
                        return Ok(ty);
                    }
                    // Named type
                    return Ok(Type::Named(NamedType {
                        span,
                        path: QualifiedName {
                            span,
                            parts: vec![Name::new(self.token_span(&token), text.to_string())],
                        },
                        template_args: None,
                    }));
                }
                _ => {}
            }
        }

        // Default to auto
        Ok(self.make_auto_type(span))
    }

    fn parse_int_type_name(&self, text: &str, span: Span) -> Option<Type> {
        if text.starts_with("int") {
            let width_str = &text[3..];
            if let Ok(width) = width_str.parse::<u32>() {
                return Some(Type::Integer(IntegerType {
                    span,
                    signed: true,
                    width: IntWidth::Fixed(width),
                }));
            }
        } else if text.starts_with("uint") {
            let width_str = &text[4..];
            if let Ok(width) = width_str.parse::<u32>() {
                return Some(Type::Integer(IntegerType {
                    span,
                    signed: false,
                    width: IntWidth::Fixed(width),
                }));
            }
        }
        None
    }

    fn lower_const_type(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut inner = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::Type {
                inner = Some(self.lower_type(&child)?);
                break;
            }
        }

        let inner = inner.unwrap_or_else(|| self.make_auto_type(span));
        Ok(Type::Const(ConstType {
            span,
            inner: Box::new(inner),
        }))
    }

    fn lower_typename_type(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut parts = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::TypePath {
                return self.lower_typename_from_path(&child);
            }
        }

        // Fallback: collect idents
        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident {
                parts.push(Name::new(self.token_span(&token), token.text().to_string()));
            }
        }

        Ok(Type::Typename(TypenameType {
            span,
            path: QualifiedName { span, parts },
        }))
    }

    fn lower_typename_from_path(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut parts = Vec::new();

        for child in node.children() {
            if child.kind() == SyntaxKind::TypePathSegment {
                for token in child.children_with_tokens().filter_map(|it| it.into_token()) {
                    if token.kind() == SyntaxKind::Ident {
                        parts.push(Name::new(self.token_span(&token), token.text().to_string()));
                    }
                }
            }
        }

        Ok(Type::Typename(TypenameType {
            span,
            path: QualifiedName { span, parts },
        }))
    }

    fn lower_decltype_type(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut expr = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::ParenExpr => {
                    for inner in child.children() {
                        if inner.kind() == SyntaxKind::Expr {
                            expr = Some(self.lower_expr(&inner)?);
                            break;
                        }
                    }
                }
                SyntaxKind::Expr => {
                    expr = Some(self.lower_expr(&child)?);
                }
                _ => {}
            }
        }

        let expr = expr.ok_or(LowerError::MissingChild("decltype expression"))?;
        Ok(Type::Decltype(DecltypeType {
            span,
            expr: Box::new(expr),
        }))
    }

    fn lower_type_path(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut parts = Vec::new();
        let template_args = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::TypePathSegment {
                for token in child.children_with_tokens().filter_map(|it| it.into_token()) {
                    let token_span = self.token_span(&token);
                    match token.kind() {
                        // Primitive type keywords
                        SyntaxKind::KwVoid => {
                            return Ok(Type::Primitive(PrimitiveType {
                                span: token_span,
                                kind: PrimitiveKind::Void,
                            }));
                        }
                        SyntaxKind::KwBool => {
                            return Ok(Type::Primitive(PrimitiveType {
                                span: token_span,
                                kind: PrimitiveKind::Bool,
                            }));
                        }
                        SyntaxKind::KwString => {
                            return Ok(Type::Primitive(PrimitiveType {
                                span: token_span,
                                kind: PrimitiveKind::String,
                            }));
                        }
                        SyntaxKind::KwFloat32 => {
                            return Ok(Type::Primitive(PrimitiveType {
                                span: token_span,
                                kind: PrimitiveKind::Float32,
                            }));
                        }
                        SyntaxKind::KwAuto => {
                            return Ok(Type::Primitive(PrimitiveType {
                                span: token_span,
                                kind: PrimitiveKind::Auto,
                            }));
                        }
                        SyntaxKind::KwInt => {
                            return Ok(Type::Integer(IntegerType {
                                span: token_span,
                                signed: true,
                                width: IntWidth::Fixed(32),
                            }));
                        }
                        SyntaxKind::KwUint => {
                            return Ok(Type::Integer(IntegerType {
                                span: token_span,
                                signed: false,
                                width: IntWidth::Fixed(32),
                            }));
                        }
                        SyntaxKind::Ident => {
                            let text = token.text();
                            // Check if this is an int type like int32, uint16
                            if let Some(ty) = self.parse_int_type_name(text, token_span) {
                                return Ok(ty);
                            }
                            parts.push(Name::new(token_span, text.to_string()));
                        }
                        _ => {}
                    }
                }
                // TODO: Handle template args
            }
        }

        if parts.is_empty() {
            return Ok(self.make_auto_type(span));
        }

        Ok(Type::Named(NamedType {
            span,
            path: QualifiedName { span, parts },
            template_args,
        }))
    }

    fn lower_array_type(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut element = None;
        let mut dims = Vec::new();

        for child in node.children() {
            match child.kind() {
                // TypeArray wraps the base type directly (TypePath, TypeConst, etc.)
                SyntaxKind::Type => element = Some(self.lower_type(&child)?),
                SyntaxKind::TypePath => element = Some(self.lower_type_path(&child)?),
                SyntaxKind::TypeConst => element = Some(self.lower_const_type(&child)?),
                SyntaxKind::TypeFunction => element = Some(self.lower_function_type(&child)?),
                SyntaxKind::TypeArrayDim => {
                    for inner in child.children() {
                        if inner.kind() == SyntaxKind::Expr {
                            dims.push(self.lower_expr(&inner)?);
                        }
                    }
                }
                _ => {}
            }
        }

        let element = element.unwrap_or_else(|| self.make_auto_type(span));
        Ok(Type::Array(ArrayType {
            span,
            attrs: Vec::new(),
            element: Box::new(element),
            dims,
        }))
    }

    fn lower_function_type(&mut self, node: &SyntaxNode) -> Result<Type> {
        let span = self.span(node);
        let mut params = Vec::new();
        let mut return_type = None;

        for child in node.children() {
            match child.kind() {
                SyntaxKind::TypeFunctionParams => {
                    for param in child.children() {
                        if param.kind() == SyntaxKind::TypeFunctionParam {
                            params.push(self.lower_function_type_param(&param)?);
                        }
                    }
                }
                SyntaxKind::Type => {
                    // This should be the return type (after ->)
                    return_type = Some(self.lower_type(&child)?);
                }
                _ => {}
            }
        }

        let return_type = return_type.unwrap_or_else(|| self.make_void_type(span));
        Ok(Type::Function(FunctionType {
            span,
            attrs: Vec::new(),
            params,
            return_type: Box::new(return_type),
        }))
    }

    fn lower_function_type_param(&mut self, node: &SyntaxNode) -> Result<FunctionTypeParam> {
        let span = self.span(node);
        let mut ty = None;
        let mut name = None;

        for child in node.children() {
            if child.kind() == SyntaxKind::Type {
                ty = Some(self.lower_type(&child)?);
            }
        }

        for token in node.children_with_tokens().filter_map(|it| it.into_token()) {
            if token.kind() == SyntaxKind::Ident && ty.is_some() {
                name = Some(Name::new(self.token_span(&token), token.text().to_string()));
            }
        }

        let ty = ty.unwrap_or_else(|| self.make_auto_type(span));
        Ok(FunctionTypeParam { span, ty, name })
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    fn make_auto_type(&self, span: Span) -> Type {
        Type::Primitive(PrimitiveType {
            span,
            kind: PrimitiveKind::Auto,
        })
    }

    fn make_void_type(&self, span: Span) -> Type {
        Type::Primitive(PrimitiveType {
            span,
            kind: PrimitiveKind::Void,
        })
    }
}
