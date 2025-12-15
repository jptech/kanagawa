use crate::{lex, Diagnostic, LexedToken, SyntaxKind};
use crate::syntax::SyntaxNode;
use rowan::{GreenNode, GreenNodeBuilder};

#[derive(Clone, Debug)]
pub struct Parse {
    pub green: GreenNode,
    pub diagnostics: Vec<Diagnostic>,
}

impl Parse {
    pub fn syntax_node(&self) -> SyntaxNode {
        SyntaxNode::new_root(self.green.clone())
    }
}

pub fn parse_file(text: &str) -> Parse {
    let (tokens, diagnostics) = lex(text);
    let mut builder = GreenNodeBuilder::new();

    builder.start_node(SyntaxKind::File.into());

    for token in tokens {
        match token.kind {
            SyntaxKind::Eof => {
                // No explicit EOF token in the green tree.
            }
            SyntaxKind::Error => {
                builder.start_node(SyntaxKind::ErrorNode.into());
                token_into_builder(&mut builder, text, &token);
                builder.finish_node();
            }
            _ => token_into_builder(&mut builder, text, &token),
        }
    }

    builder.finish_node();

    Parse {
        green: builder.finish(),
        diagnostics,
    }
}

fn token_into_builder(builder: &mut GreenNodeBuilder<'_>, text: &str, token: &LexedToken) {
    let token_text = &text[token.span.start..token.span.end];
    builder.token(token.kind.into(), token_text);
}

impl From<SyntaxKind> for rowan::SyntaxKind {
    fn from(value: SyntaxKind) -> Self {
        rowan::SyntaxKind(value as u16)
    }
}
