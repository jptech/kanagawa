use crate::{SyntaxKind, SyntaxLanguage};

pub type SyntaxNode = rowan::SyntaxNode<SyntaxLanguage>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttachedDocComments {
    pub pre: Vec<String>,
    pub post: Vec<String>,
}

pub fn attached_doc_comments(node: &SyntaxNode) -> AttachedDocComments {
    AttachedDocComments {
        pre: leading_doc_comments_pre(node),
        post: trailing_doc_comments_post(node),
    }
}

pub fn leading_doc_comments_pre(node: &SyntaxNode) -> Vec<String> {
    let Some(mut tok) = node.first_token() else {
        return Vec::new();
    };

    let mut out_rev: Vec<String> = Vec::new();

    while let Some(prev) = tok.prev_token() {
        match prev.kind() {
            SyntaxKind::DocLineCommentPre => {
                out_rev.push(strip_doc_prefix(prev.text(), "//|"));
                tok = prev;
            }
            SyntaxKind::Whitespace => {
                // A blank line breaks attachment.
                if is_blank_line(prev.text()) {
                    break;
                }
                tok = prev;
            }
            SyntaxKind::RBracket => {
                // If attributes are between the docs and the node, skip them.
                if let Some(before_attrs) = skip_attr_blocks_backward(prev) {
                    tok = before_attrs;
                } else {
                    break;
                }
            }
            // Other trivia breaks attachment (regular comments shouldn't attach).
            _ => break,
        }
    }

    out_rev.reverse();
    out_rev
}

fn skip_attr_blocks_backward(
    tok: rowan::SyntaxToken<SyntaxLanguage>,
) -> Option<rowan::SyntaxToken<SyntaxLanguage>> {
    // Recognize one or more `[[ ... ]]` blocks by looking for ending `]]` and
    // scanning back to the corresponding opening `[[`.
    //
    // This is intentionally conservative: it only triggers on `]]` pairs.
    loop {
        // Require `]]`.
        let prev = tok.prev_token()?;
        if tok.kind() != SyntaxKind::RBracket || prev.kind() != SyntaxKind::RBracket {
            return Some(tok);
        }

        // Walk backward to find `[[`.
        let mut cur = prev;
        while let Some(p) = cur.prev_token() {
            if cur.kind() == SyntaxKind::LBracket && p.kind() == SyntaxKind::LBracket {
                // Return the token before the first '['.
                return p.prev_token().or(Some(p));
            }
            cur = p;
        }

        // If we couldn't find the opening, give up.
        return None;
    }
}

pub fn trailing_doc_comments_post(node: &SyntaxNode) -> Vec<String> {
    let Some(mut tok) = node.last_token() else {
        return Vec::new();
    };

    let mut out: Vec<String> = Vec::new();

    while let Some(next) = tok.next_token() {
        match next.kind() {
            SyntaxKind::DocLineCommentPost => {
                out.push(strip_doc_prefix(next.text(), "//<"));
                tok = next;
            }
            SyntaxKind::Whitespace => {
                if is_blank_line(next.text()) {
                    break;
                }
                tok = next;
            }
            // Stop if we hit another item/token.
            _ => break,
        }
    }

    out
}

fn strip_doc_prefix(text: &str, prefix: &str) -> String {
    let rest = text.strip_prefix(prefix).unwrap_or(text);
    rest.strip_prefix(' ')
        .unwrap_or(rest)
        .trim_end()
        .to_string()
}

fn is_blank_line(ws: &str) -> bool {
    // Treat two newlines (with optional CR) as a blank line separator.
    ws.contains("\n\n") || ws.contains("\r\n\r\n")
}
