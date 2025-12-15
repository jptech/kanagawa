use rowan::Language;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u16)]
pub enum SyntaxKind {
    // Tokens
    Whitespace,
    LineComment,
    BlockComment,

    Ident,
    IntDec,
    IntHex,
    String,

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

    // Operators (starter set)
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Eq,
    EqEq,
    Not,
    NotEq,
    Lt,
    Gt,
    Le,
    Ge,
    AndAnd,
    OrOr,

    // Keywords (starter set)
    KwModule,
    KwImport,
    KwStruct,
    KwUnion,
    KwEnum,
    KwFn,
    KwLet,
    KwConst,
    KwIf,
    KwElse,
    KwReturn,

    Error,
    Eof,

    // Nodes
    File,
    ErrorNode,
}

impl SyntaxKind {
    pub fn is_trivia(self) -> bool {
        matches!(self, SyntaxKind::Whitespace | SyntaxKind::LineComment | SyntaxKind::BlockComment)
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
