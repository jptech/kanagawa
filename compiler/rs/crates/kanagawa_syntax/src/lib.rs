mod diag;
mod doc;
mod lexer;
mod parse;
mod syntax;

pub use diag::{Diagnostic, Severity, Span};
pub use doc::{
    attached_doc_comments, leading_doc_comments_pre, trailing_doc_comments_post,
    AttachedDocComments,
};
pub use lexer::{lex, LexedToken};
pub use parse::{parse_file, Parse};
pub use syntax::{SyntaxKind, SyntaxLanguage, SyntaxNode, SyntaxToken};
