//! AST node type definitions.
//!
//! This module defines all AST node types. The design follows the structure
//! needed for ParseTree emission while being idiomatic Rust.

use crate::Span;

// ============================================================================
// File / Module structure
// ============================================================================

/// A complete source file.
#[derive(Debug, Clone)]
pub struct File {
    pub span: Span,
    /// Optional module declaration at the top of the file.
    pub module: Option<ModuleDecl>,
    /// Import declarations.
    pub imports: Vec<ImportDecl>,
    /// Top-level declarations.
    pub decls: Vec<Decl>,
}

/// A module declaration: `module foo.bar { exported_items }`
#[derive(Debug, Clone)]
pub struct ModuleDecl {
    pub span: Span,
    /// Module name (dot-separated segments).
    pub name: ModuleName,
    /// Exported items.
    pub exports: Vec<ModuleExport>,
}

/// A module name consisting of dot-separated segments.
#[derive(Debug, Clone)]
pub struct ModuleName {
    pub span: Span,
    pub segments: Vec<Name>,
}

/// An exported item in a module declaration.
#[derive(Debug, Clone)]
pub enum ModuleExport {
    /// A simple identifier export.
    Ident(Name),
    /// Re-export a module: `module foo.bar`
    Module(ModuleName),
    /// Module difference: `module foo \ bar`
    ModuleDiff {
        include: ModuleName,
        exclude: ModuleName,
    },
}

/// An import declaration: `import foo.bar [as alias]`
#[derive(Debug, Clone)]
pub struct ImportDecl {
    pub span: Span,
    pub name: ModuleName,
    pub alias: Option<Name>,
}

// ============================================================================
// Names and identifiers
// ============================================================================

/// A simple identifier name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Name {
    pub span: Span,
    pub text: String,
}

impl Name {
    pub fn new(span: Span, text: impl Into<String>) -> Self {
        Self {
            span,
            text: text.into(),
        }
    }
}

/// A qualified name with optional namespace prefix: `foo::bar::baz`
#[derive(Debug, Clone)]
pub struct QualifiedName {
    pub span: Span,
    pub parts: Vec<Name>,
}

// ============================================================================
// Declarations
// ============================================================================

/// Top-level or member declarations.
#[derive(Debug, Clone)]
pub enum Decl {
    /// Function definition: `[[attrs]] inline T foo(params) { body }`
    Function(FunctionDecl),
    /// Variable declaration: `T x = init;`
    Variable(VariableDecl),
    /// Struct definition: `struct Foo { members }`
    Struct(StructDecl),
    /// Enum definition: `enum Foo : T { variants }`
    Enum(EnumDecl),
    /// Class definition: `class Foo { members }`
    Class(ClassDecl),
    /// Union definition: `union Foo { members }`
    Union(UnionDecl),
    /// Type alias: `using Name = Type;`
    Using(UsingDecl),
    /// Template wrapper: `template <params> decl`
    Template(TemplateDecl),
    /// Static if: `static if (cond) decl [else decl]`
    StaticIf(StaticIfDecl),
    /// Static assert: `static_assert(cond);`
    StaticAssert(StaticAssertDecl),
    /// Extern declaration
    Extern(ExternDecl),
    /// Export declaration
    Export(ExportDecl),
}

/// A function declaration or definition.
#[derive(Debug, Clone)]
pub struct FunctionDecl {
    pub span: Span,
    /// Attributes like `[[async]]`, `[[pipelined]]`.
    pub attrs: Vec<Attribute>,
    /// Function modifiers (inline, noinline).
    pub modifier: Option<FunctionModifier>,
    /// Return type.
    pub return_type: Type,
    /// Function name.
    pub name: Name,
    /// Function parameters.
    pub params: Vec<FunctionParam>,
    /// Function body (None for declarations without body).
    pub body: Option<Block>,
}

/// A function parameter.
#[derive(Debug, Clone)]
pub struct FunctionParam {
    pub span: Span,
    /// Parameter type.
    pub ty: Type,
    /// Parameter name.
    pub name: Name,
    /// Default value.
    pub default: Option<Expr>,
}

/// Function modifier (inline/noinline).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionModifier {
    Inline,
    NoInline,
}

/// A variable declaration.
#[derive(Debug, Clone)]
pub struct VariableDecl {
    pub span: Span,
    /// Variable type.
    pub ty: Type,
    /// Variable name.
    pub name: Name,
    /// Initial value.
    pub init: Option<Expr>,
    /// Declaration flags (const, static, etc.).
    pub flags: DeclFlags,
}

/// Flags for variable declarations.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DeclFlags {
    pub is_const: bool,
    pub is_static: bool,
    pub is_global: bool,
}

/// A struct declaration.
#[derive(Debug, Clone)]
pub struct StructDecl {
    pub span: Span,
    pub name: Name,
    pub members: Vec<StructMember>,
}

/// A struct member (field).
#[derive(Debug, Clone)]
pub struct StructMember {
    pub span: Span,
    pub ty: Type,
    pub name: Name,
    pub init: Option<Expr>,
}

/// An enum declaration.
#[derive(Debug, Clone)]
pub struct EnumDecl {
    pub span: Span,
    pub name: Name,
    /// Underlying type.
    pub base_type: Type,
    pub variants: Vec<EnumVariant>,
}

/// An enum variant.
#[derive(Debug, Clone)]
pub struct EnumVariant {
    pub span: Span,
    pub name: Name,
    pub value: Option<Expr>,
}

/// A class declaration.
#[derive(Debug, Clone)]
pub struct ClassDecl {
    pub span: Span,
    pub name: Name,
    pub members: Vec<ClassMember>,
}

/// A class member.
#[derive(Debug, Clone)]
pub enum ClassMember {
    /// Access specifier: `public:` or `private:`
    Access(AccessSpecifier),
    /// Member variable.
    Variable(VariableDecl),
    /// Member function.
    Function(FunctionDecl),
    /// Default initialization block.
    DefaultInit(Expr),
    /// Nested type declaration.
    NestedDecl(Box<Decl>),
}

/// Access specifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessSpecifier {
    Public,
    Private,
}

/// A union declaration.
#[derive(Debug, Clone)]
pub struct UnionDecl {
    pub span: Span,
    pub name: Name,
    pub members: Vec<StructMember>,
}

/// A type alias: `using Name = Type;`
#[derive(Debug, Clone)]
pub struct UsingDecl {
    pub span: Span,
    pub name: Name,
    pub ty: Type,
}

/// A template wrapper.
#[derive(Debug, Clone)]
pub struct TemplateDecl {
    pub span: Span,
    pub params: Vec<TemplateParam>,
    pub decl: Box<Decl>,
}

/// A template parameter.
#[derive(Debug, Clone)]
pub enum TemplateParam {
    /// Type parameter: `typename T` or `typename T = Default`
    Type {
        span: Span,
        name: Name,
        default: Option<Type>,
    },
    /// Non-type parameter: `auto N` or `int N = 0`
    NonType {
        span: Span,
        ty: Type,
        name: Name,
        default: Option<Expr>,
    },
}

/// Static if declaration.
#[derive(Debug, Clone)]
pub struct StaticIfDecl {
    pub span: Span,
    pub condition: Expr,
    pub then_decl: Box<Decl>,
    pub else_decl: Option<Box<Decl>>,
}

/// Static assert declaration.
#[derive(Debug, Clone)]
pub struct StaticAssertDecl {
    pub span: Span,
    pub condition: Expr,
}

/// Extern declaration wrapper.
#[derive(Debug, Clone)]
pub struct ExternDecl {
    pub span: Span,
    pub attrs: Vec<Attribute>,
    pub decl: Box<Decl>,
}

/// Export declaration wrapper.
#[derive(Debug, Clone)]
pub struct ExportDecl {
    pub span: Span,
    pub attrs: Vec<Attribute>,
    pub decl: Box<Decl>,
}

// ============================================================================
// Attributes
// ============================================================================

/// An attribute like `[[async]]` or `[[latency(N)]]`.
#[derive(Debug, Clone)]
pub struct Attribute {
    pub span: Span,
    pub kind: AttributeKind,
}

/// Attribute variants.
#[derive(Debug, Clone)]
pub enum AttributeKind {
    /// Flag attribute: `[[async]]`, `[[pipelined]]`
    Flag(AttributeFlag),
    /// Attribute with expression argument: `[[latency(N)]]`
    WithArg {
        name: AttributeName,
        arg: Box<Expr>,
    },
}

/// Flag-style attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeFlag {
    Async,
    Atomic,
    Initialize,
    Memory,
    NoBackPressure,
    NonReplicated,
    Pipelined,
    Pure,
    QuadPort,
    ReorderByLooping,
    Reset,
    Unordered,
}

/// Named attributes that take arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeName {
    CallRate,
    FifoDepth,
    Latency,
    MaxThreads,
    Name,
    Schedule,
    ThreadRate,
    TransactionSize,
}

// ============================================================================
// Statements
// ============================================================================

/// Statements that appear in function bodies.
#[derive(Debug, Clone)]
pub enum Stmt {
    /// Block: `{ stmts }`
    Block(Block),
    /// Return: `return [expr];`
    Return(ReturnStmt),
    /// If: `if (cond) then [else]`
    If(IfStmt),
    /// Switch: `switch (expr) { cases }`
    Switch(SwitchStmt),
    /// Do-while: `do body while (cond);`
    DoWhile(DoWhileStmt),
    /// Range-for: `for (const T i : limit) body`
    RangeFor(RangeForStmt),
    /// Static for: `static for (const T i : limit) body`
    StaticFor(StaticForStmt),
    /// Unrolled for: `unrolled_for (const T i : limit) body`
    UnrolledFor(UnrolledForStmt),
    /// Static if statement: `static if (cond) then [else]`
    StaticIf(StaticIfStmt),
    /// Barrier: `barrier;`
    Barrier(Span),
    /// Reorder: `reorder stmt`
    Reorder(ReorderStmt),
    /// Atomic: `atomic stmt`
    Atomic(AtomicStmt),
    /// Break: `break;`
    Break(Span),
    /// Expression statement: `expr;`
    Expr(ExprStmt),
    /// Assignment: `lhs = rhs;` or `lhs += rhs;`
    Assign(AssignStmt),
    /// Variable declaration (local).
    VarDecl(VariableDecl),
    /// Annotated statement: `[[attr]] stmt`
    Annotated(AnnotatedStmt),
}

/// A block of statements.
#[derive(Debug, Clone)]
pub struct Block {
    pub span: Span,
    pub stmts: Vec<Stmt>,
}

/// Return statement.
#[derive(Debug, Clone)]
pub struct ReturnStmt {
    pub span: Span,
    pub value: Option<Expr>,
}

/// If statement.
#[derive(Debug, Clone)]
pub struct IfStmt {
    pub span: Span,
    pub condition: Expr,
    pub then_branch: Box<Stmt>,
    pub else_branch: Option<Box<Stmt>>,
}

/// Switch statement.
#[derive(Debug, Clone)]
pub struct SwitchStmt {
    pub span: Span,
    pub expr: Expr,
    pub cases: Vec<SwitchCase>,
}

/// A switch case or default.
#[derive(Debug, Clone)]
pub struct SwitchCase {
    pub span: Span,
    pub label: SwitchLabel,
    pub stmts: Vec<Stmt>,
}

/// Switch label.
#[derive(Debug, Clone)]
pub enum SwitchLabel {
    Case(Expr),
    Default,
}

/// Do-while loop.
#[derive(Debug, Clone)]
pub struct DoWhileStmt {
    pub span: Span,
    pub attrs: Vec<Attribute>,
    pub body: Box<Stmt>,
    pub condition: Expr,
}

/// Range-for loop.
#[derive(Debug, Clone)]
pub struct RangeForStmt {
    pub span: Span,
    pub attrs: Vec<Attribute>,
    pub var_type: Type,
    pub var_name: Name,
    pub limit: Expr,
    pub body: Box<Stmt>,
}

/// Static for loop (compile-time).
#[derive(Debug, Clone)]
pub struct StaticForStmt {
    pub span: Span,
    pub var_type: Type,
    pub var_name: Name,
    pub limit: Expr,
    pub body: Box<Stmt>,
}

/// Unrolled for loop.
#[derive(Debug, Clone)]
pub struct UnrolledForStmt {
    pub span: Span,
    pub var_type: Type,
    pub var_name: Name,
    pub limit: Expr,
    pub body: Box<Stmt>,
}

/// Static if statement.
#[derive(Debug, Clone)]
pub struct StaticIfStmt {
    pub span: Span,
    pub condition: Expr,
    pub then_branch: Box<Stmt>,
    pub else_branch: Option<Box<Stmt>>,
}

/// Reorder statement.
#[derive(Debug, Clone)]
pub struct ReorderStmt {
    pub span: Span,
    pub body: Box<Stmt>,
}

/// Atomic statement.
#[derive(Debug, Clone)]
pub struct AtomicStmt {
    pub span: Span,
    pub body: Box<Stmt>,
}

/// Expression statement.
#[derive(Debug, Clone)]
pub struct ExprStmt {
    pub span: Span,
    pub expr: Expr,
}

/// Assignment statement.
#[derive(Debug, Clone)]
pub struct AssignStmt {
    pub span: Span,
    pub lhs: Expr,
    pub op: AssignOp,
    pub rhs: Expr,
}

/// Assignment operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssignOp {
    Assign,    // =
    AddAssign, // +=
    SubAssign, // -=
    MulAssign, // *=
    DivAssign, // /=
    ModAssign, // %=
    ShlAssign, // <<=
    ShrAssign, // >>=
    AndAssign, // &=
    OrAssign,  // |=
    XorAssign, // ^=
}

/// Annotated statement with attributes.
#[derive(Debug, Clone)]
pub struct AnnotatedStmt {
    pub span: Span,
    pub attrs: Vec<Attribute>,
    pub stmt: Box<Stmt>,
}

// ============================================================================
// Expressions
// ============================================================================

/// Expressions.
#[derive(Debug, Clone)]
pub enum Expr {
    /// Integer literal: `42`, `0xFF`
    IntLiteral(IntLiteral),
    /// Float literal: `3.14`
    FloatLiteral(FloatLiteral),
    /// Bool literal: `true`, `false`
    BoolLiteral(BoolLiteral),
    /// String literal: `"hello"`
    StringLiteral(StringLiteral),
    /// Interpolated string: `"{x}"`
    InterpolatedString(InterpolatedString),
    /// Identifier: `foo`
    Ident(IdentExpr),
    /// Qualified identifier: `foo::bar`
    QualifiedIdent(QualifiedIdentExpr),
    /// Binary operation: `a + b`
    Binary(BinaryExpr),
    /// Unary operation: `-x`, `!x`
    Unary(UnaryExpr),
    /// Ternary conditional: `cond ? a : b`
    Ternary(TernaryExpr),
    /// Function call: `foo(a, b)`
    Call(CallExpr),
    /// Member access: `x.field`
    Member(MemberExpr),
    /// Array subscript: `arr[i]`
    Subscript(SubscriptExpr),
    /// Cast: `cast<T>(x)`
    Cast(CastExpr),
    /// Mux: `mux(sel, a, b)`
    Mux(MuxExpr),
    /// Concat: `concat(a, b)`
    Concat(ConcatExpr),
    /// Fan out: `fan_out<N>(x)`
    FanOut(FanOutExpr),
    /// Static expression: `static(x)`
    Static(StaticExpr),
    /// Initializer list: `{a, b, c}`
    InitializerList(InitializerList),
    /// Designated initializer: `{.x = a, .y = b}`
    DesignatedInitializer(DesignatedInitializer),
    /// Parenthesized expression.
    Paren(ParenExpr),
    /// Type as expression (for decltype comparisons, etc).
    TypeExpr(TypeExpr),
    /// Lambda expression.
    Lambda(LambdaExpr),
    /// Sizeof expressions: `bitsizeof(T)`, `bytesizeof(T)`
    Sizeof(SizeofExpr),
    /// Offset expressions: `bitoffsetof(T, field)`, `byteoffsetof(T, field)`
    Offsetof(OffsetofExpr),
}

/// Integer literal.
#[derive(Debug, Clone)]
pub struct IntLiteral {
    pub span: Span,
    pub value: i128,
    /// Explicit type suffix (e.g., `u32`, `i16`).
    pub suffix: Option<IntSuffix>,
}

/// Integer literal suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntSuffix {
    pub signed: bool,
    pub width: u8,
}

/// Float literal.
#[derive(Debug, Clone)]
pub struct FloatLiteral {
    pub span: Span,
    pub value: f64,
}

/// Bool literal.
#[derive(Debug, Clone)]
pub struct BoolLiteral {
    pub span: Span,
    pub value: bool,
}

/// String literal.
#[derive(Debug, Clone)]
pub struct StringLiteral {
    pub span: Span,
    pub value: String,
}

/// Interpolated string.
#[derive(Debug, Clone)]
pub struct InterpolatedString {
    pub span: Span,
    pub parts: Vec<StringPart>,
}

/// Part of an interpolated string.
#[derive(Debug, Clone)]
pub enum StringPart {
    /// Literal text portion.
    Text(String),
    /// Interpolated expression: `{expr}` or `{expr=}`
    Interpolation {
        expr: Box<Expr>,
        show_name: bool,
        format: Option<FormatSpec>,
    },
}

/// Format specifier for string interpolation.
#[derive(Debug, Clone)]
pub struct FormatSpec {
    pub kind: FormatKind,
    pub precision: Option<u32>,
}

/// Format specifier kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatKind {
    Binary,
    Octal,
    Decimal,
    Hex,
    HexUpper,
}

/// Identifier expression.
#[derive(Debug, Clone)]
pub struct IdentExpr {
    pub span: Span,
    pub name: Name,
    /// Optional template arguments.
    pub template_args: Option<Vec<TemplateArg>>,
}

/// Qualified identifier expression.
#[derive(Debug, Clone)]
pub struct QualifiedIdentExpr {
    pub span: Span,
    pub path: QualifiedName,
    pub template_args: Option<Vec<TemplateArg>>,
}

/// Template argument.
#[derive(Debug, Clone)]
pub enum TemplateArg {
    Type(Type),
    Expr(Expr),
}

/// Binary expression.
#[derive(Debug, Clone)]
pub struct BinaryExpr {
    pub span: Span,
    pub op: BinaryOp,
    pub lhs: Box<Expr>,
    pub rhs: Box<Expr>,
}

/// Binary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
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

/// Unary expression.
#[derive(Debug, Clone)]
pub struct UnaryExpr {
    pub span: Span,
    pub op: UnaryOp,
    pub operand: Box<Expr>,
}

/// Unary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Neg,     // -
    Not,     // !
    Invert,  // ~
    PostInc, // x++
    PostDec, // x--
    PreInc,  // ++x
    PreDec,  // --x
}

/// Ternary conditional expression.
#[derive(Debug, Clone)]
pub struct TernaryExpr {
    pub span: Span,
    pub condition: Box<Expr>,
    pub then_expr: Box<Expr>,
    pub else_expr: Box<Expr>,
}

/// Function call expression.
#[derive(Debug, Clone)]
pub struct CallExpr {
    pub span: Span,
    /// Call-site attributes.
    pub attrs: Vec<Attribute>,
    /// Function being called.
    pub callee: Box<Expr>,
    /// Arguments.
    pub args: Vec<Expr>,
}

/// Member access expression.
#[derive(Debug, Clone)]
pub struct MemberExpr {
    pub span: Span,
    pub object: Box<Expr>,
    pub member: Name,
}

/// Array subscript expression.
#[derive(Debug, Clone)]
pub struct SubscriptExpr {
    pub span: Span,
    pub array: Box<Expr>,
    pub index: Box<Expr>,
}

/// Cast expression.
#[derive(Debug, Clone)]
pub struct CastExpr {
    pub span: Span,
    pub ty: Type,
    pub expr: Box<Expr>,
}

/// Mux expression.
#[derive(Debug, Clone)]
pub struct MuxExpr {
    pub span: Span,
    pub selector: Box<Expr>,
    pub args: Vec<Expr>,
}

/// Concat expression.
#[derive(Debug, Clone)]
pub struct ConcatExpr {
    pub span: Span,
    pub args: Vec<Expr>,
}

/// Fan-out expression.
#[derive(Debug, Clone)]
pub struct FanOutExpr {
    pub span: Span,
    pub count: Box<Expr>,
    pub value: Box<Expr>,
}

/// Static expression.
#[derive(Debug, Clone)]
pub struct StaticExpr {
    pub span: Span,
    pub expr: Box<Expr>,
}

/// Initializer list.
#[derive(Debug, Clone)]
pub struct InitializerList {
    pub span: Span,
    pub elements: Vec<Expr>,
}

/// Designated initializer list.
#[derive(Debug, Clone)]
pub struct DesignatedInitializer {
    pub span: Span,
    pub fields: Vec<(Name, Expr)>,
}

/// Parenthesized expression.
#[derive(Debug, Clone)]
pub struct ParenExpr {
    pub span: Span,
    pub expr: Box<Expr>,
}

/// Type as expression.
#[derive(Debug, Clone)]
pub struct TypeExpr {
    pub span: Span,
    pub ty: Type,
}

/// Lambda expression.
#[derive(Debug, Clone)]
pub struct LambdaExpr {
    pub span: Span,
    pub captures: Vec<LambdaCapture>,
    pub params: Vec<FunctionParam>,
    pub return_type: Option<Type>,
    pub body: Block,
}

/// Lambda capture.
#[derive(Debug, Clone)]
pub struct LambdaCapture {
    pub span: Span,
    pub name: Name,
}

/// Sizeof expression.
#[derive(Debug, Clone)]
pub struct SizeofExpr {
    pub span: Span,
    pub kind: SizeofKind,
    pub operand: Box<Expr>,
}

/// Sizeof kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeofKind {
    Bits,
    Bytes,
    Clog2,
}

/// Offsetof expression.
#[derive(Debug, Clone)]
pub struct OffsetofExpr {
    pub span: Span,
    pub kind: OffsetofKind,
    pub ty: Type,
    pub field: Name,
}

/// Offsetof kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffsetofKind {
    Bits,
    Bytes,
}

// ============================================================================
// Types
// ============================================================================

/// Type expressions.
#[derive(Debug, Clone)]
pub enum Type {
    /// Primitive types: `void`, `bool`, `string`, `float32`, `auto`
    Primitive(PrimitiveType),
    /// Integer type: `int32`, `uint16`, `int<N>`, `uint<N>`
    Integer(IntegerType),
    /// Named type: `Foo`, `Foo::Bar<T>`
    Named(NamedType),
    /// Array type: `T[N]`
    Array(ArrayType),
    /// Function type: `(T, U) -> R`
    Function(FunctionType),
    /// Const type: `const T`
    Const(ConstType),
    /// Typename type: `typename T::X`
    Typename(TypenameType),
    /// Decltype: `decltype(expr)`
    Decltype(DecltypeType),
}

/// Primitive types.
#[derive(Debug, Clone)]
pub struct PrimitiveType {
    pub span: Span,
    pub kind: PrimitiveKind,
}

/// Primitive type kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimitiveKind {
    Void,
    Bool,
    String,
    Float32,
    Auto,
}

/// Integer type.
#[derive(Debug, Clone)]
pub struct IntegerType {
    pub span: Span,
    pub signed: bool,
    /// Width: either a constant or a computed expression.
    pub width: IntWidth,
}

/// Integer width.
#[derive(Debug, Clone)]
pub enum IntWidth {
    /// Fixed width: `int32`, `uint8`
    Fixed(u32),
    /// Parameterized width: `int<N>`, `uint<clog2(M)+1>`
    Param(Box<Expr>),
}

/// Named type (possibly qualified with template args).
#[derive(Debug, Clone)]
pub struct NamedType {
    pub span: Span,
    pub path: QualifiedName,
    pub template_args: Option<Vec<TemplateArg>>,
}

/// Array type.
#[derive(Debug, Clone)]
pub struct ArrayType {
    pub span: Span,
    /// Array attributes (memory, quad_port, etc.)
    pub attrs: Vec<Attribute>,
    /// Element type.
    pub element: Box<Type>,
    /// Array dimensions.
    pub dims: Vec<Expr>,
}

/// Function type.
#[derive(Debug, Clone)]
pub struct FunctionType {
    pub span: Span,
    pub attrs: Vec<Attribute>,
    pub params: Vec<FunctionTypeParam>,
    pub return_type: Box<Type>,
}

/// Function type parameter.
#[derive(Debug, Clone)]
pub struct FunctionTypeParam {
    pub span: Span,
    pub ty: Type,
    pub name: Option<Name>,
}

/// Const-qualified type.
#[derive(Debug, Clone)]
pub struct ConstType {
    pub span: Span,
    pub inner: Box<Type>,
}

/// Typename type (for dependent types).
#[derive(Debug, Clone)]
pub struct TypenameType {
    pub span: Span,
    pub path: QualifiedName,
}

/// Decltype type.
#[derive(Debug, Clone)]
pub struct DecltypeType {
    pub span: Span,
    pub expr: Box<Expr>,
}
