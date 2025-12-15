use rowan::Language;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u16)]
pub enum SyntaxKind {
    // Tokens
    Whitespace,
    DocLineCommentPre,
    DocLineCommentPost,
    LineComment,
    BlockComment,

    Ident,
    IntDec,
    IntHex,
    IntBin,
    IntOct,
    Float,
    String,
    Char,

    // String subdivision tokens (used by parser for interpolated strings).
    StringQuote,
    StringText,
    StringEscape,

    // Punctuation
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Comma,
    Semi,
    Colon,
    Dot,
    DotDot,
    DotDotDot,
    Backslash,
    Question,
    Scope,

    // Operators
    Plus,
    Minus,
    Star,
    Slash,
    Percent,

    PlusPlus,
    MinusMinus,

    Eq,
    PlusEq,
    MinusEq,
    StarEq,
    SlashEq,
    PercentEq,
    ShlEq,
    ShrEq,
    AmpEq,
    PipeEq,
    CaretEq,
    AndAndEq,
    OrOrEq,

    EqEq,
    Not,
    NotEq,
    Lt,
    Gt,
    Le,
    Ge,

    Shl,
    Shr,

    Amp,
    Pipe,
    Caret,
    Tilde,

    AndAnd,
    OrOr,
    XorXor,

    Arrow,
    FatArrow,

    // Keywords (Haskell lexer reserved list)
    KwAs,
    KwAtomic,
    KwAuto,
    KwBarrier,
    KwBitsizeof,
    KwBitoffsetof,
    KwBool,
    KwBreak,
    KwBytesizeof,
    KwByteoffsetof,
    KwCast,
    KwCase,
    KwClass,
    KwClog2,
    KwConcat,
    KwConst,
    KwDecltype,
    KwDefault,
    KwDo,
    KwElse,
    KwEnum,
    KwExport,
    KwExtern,
    KwFalse,
    KwFanOut,
    KwFloat32,
    KwFor,
    KwIf,
    KwImport,
    KwInline,
    KwInt,
    KwLutmul,
    KwModule,
    KwMux,
    KwNoinline,
    KwPrivate,
    KwPublic,
    KwReorder,
    KwReturn,
    KwStatic,
    KwStaticAssert,
    KwString,
    KwStruct,
    KwSwitch,
    KwTemplate,
    KwTrue,
    KwTypename,
    KwUint,
    KwUnion,
    KwUnrolledFor,
    KwUsing,
    KwVoid,
    KwWhile,

    Error,
    Eof,

    // Nodes
    File,
    ModuleDecl,
    ImportDecl,
    ModuleName,
    ModuleNameSegment,
    ModuleExports,
    ExportItem,
    ModuleReference,
    ModuleDiff,
    Attrs,
    AttrBlock,
    AttrItem,
    TemplateDecl,
    TemplateParams,
    TemplateParam,
    StructDecl,
    StructBody,
    StructMemberDecl,
    EnumDecl,
    EnumBody,
    EnumVariant,
    UnionDecl,
    UnionBody,
    UnionMemberDecl,
    ClassDecl,
    ClassBody,
    AccessSpecifier,
    DefaultInitDecl,
    ClassVarDecl,
    UsingDecl,
    ExternDecl,
    ExportDecl,
    StaticAssertDecl,
    StaticIfDecl,
    GlobalVarDecl,
    FunctionDecl,
    FunctionDef,
    FuncParams,
    Block,
    StmtList,
    AnnotatedStmt,
    ReturnStmt,
    IfStmt,
    SwitchStmt,
    CaseLabel,
    DefaultLabel,
    BreakStmt,
    DoWhileStmt,
    RangeForStmt,
    UnrolledForStmt,
    StaticForStmt,
    StaticIfStmt,
    BarrierStmt,
    ReorderStmt,
    AtomicStmt,
    IncDecStmt,
    AssignStmt,
    StaticDefaultInitStmt,
    LocalVarDecl,
    StaticVarDecl,
    ExprStmt,

    LambdaExpr,
    LambdaCaptureList,
    LambdaCapture,
    LambdaParams,
    LambdaReturnType,

    // Types
    Type,
    TypeConst,
    TypeTypename,
    TypeDecltype,
    TypePath,
    TypePathSegment,
    TypeTemplateArgs,
    TypeTemplateArg,
    TypeArray,
    TypeArrayDim,
    TypeFunction,
    TypeFunctionParams,
    TypeFunctionParam,

    // Expressions
    Expr,
    IdentExpr,
    QualifiedIdentExpr,
    LiteralExpr,
    ParenExpr,
    UnaryExpr,
    BinaryExpr,
    TernaryExpr,
    AssignExpr,
    CallExpr,
    ArgList,
    MemberExpr,
    SubscriptExpr,
    CastExpr,

    // Initializers
    InitializerListExpr,
    DesignatedInitializerListExpr,
    DesignatedInitializer,

    // Strings
    StringLiteralExpr,
    InterpolatedStringExpr,
    StringInterpolation,
    StringFormat,
    ErrorNode,
}

impl SyntaxKind {
    pub fn is_trivia(self) -> bool {
        matches!(
            self,
            SyntaxKind::Whitespace
                | SyntaxKind::DocLineCommentPre
                | SyntaxKind::DocLineCommentPost
                | SyntaxKind::LineComment
                | SyntaxKind::BlockComment
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SyntaxLanguage {}

impl Language for SyntaxLanguage {
    type Kind = SyntaxKind;

    fn kind_from_raw(raw: rowan::SyntaxKind) -> SyntaxKind {
        // Safety: we only produce `u16` values originating from this enum.
        unsafe { std::mem::transmute::<u16, SyntaxKind>(raw.0 as u16) }
    }

    fn kind_to_raw(kind: SyntaxKind) -> rowan::SyntaxKind {
        rowan::SyntaxKind(kind as u16)
    }
}

pub type SyntaxNode = rowan::SyntaxNode<SyntaxLanguage>;

pub type SyntaxToken = rowan::SyntaxToken<SyntaxLanguage>;
