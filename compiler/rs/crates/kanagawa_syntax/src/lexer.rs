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

    #[regex(r"//[^\n]*")]
    LineComment,

    #[regex(r"/\*([^*]|\*+[^*/])*\*+/")]
    BlockComment,

    #[regex(r#"\"([^\\\"]|\\.)*\""#)]
    String,

    #[regex(r"0[xX][0-9a-fA-F]+[a-zA-Z0-9]*")]
    IntHex,

    #[regex(r"[0-9]+[a-zA-Z0-9]*")]
    IntDec,

    #[regex(r"[A-Za-z_][A-Za-z0-9_]*")]
    Ident,

    // Two-char punct/operators first
    #[token("==")]
    EqEq,
    #[token("!=")]
    NotEq,
    #[token("<=")]
    Le,
    #[token(">=")]
    Ge,
    #[token("&&")]
    AndAnd,
    #[token("||")]
    OrOr,

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

}

fn keyword_kind(ident: &str) -> Option<SyntaxKind> {
    Some(match ident {
        "module" => SyntaxKind::KwModule,
        "import" => SyntaxKind::KwImport,
        "struct" => SyntaxKind::KwStruct,
        "union" => SyntaxKind::KwUnion,
        "enum" => SyntaxKind::KwEnum,
        "fn" => SyntaxKind::KwFn,
        "let" => SyntaxKind::KwLet,
        "const" => SyntaxKind::KwConst,
        "if" => SyntaxKind::KwIf,
        "else" => SyntaxKind::KwElse,
        "return" => SyntaxKind::KwReturn,
        _ => return None,
    })
}

fn map_token_kind(kind: TokenKind, text: &str) -> SyntaxKind {
    match kind {
        TokenKind::Whitespace => SyntaxKind::Whitespace,
        TokenKind::LineComment => SyntaxKind::LineComment,
        TokenKind::BlockComment => SyntaxKind::BlockComment,
        TokenKind::String => SyntaxKind::String,
        TokenKind::IntHex => SyntaxKind::IntHex,
        TokenKind::IntDec => SyntaxKind::IntDec,
        TokenKind::Ident => keyword_kind(text).unwrap_or(SyntaxKind::Ident),
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
        TokenKind::AndAnd => SyntaxKind::AndAnd,
        TokenKind::OrOr => SyntaxKind::OrOr,
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
