//! HIR node definitions.
//!
//! HIR nodes are similar to AST nodes but include resolved type information
//! and DefIds for all named entities.

use crate::def::DefId;
use crate::ty::{Ty, TyAttr, FunctionKind};
use crate::Span;

// ============================================================================
// File / Module structure
// ============================================================================

/// A complete HIR file.
#[derive(Debug, Clone)]
pub struct HirFile {
    pub span: Span,
    /// Module declaration (if present).
    pub module: Option<HirModule>,
    /// Import declarations.
    pub imports: Vec<HirImport>,
    /// Top-level items.
    pub items: Vec<HirItem>,
}

/// A module declaration.
#[derive(Debug, Clone)]
pub struct HirModule {
    pub span: Span,
    pub def_id: DefId,
    /// Encoded module namespace (e.g., "@data@optional").
    pub namespace: String,
    /// Export list.
    pub exports: Vec<HirExport>,
}

/// A module export.
#[derive(Debug, Clone)]
pub enum HirExport {
    /// Named export.
    Name(String),
    /// Module re-export.
    Module(String),
    /// Module difference export.
    ModuleDiff { include: String, exclude: String },
}

/// An import declaration.
#[derive(Debug, Clone)]
pub struct HirImport {
    pub span: Span,
    /// Encoded module namespace.
    pub namespace: String,
    /// Optional alias.
    pub alias: Option<String>,
}

// ============================================================================
// Items (declarations)
// ============================================================================

/// A top-level or member item.
#[derive(Debug, Clone)]
pub enum HirItem {
    Function(HirFunction),
    Variable(HirVariable),
    Struct(HirStruct),
    Enum(HirEnum),
    Class(HirClass),
    Union(HirUnion),
    Using(HirUsing),
    Template(HirTemplate),
    StaticIf(HirStaticIf),
    StaticAssert(HirStaticAssert),
    Extern(HirExtern),
    Export(HirExport2),
}

/// A function definition.
#[derive(Debug, Clone)]
pub struct HirFunction {
    pub span: Span,
    pub def_id: DefId,
    /// Resolved type (function type).
    pub ty: Ty,
    /// Function kind.
    pub kind: FunctionKind,
    /// Attributes.
    pub attrs: Vec<TyAttr>,
    /// Modifier (inline/noinline).
    pub modifier: Option<HirFunctionModifier>,
    /// Return type.
    pub return_ty: Ty,
    /// Function name.
    pub name: String,
    /// Parameters with their DefIds.
    pub params: Vec<HirParam>,
    /// Function body (None for declarations).
    pub body: Option<HirBlock>,
}

/// Function modifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirFunctionModifier {
    Inline,
    NoInline,
}

/// A function parameter.
#[derive(Debug, Clone)]
pub struct HirParam {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub default: Option<HirExpr>,
}

/// A variable declaration.
#[derive(Debug, Clone)]
pub struct HirVariable {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub init: Option<HirExpr>,
    pub flags: HirDeclFlags,
}

/// Declaration flags.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HirDeclFlags {
    pub is_const: bool,
    pub is_static: bool,
    pub is_global: bool,
}

/// A struct definition.
#[derive(Debug, Clone)]
pub struct HirStruct {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub members: Vec<HirStructMember>,
}

/// A struct member.
#[derive(Debug, Clone)]
pub struct HirStructMember {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub init: Option<HirExpr>,
}

/// An enum definition.
#[derive(Debug, Clone)]
pub struct HirEnum {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub base_ty: Ty,
    pub variants: Vec<HirEnumVariant>,
}

/// An enum variant.
#[derive(Debug, Clone)]
pub struct HirEnumVariant {
    pub span: Span,
    pub def_id: DefId,
    pub name: String,
    pub value: Option<HirExpr>,
}

/// A class definition.
#[derive(Debug, Clone)]
pub struct HirClass {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub members: Vec<HirClassMember>,
}

/// A class member.
#[derive(Debug, Clone)]
pub enum HirClassMember {
    Access(HirAccessSpecifier),
    Variable(HirVariable),
    Function(HirFunction),
    DefaultInit(HirExpr),
    Nested(Box<HirItem>),
}

/// Access specifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirAccessSpecifier {
    Public,
    Private,
}

/// A union definition.
#[derive(Debug, Clone)]
pub struct HirUnion {
    pub span: Span,
    pub def_id: DefId,
    pub ty: Ty,
    pub name: String,
    pub members: Vec<HirStructMember>,
}

/// A type alias.
#[derive(Debug, Clone)]
pub struct HirUsing {
    pub span: Span,
    pub def_id: DefId,
    pub name: String,
    pub ty: Ty,
}

/// A template definition.
#[derive(Debug, Clone)]
pub struct HirTemplate {
    pub span: Span,
    pub def_id: DefId,
    pub params: Vec<HirTemplateParam>,
    pub item: Box<HirItem>,
}

/// A template parameter.
#[derive(Debug, Clone)]
pub enum HirTemplateParam {
    Type {
        span: Span,
        def_id: DefId,
        name: String,
        default: Option<Ty>,
    },
    NonType {
        span: Span,
        def_id: DefId,
        ty: Ty,
        name: String,
        default: Option<HirExpr>,
    },
}

/// A static if declaration.
#[derive(Debug, Clone)]
pub struct HirStaticIf {
    pub span: Span,
    pub condition: HirExpr,
    pub then_item: Box<HirItem>,
    pub else_item: Option<Box<HirItem>>,
}

/// A static assert declaration.
#[derive(Debug, Clone)]
pub struct HirStaticAssert {
    pub span: Span,
    pub condition: HirExpr,
}

/// An extern declaration.
#[derive(Debug, Clone)]
pub struct HirExtern {
    pub span: Span,
    pub attrs: Vec<TyAttr>,
    pub item: Box<HirItem>,
}

/// An export declaration.
#[derive(Debug, Clone)]
pub struct HirExport2 {
    pub span: Span,
    pub attrs: Vec<TyAttr>,
    pub item: Box<HirItem>,
}

// ============================================================================
// Statements
// ============================================================================

/// HIR statements.
#[derive(Debug, Clone)]
pub enum HirStmt {
    Block(HirBlock),
    Return(HirReturn),
    If(HirIf),
    Switch(HirSwitch),
    DoWhile(HirDoWhile),
    RangeFor(HirRangeFor),
    StaticFor(HirStaticFor),
    UnrolledFor(HirUnrolledFor),
    StaticIf(HirStaticIfStmt),
    Barrier(Span),
    Reorder(HirReorder),
    Atomic(HirAtomic),
    Break(Span),
    Expr(HirExprStmt),
    Assign(HirAssign),
    VarDecl(HirVariable),
    Annotated(HirAnnotated),
}

/// A block of statements.
#[derive(Debug, Clone)]
pub struct HirBlock {
    pub span: Span,
    pub stmts: Vec<HirStmt>,
}

/// Return statement.
#[derive(Debug, Clone)]
pub struct HirReturn {
    pub span: Span,
    pub value: Option<HirExpr>,
}

/// If statement.
#[derive(Debug, Clone)]
pub struct HirIf {
    pub span: Span,
    pub condition: HirExpr,
    pub then_branch: Box<HirStmt>,
    pub else_branch: Option<Box<HirStmt>>,
}

/// Switch statement.
#[derive(Debug, Clone)]
pub struct HirSwitch {
    pub span: Span,
    pub expr: HirExpr,
    pub cases: Vec<HirSwitchCase>,
}

/// Switch case.
#[derive(Debug, Clone)]
pub struct HirSwitchCase {
    pub span: Span,
    pub label: HirSwitchLabel,
    pub stmts: Vec<HirStmt>,
}

/// Switch label.
#[derive(Debug, Clone)]
pub enum HirSwitchLabel {
    Case(HirExpr),
    Default,
}

/// Do-while loop.
#[derive(Debug, Clone)]
pub struct HirDoWhile {
    pub span: Span,
    pub attrs: Vec<TyAttr>,
    pub body: Box<HirStmt>,
    pub condition: HirExpr,
}

/// Range-for loop.
#[derive(Debug, Clone)]
pub struct HirRangeFor {
    pub span: Span,
    pub attrs: Vec<TyAttr>,
    pub var_def_id: DefId,
    pub var_ty: Ty,
    pub var_name: String,
    pub limit: HirExpr,
    pub body: Box<HirStmt>,
}

/// Static for loop.
#[derive(Debug, Clone)]
pub struct HirStaticFor {
    pub span: Span,
    pub var_def_id: DefId,
    pub var_ty: Ty,
    pub var_name: String,
    pub limit: HirExpr,
    pub body: Box<HirStmt>,
}

/// Unrolled for loop.
#[derive(Debug, Clone)]
pub struct HirUnrolledFor {
    pub span: Span,
    pub var_def_id: DefId,
    pub var_ty: Ty,
    pub var_name: String,
    pub limit: HirExpr,
    pub body: Box<HirStmt>,
}

/// Static if statement.
#[derive(Debug, Clone)]
pub struct HirStaticIfStmt {
    pub span: Span,
    pub condition: HirExpr,
    pub then_branch: Box<HirStmt>,
    pub else_branch: Option<Box<HirStmt>>,
}

/// Reorder statement.
#[derive(Debug, Clone)]
pub struct HirReorder {
    pub span: Span,
    pub body: Box<HirStmt>,
}

/// Atomic statement.
#[derive(Debug, Clone)]
pub struct HirAtomic {
    pub span: Span,
    pub body: Box<HirStmt>,
}

/// Expression statement.
#[derive(Debug, Clone)]
pub struct HirExprStmt {
    pub span: Span,
    pub expr: HirExpr,
}

/// Assignment statement.
#[derive(Debug, Clone)]
pub struct HirAssign {
    pub span: Span,
    pub lhs: HirExpr,
    pub op: HirAssignOp,
    pub rhs: HirExpr,
}

/// Assignment operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirAssignOp {
    Assign,
    AddAssign,
    SubAssign,
    MulAssign,
    DivAssign,
    ModAssign,
    ShlAssign,
    ShrAssign,
    AndAssign,
    OrAssign,
    XorAssign,
}

/// Annotated statement.
#[derive(Debug, Clone)]
pub struct HirAnnotated {
    pub span: Span,
    pub attrs: Vec<TyAttr>,
    pub stmt: Box<HirStmt>,
}

// ============================================================================
// Expressions
// ============================================================================

/// HIR expressions with type information.
#[derive(Debug, Clone)]
pub struct HirExpr {
    pub span: Span,
    /// Resolved type of this expression.
    pub ty: Ty,
    /// Expression kind.
    pub kind: HirExprKind,
}

impl HirExpr {
    /// Create a new expression with the given kind and type.
    pub fn new(span: Span, ty: Ty, kind: HirExprKind) -> Self {
        Self { span, ty, kind }
    }

    /// Create an untyped/unresolved expression.
    pub fn untyped(span: Span, kind: HirExprKind) -> Self {
        Self { span, ty: Ty::Unresolved, kind }
    }
}

/// Expression kinds.
#[derive(Debug, Clone)]
pub enum HirExprKind {
    // Literals
    IntLiteral { value: i128, suffix: Option<HirIntSuffix> },
    FloatLiteral(f64),
    BoolLiteral(bool),
    StringLiteral(String),
    InterpolatedString(Vec<HirStringPart>),

    // Names
    /// Resolved identifier (points to definition).
    Ident { name: String, def_id: DefId },
    /// Qualified identifier.
    QualifiedIdent { path: Vec<String>, def_id: DefId },
    /// This reference.
    This { scope: Vec<String> },

    // Operations
    Binary { op: HirBinaryOp, lhs: Box<HirExpr>, rhs: Box<HirExpr> },
    Unary { op: HirUnaryOp, operand: Box<HirExpr> },
    Ternary { condition: Box<HirExpr>, then_expr: Box<HirExpr>, else_expr: Box<HirExpr> },

    // Access
    Call { callee: Box<HirExpr>, args: Vec<HirExpr>, attrs: Vec<TyAttr> },
    Member { object: Box<HirExpr>, member: String, member_def_id: Option<DefId> },
    Subscript { array: Box<HirExpr>, index: Box<HirExpr> },

    // Type operations
    Cast { ty: Ty, expr: Box<HirExpr> },

    // Built-in expressions
    Mux { selector: Box<HirExpr>, args: Vec<HirExpr> },
    Concat(Vec<HirExpr>),
    FanOut { count: Box<HirExpr>, value: Box<HirExpr> },
    Static(Box<HirExpr>),

    // Initializers
    InitializerList(Vec<HirExpr>),
    DesignatedInitializer(Vec<(String, HirExpr)>),

    // Other
    Paren(Box<HirExpr>),
    TypeExpr(Ty),
    Lambda(Box<HirLambda>),
    Sizeof { kind: HirSizeofKind, operand: Box<HirExpr> },
    Offsetof { kind: HirOffsetofKind, ty: Ty, field: String },

    // Enum value.
    EnumValue { enum_ty: Ty, variant: String, value: Box<HirExpr> },

    // Named value (for member access through reference).
    NamedValue(Box<HirExpr>),

    // Error placeholder.
    Error(String),
}

/// Integer literal suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HirIntSuffix {
    pub signed: bool,
    pub width: u8,
}

/// Interpolated string parts.
#[derive(Debug, Clone)]
pub enum HirStringPart {
    Text(String),
    Interpolation {
        expr: Box<HirExpr>,
        show_name: bool,
        format: Option<HirFormatSpec>,
    },
}

/// Format specifier.
#[derive(Debug, Clone)]
pub struct HirFormatSpec {
    pub kind: HirFormatKind,
    pub precision: Option<u32>,
}

/// Format kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirFormatKind {
    Binary,
    Octal,
    Decimal,
    Hex,
    HexUpper,
}

/// Binary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirBinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    BitwiseAnd,
    BitwiseOr,
    BitwiseXor,
    LogicalAnd,
    LogicalOr,
    LogicalXor,
    Shl,
    Shr,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Unary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirUnaryOp {
    Neg,
    Not,
    Invert,
    PostInc,
    PostDec,
    PreInc,
    PreDec,
}

/// Lambda expression.
#[derive(Debug, Clone)]
pub struct HirLambda {
    pub span: Span,
    pub def_id: DefId,
    pub captures: Vec<HirCapture>,
    pub params: Vec<HirParam>,
    pub return_ty: Option<Ty>,
    pub body: HirBlock,
}

/// Lambda capture.
#[derive(Debug, Clone)]
pub struct HirCapture {
    pub span: Span,
    pub def_id: DefId,
    pub name: String,
    /// The definition being captured.
    pub captured_def_id: DefId,
}

/// Sizeof kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirSizeofKind {
    Bits,
    Bytes,
    Clog2,
}

/// Offsetof kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirOffsetofKind {
    Bits,
    Bytes,
}
