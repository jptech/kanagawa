mod diag;
mod lexer;
mod parse;
mod syntax;

pub use diag::{Diagnostic, Severity, Span};
pub use lexer::{lex, LexedToken};
pub use parse::{parse_file, Parse};
pub use syntax::{SyntaxKind, SyntaxLanguage};
