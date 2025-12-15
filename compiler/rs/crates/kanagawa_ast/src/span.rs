//! Source span tracking for AST nodes.

use kanagawa_syntax::SyntaxNode;

/// A span representing a source location range.
///
/// This corresponds to the `Location` struct in the C ABI (`parse_tree.h`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Span {
    /// Starting byte offset in the source file.
    pub start: u32,
    /// Ending byte offset (exclusive) in the source file.
    pub end: u32,
    /// File index for multi-file compilations.
    pub file_index: u32,
}

impl Span {
    /// Create a new span from start and end byte offsets.
    pub fn new(start: u32, end: u32) -> Self {
        Self {
            start,
            end,
            file_index: 0,
        }
    }

    /// Create a span covering a CST node.
    pub fn from_node(node: &SyntaxNode) -> Self {
        let range = node.text_range();
        Self {
            start: range.start().into(),
            end: range.end().into(),
            file_index: 0,
        }
    }

    /// Create a span that covers both `self` and `other`.
    pub fn cover(self, other: Span) -> Self {
        Self {
            start: self.start.min(other.start),
            end: self.end.max(other.end),
            file_index: self.file_index,
        }
    }

    /// Check if this span is empty (zero-length).
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }
}
