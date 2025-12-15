use crate::{Diagnostic, Span, SyntaxKind};
use logos::Logos;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LexedToken {
    pub kind: SyntaxKind,
    pub span: Span,
}

#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    #[regex(r"[\t\n\r ]+")]
    Whitespace,

    // Documentation comments must come before regular line comments.
    #[regex(r"//\|[^\n]*")]
    DocLineCommentPre,

    #[regex(r"//<[^\n]*")]
    DocLineCommentPost,

    #[regex(r"//[^\n]*")]
    LineComment,

    #[token("/*", lex_nested_block_comment)]
    BlockComment,

    #[regex(r#"\"([^\\\"]|\\.)*\""#)]
    String,

    #[regex(r"'([^\\']|\\.)'")]
    Char,

    #[regex(r"0[xX][0-9a-fA-F_]+[a-zA-Z0-9]*")]
    IntHex,

    #[regex(r"0[bB][01_]+[a-zA-Z0-9]*")]
    IntBin,

    #[regex(r"0[oO][0-7_]+[a-zA-Z0-9]*")]
    IntOct,

    #[regex(r"[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9][0-9_]*)?")]
    #[regex(r"\.[0-9][0-9_]*([eE][+-]?[0-9][0-9_]*)?")]
    #[regex(r"[0-9][0-9_]*([eE][+-]?[0-9][0-9_]*)")]
    Float,

    #[regex(r"[0-9][0-9_]*[a-zA-Z0-9]*")]
    IntDec,

    #[regex(r"[A-Za-z_][A-Za-z0-9_]*")]
    Ident,

    // Two-char punct/operators first
    #[token("::")]
    Scope,
    #[token("->")]
    Arrow,
    #[token("=>")]
    FatArrow,

    #[token("...")]
    DotDotDot,
    #[token("..")]
    DotDot,

    #[token("++")]
    PlusPlus,
    #[token("--")]
    MinusMinus,

    #[token("<<=")]
    ShlEq,
    #[token(">>=")]
    ShrEq,
    #[token("<<")]
    Shl,
    #[token(">>")]
    Shr,

    #[token("&&=")]
    AndAndEq,
    #[token("||=")]
    OrOrEq,
    #[token("^^=")]
    XorXorEq,
    #[token("&&")]
    AndAnd,
    #[token("||")]
    OrOr,
    #[token("^^")]
    XorXor,

    #[token("+=")]
    PlusEq,
    #[token("-=")]
    MinusEq,
    #[token("*=")]
    StarEq,
    #[token("/=")]
    SlashEq,
    #[token("%=")]
    PercentEq,
    #[token("&=")]
    AmpEq,
    #[token("|=")]
    PipeEq,
    #[token("^=")]
    CaretEq,

    #[token("==")]
    EqEq,
    #[token("!=")]
    NotEq,
    #[token("<=")]
    Le,
    #[token(">=")]
    Ge,

    #[token("(")]
    LParen,
    #[token(")")]
    RParen,
    #[token("{")]
    LBrace,
    #[token("}")]
    RBrace,
    #[token("[")]
    LBracket,
    #[token("]")]
    RBracket,
    #[token(",")]
    Comma,
    #[token(";")]
    Semi,
    #[token(":")]
    Colon,
    #[token(".")]
    Dot,
    #[token("\\")]
    Backslash,
    #[token("?")]
    Question,

    #[token("+")]
    Plus,
    #[token("-")]
    Minus,
    #[token("*")]
    Star,
    #[token("/")]
    Slash,
    #[token("%")]
    Percent,

    #[token("=")]
    Eq,
    #[token("!")]
    Not,
    #[token("<")]
    Lt,
    #[token(">")]
    Gt,

    #[token("&")]
    Amp,
    #[token("|")]
    Pipe,
    #[token("^")]
    Caret,
    #[token("~")]
    Tilde,
}

fn lex_nested_block_comment(lex: &mut logos::Lexer<TokenKind>) -> bool {
    let bytes = lex.remainder().as_bytes();
    let mut depth: usize = 1;
    let mut i: usize = 0;

    while i + 1 < bytes.len() {
        let a = bytes[i];
        let b = bytes[i + 1];

        if a == b'/' && b == b'*' {
            depth += 1;
            i += 2;
            continue;
        }

        if a == b'*' && b == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                lex.bump(i);
                return true;
            }
            continue;
        }

        i += 1;
    }

    // Unterminated: consume to end. The main lex loop will treat any remaining
    // bytes as part of the comment token; higher-level stages can diagnose.
    lex.bump(bytes.len());
    true
}

fn keyword_kind(ident: &str) -> Option<SyntaxKind> {
    Some(match ident {
        "as" => SyntaxKind::KwAs,
        "atomic" => SyntaxKind::KwAtomic,
        "auto" => SyntaxKind::KwAuto,
        "barrier" => SyntaxKind::KwBarrier,
        "bitsizeof" => SyntaxKind::KwBitsizeof,
        "bitoffsetof" => SyntaxKind::KwBitoffsetof,
        "bool" => SyntaxKind::KwBool,
        "break" => SyntaxKind::KwBreak,
        "bytesizeof" => SyntaxKind::KwBytesizeof,
        "byteoffsetof" => SyntaxKind::KwByteoffsetof,
        "cast" => SyntaxKind::KwCast,
        "case" => SyntaxKind::KwCase,
        "class" => SyntaxKind::KwClass,
        "clog2" => SyntaxKind::KwClog2,
        "concat" => SyntaxKind::KwConcat,
        "const" => SyntaxKind::KwConst,
        "decltype" => SyntaxKind::KwDecltype,
        "default" => SyntaxKind::KwDefault,
        "do" => SyntaxKind::KwDo,
        "else" => SyntaxKind::KwElse,
        "enum" => SyntaxKind::KwEnum,
        "export" => SyntaxKind::KwExport,
        "extern" => SyntaxKind::KwExtern,
        "false" => SyntaxKind::KwFalse,
        "fan_out" => SyntaxKind::KwFanOut,
        "float32" => SyntaxKind::KwFloat32,
        "for" => SyntaxKind::KwFor,
        "if" => SyntaxKind::KwIf,
        "import" => SyntaxKind::KwImport,
        "inline" => SyntaxKind::KwInline,
        "int" => SyntaxKind::KwInt,
        "lutmul" => SyntaxKind::KwLutmul,
        "module" => SyntaxKind::KwModule,
        "mux" => SyntaxKind::KwMux,
        "noinline" => SyntaxKind::KwNoinline,
        "private" => SyntaxKind::KwPrivate,
        "public" => SyntaxKind::KwPublic,
        "reorder" => SyntaxKind::KwReorder,
        "return" => SyntaxKind::KwReturn,
        "static" => SyntaxKind::KwStatic,
        "static_assert" => SyntaxKind::KwStaticAssert,
        "string" => SyntaxKind::KwString,
        "struct" => SyntaxKind::KwStruct,
        "switch" => SyntaxKind::KwSwitch,
        "template" => SyntaxKind::KwTemplate,
        "true" => SyntaxKind::KwTrue,
        "typename" => SyntaxKind::KwTypename,
        "uint" => SyntaxKind::KwUint,
        "union" => SyntaxKind::KwUnion,
        "unrolled_for" => SyntaxKind::KwUnrolledFor,
        "using" => SyntaxKind::KwUsing,
        "void" => SyntaxKind::KwVoid,
        "while" => SyntaxKind::KwWhile,
        _ => return None,
    })
}

fn map_token_kind(kind: TokenKind, text: &str) -> SyntaxKind {
    match kind {
        TokenKind::Whitespace => SyntaxKind::Whitespace,
        TokenKind::DocLineCommentPre => SyntaxKind::DocLineCommentPre,
        TokenKind::DocLineCommentPost => SyntaxKind::DocLineCommentPost,
        TokenKind::LineComment => SyntaxKind::LineComment,
        TokenKind::BlockComment => SyntaxKind::BlockComment,
        TokenKind::String => SyntaxKind::String,
        TokenKind::Char => SyntaxKind::Char,
        TokenKind::IntHex => SyntaxKind::IntHex,
        TokenKind::IntBin => SyntaxKind::IntBin,
        TokenKind::IntOct => SyntaxKind::IntOct,
        TokenKind::Float => SyntaxKind::Float,
        TokenKind::IntDec => SyntaxKind::IntDec,
        TokenKind::Ident => keyword_kind(text).unwrap_or(SyntaxKind::Ident),
        TokenKind::Scope => SyntaxKind::Scope,
        TokenKind::Arrow => SyntaxKind::Arrow,
        TokenKind::FatArrow => SyntaxKind::FatArrow,
        TokenKind::DotDot => SyntaxKind::DotDot,
        TokenKind::DotDotDot => SyntaxKind::DotDotDot,
        TokenKind::PlusPlus => SyntaxKind::PlusPlus,
        TokenKind::MinusMinus => SyntaxKind::MinusMinus,
        TokenKind::Shl => SyntaxKind::Shl,
        TokenKind::Shr => SyntaxKind::Shr,
        TokenKind::ShlEq => SyntaxKind::ShlEq,
        TokenKind::ShrEq => SyntaxKind::ShrEq,
        TokenKind::AndAnd => SyntaxKind::AndAnd,
        TokenKind::OrOr => SyntaxKind::OrOr,
        TokenKind::XorXor => SyntaxKind::XorXor,
        TokenKind::AndAndEq => SyntaxKind::AndAndEq,
        TokenKind::OrOrEq => SyntaxKind::OrOrEq,
        TokenKind::XorXorEq => SyntaxKind::XorXorEq,
        TokenKind::PlusEq => SyntaxKind::PlusEq,
        TokenKind::MinusEq => SyntaxKind::MinusEq,
        TokenKind::StarEq => SyntaxKind::StarEq,
        TokenKind::SlashEq => SyntaxKind::SlashEq,
        TokenKind::PercentEq => SyntaxKind::PercentEq,
        TokenKind::AmpEq => SyntaxKind::AmpEq,
        TokenKind::PipeEq => SyntaxKind::PipeEq,
        TokenKind::CaretEq => SyntaxKind::CaretEq,
        TokenKind::LParen => SyntaxKind::LParen,
        TokenKind::RParen => SyntaxKind::RParen,
        TokenKind::LBrace => SyntaxKind::LBrace,
        TokenKind::RBrace => SyntaxKind::RBrace,
        TokenKind::LBracket => SyntaxKind::LBracket,
        TokenKind::RBracket => SyntaxKind::RBracket,
        TokenKind::Comma => SyntaxKind::Comma,
        TokenKind::Semi => SyntaxKind::Semi,
        TokenKind::Colon => SyntaxKind::Colon,
        TokenKind::Dot => SyntaxKind::Dot,
        TokenKind::Backslash => SyntaxKind::Backslash,
        TokenKind::Question => SyntaxKind::Question,
        TokenKind::Plus => SyntaxKind::Plus,
        TokenKind::Minus => SyntaxKind::Minus,
        TokenKind::Star => SyntaxKind::Star,
        TokenKind::Slash => SyntaxKind::Slash,
        TokenKind::Percent => SyntaxKind::Percent,
        TokenKind::Eq => SyntaxKind::Eq,
        TokenKind::EqEq => SyntaxKind::EqEq,
        TokenKind::Not => SyntaxKind::Not,
        TokenKind::NotEq => SyntaxKind::NotEq,
        TokenKind::Lt => SyntaxKind::Lt,
        TokenKind::Gt => SyntaxKind::Gt,
        TokenKind::Le => SyntaxKind::Le,
        TokenKind::Ge => SyntaxKind::Ge,
        TokenKind::Amp => SyntaxKind::Amp,
        TokenKind::Pipe => SyntaxKind::Pipe,
        TokenKind::Caret => SyntaxKind::Caret,
        TokenKind::Tilde => SyntaxKind::Tilde,
    }
}

pub fn lex(text: &str) -> (Vec<LexedToken>, Vec<Diagnostic>) {
    let mut lexer = TokenKind::lexer(text);

    let mut tokens = Vec::new();
    let mut diags = Vec::new();

    while let Some(result) = lexer.next() {
        let span = lexer.span();
        let token_text = &text[span.clone()];

        // We used `logos(skip ...)` for whitespace, but we still want comments.
        let mapped = match result {
            Ok(kind) => map_token_kind(kind, token_text),
            Err(()) => {
                diags.push(Diagnostic::error(
                    format!(
                        "Unexpected character: {:?}",
                        token_text.chars().next().unwrap_or('\0')
                    ),
                    Span::new(span.start, span.end),
                ));
                SyntaxKind::Error
            }
        };

        tokens.push(LexedToken {
            kind: mapped,
            span: Span::new(span.start, span.end),
        });
    }

    tokens.push(LexedToken {
        kind: SyntaxKind::Eof,
        span: Span::new(text.len(), text.len()),
    });

    (tokens, diags)
}
