use crate::syntax::SyntaxNode;
use crate::{lex, Diagnostic, LexedToken, SyntaxKind};
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

    let mut parser = Parser::new(text, tokens, diagnostics);
    parser.parse_file();
    parser.finish()
}

impl From<SyntaxKind> for rowan::SyntaxKind {
    fn from(value: SyntaxKind) -> Self {
        rowan::SyntaxKind(value as u16)
    }
}

struct Parser<'a> {
    text: &'a str,
    tokens: Vec<LexedToken>,
    pos: usize,
    builder: GreenNodeBuilder<'a>,
    diagnostics: Vec<Diagnostic>,
    /// Count of pending `>` tokens from split `>>` tokens.
    /// When closing a template with `>>`, we consume one `>` and increment this.
    /// The next template close consumes from this counter first.
    pending_gt_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FunctionAhead {
    Decl,
    Def,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SimpleSemiStmtClass {
    Expr,
    Assign,
    IncDec,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExprMode {
    Normal,
    TemplateArgRestricted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Assoc {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct InfixOp {
    kind: SyntaxKind,
    lbp: u8,
    assoc: Assoc,
}

fn binding_power_for_infix(mode: ExprMode, kind: SyntaxKind) -> Option<InfixOp> {
    // NOTE: Keep this conservative; fall back to token-preserving scanning for unknown forms.
    if mode == ExprMode::TemplateArgRestricted {
        // In template-arg restricted mode, disallow relational/shift operators at top level
        // to avoid consuming tokens needed to close `<...>` lists.
        if matches!(
            kind,
            SyntaxKind::Lt
                | SyntaxKind::Le
                | SyntaxKind::Gt
                | SyntaxKind::Ge
                | SyntaxKind::Shl
                | SyntaxKind::Shr
        ) {
            return None;
        }
    }

    let op = match kind {
        // Assignment (right-assoc)
        k if is_assignment_like_op(k) => InfixOp {
            kind: k,
            lbp: 1,
            assoc: Assoc::Right,
        },

        // Logical
        SyntaxKind::OrOr => InfixOp {
            kind,
            lbp: 3,
            assoc: Assoc::Left,
        },
        SyntaxKind::AndAnd => InfixOp {
            kind,
            lbp: 4,
            assoc: Assoc::Left,
        },

        // Bitwise
        SyntaxKind::Pipe => InfixOp {
            kind,
            lbp: 5,
            assoc: Assoc::Left,
        },
        SyntaxKind::Caret | SyntaxKind::XorXor => InfixOp {
            kind,
            lbp: 6,
            assoc: Assoc::Left,
        },
        SyntaxKind::Amp => InfixOp {
            kind,
            lbp: 7,
            assoc: Assoc::Left,
        },

        // Equality
        SyntaxKind::EqEq | SyntaxKind::NotEq => InfixOp {
            kind,
            lbp: 8,
            assoc: Assoc::Left,
        },

        // Relational
        SyntaxKind::Lt | SyntaxKind::Le | SyntaxKind::Gt | SyntaxKind::Ge => InfixOp {
            kind,
            lbp: 9,
            assoc: Assoc::Left,
        },

        // Shifts
        SyntaxKind::Shl | SyntaxKind::Shr => InfixOp {
            kind,
            lbp: 10,
            assoc: Assoc::Left,
        },

        // Additive/multiplicative
        SyntaxKind::Plus | SyntaxKind::Minus => InfixOp {
            kind,
            lbp: 11,
            assoc: Assoc::Left,
        },
        SyntaxKind::Star | SyntaxKind::Slash | SyntaxKind::Percent => InfixOp {
            kind,
            lbp: 12,
            assoc: Assoc::Left,
        },

        _ => return None,
    };

    Some(op)
}

fn is_decl_ident_like(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Ident
            | SyntaxKind::KwAuto
            | SyntaxKind::KwBool
            | SyntaxKind::KwFloat32
            | SyntaxKind::KwInt
            | SyntaxKind::KwString
            | SyntaxKind::KwUint
            | SyntaxKind::KwVoid
            | SyntaxKind::KwConst
            | SyntaxKind::KwTypename
            | SyntaxKind::KwDecltype
    )
}

fn is_assignment_like_op(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Eq
            | SyntaxKind::PlusEq
            | SyntaxKind::MinusEq
            | SyntaxKind::StarEq
            | SyntaxKind::SlashEq
            | SyntaxKind::PercentEq
            | SyntaxKind::ShlEq
            | SyntaxKind::ShrEq
            | SyntaxKind::AmpEq
            | SyntaxKind::PipeEq
            | SyntaxKind::CaretEq
            | SyntaxKind::AndAndEq
            | SyntaxKind::OrOrEq
    )
}

fn is_keyword_kind(kind: SyntaxKind) -> bool {
    kind >= SyntaxKind::KwAs && kind <= SyntaxKind::KwWhile
}

impl<'a> Parser<'a> {
    fn new(text: &'a str, tokens: Vec<LexedToken>, diagnostics: Vec<Diagnostic>) -> Self {
        Self {
            text,
            tokens,
            pos: 0,
            builder: GreenNodeBuilder::new(),
            diagnostics,
            pending_gt_count: 0,
        }
    }

    fn finish(self) -> Parse {
        Parse {
            green: self.builder.finish(),
            diagnostics: self.diagnostics,
        }
    }

    fn parse_file(&mut self) {
        self.builder.start_node(SyntaxKind::File.into());

        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            match self.current() {
                SyntaxKind::KwModule => self.parse_module_decl(),
                SyntaxKind::KwImport => self.parse_import_decl(),
                SyntaxKind::KwExtern => self.parse_extern_decl(),
                SyntaxKind::KwExport => self.parse_export_decl(),
                SyntaxKind::KwTemplate => self.parse_template_item(),
                SyntaxKind::KwClass => self.parse_class_item(),
                SyntaxKind::KwStruct => self.parse_struct_item(),
                SyntaxKind::KwEnum => self.parse_enum_item(),
                SyntaxKind::KwUnion => self.parse_union_item(),
                SyntaxKind::KwUsing => self.parse_using_item(),
                SyntaxKind::KwStaticAssert => self.parse_static_assert_decl(),
                SyntaxKind::KwStatic => {
                    if self.peek_next_nontrivia_kind(1) == Some(SyntaxKind::KwIf) {
                        self.parse_static_if_decl();
                    } else if self.peek_next_nontrivia_ident_text(1) == Some("assert") {
                        self.parse_static_assert_two_word_decl();
                    } else {
                        // Static variable declaration: `static type name = init;`
                        self.parse_static_var_decl();
                    }
                }
                SyntaxKind::KwConst => {
                    // `const type name = init;` - a global const declaration.
                    // Handle explicitly to avoid relying on limited lookahead for `;`.
                    self.parse_global_var_decl();
                }
                SyntaxKind::Error => self.wrap_error_token(),
                _ => {
                    // Shape-first: detect function/global-var declarations by looking for
                    // `name ( ... ) {` or `name ( ... ) ;` patterns.
                    if self.looks_like_function_ahead() {
                        self.parse_function_item();
                    } else if self.looks_like_global_var_ahead() {
                        self.parse_global_var_decl();
                    } else {
                        self.bump();
                    }
                }
            }
        }

        self.builder.finish_node();
    }

    fn parse_static_if_decl(&mut self) {
        self.builder.start_node(SyntaxKind::StaticIfDecl.into());

        self.expect(SyntaxKind::KwStatic);
        self.eat_trivia();
        self.expect(SyntaxKind::KwIf);
        self.eat_trivia();

        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after static if");
        }

        self.eat_trivia();
        self.parse_one_decl_like();

        self.eat_trivia();
        if self.at(SyntaxKind::KwElse) {
            self.bump();
            self.eat_trivia();
            self.parse_one_decl_like();
        }

        self.builder.finish_node();
    }

    fn parse_paren_expr_for_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::ParenExpr.into());

        if self.at(SyntaxKind::LParen) {
            self.bump();
        } else {
            self.builder.finish_node();
            return;
        }

        self.eat_trivia();
        if !self.at(SyntaxKind::RParen) && !self.at(SyntaxKind::Eof) {
            self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RParen]);
            self.eat_trivia();
        }

        if self.at(SyntaxKind::RParen) {
            self.bump();
        } else {
            // Recovery: scan to the closing paren without emitting diagnostics.
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                self.bump();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
        }

        self.builder.finish_node();
    }

    fn parse_one_decl_like(&mut self) {
        // Re-use the same top-level dispatch for nested `static if` arms.
        if self.at_double_lbracket() {
            self.parse_attr_seq_if_present();
            self.eat_trivia();
        }

        match self.current() {
            SyntaxKind::KwModule => self.parse_module_decl(),
            SyntaxKind::KwImport => self.parse_import_decl(),
            SyntaxKind::KwExtern => self.parse_extern_decl(),
            SyntaxKind::KwExport => self.parse_export_decl(),
            SyntaxKind::KwTemplate => self.parse_template_item(),
            SyntaxKind::KwStruct => self.parse_struct_item(),
            SyntaxKind::KwEnum => self.parse_enum_item(),
            SyntaxKind::KwUnion => self.parse_union_item(),
            SyntaxKind::KwUsing => self.parse_using_item(),
            SyntaxKind::KwStaticAssert => self.parse_static_assert_decl(),
            SyntaxKind::KwStatic => {
                if self.peek_next_nontrivia_kind(1) == Some(SyntaxKind::KwIf) {
                    self.parse_static_if_decl();
                } else if self.peek_next_nontrivia_ident_text(1) == Some("assert") {
                    self.parse_static_assert_two_word_decl();
                } else {
                    self.parse_static_var_decl();
                }
            }
            SyntaxKind::LBrace => {
                // Handle block FIRST, before looks_like_function_ahead() which would scan
                // past the block and incorrectly match declarations after it.
                self.builder.start_node(SyntaxKind::Block.into());
                self.consume_balanced_pair(SyntaxKind::LBrace, SyntaxKind::RBrace);
                self.builder.finish_node();
            }
            _ => {
                if self.looks_like_function_ahead() {
                    self.parse_function_item();
                } else if self.looks_like_global_var_ahead() {
                    self.parse_global_var_decl();
                } else {
                    self.consume_until_item_boundary();
                }
            }
        }
    }

    fn parse_global_var_decl(&mut self) {
        self.builder.start_node(SyntaxKind::GlobalVarDecl.into());
        self.parse_attr_seq_if_present();

        self.parse_var_decl_like_semicolon_terminated();

        self.builder.finish_node();
    }

    fn parse_var_decl_like_semicolon_terminated(&mut self) {
        self.eat_trivia();

        // Parse type.
        self.parse_type_or_fallback();
        self.eat_trivia();

        // Parse one or more declarators: `name [= expr]` separated by commas.
        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::Semi) || self.at(SyntaxKind::Eof) || self.at(SyntaxKind::RBrace)
            {
                break;
            }

            // Name.
            if self.at(SyntaxKind::Ident) {
                self.bump();
            } else {
                // Keep permissive; don't diagnose.
                self.bump();
            }

            self.eat_trivia();

            // Optional initializer.
            if self.at(SyntaxKind::Eq) {
                self.bump();
                self.eat_trivia();
                if self.at(SyntaxKind::LBrace) {
                    self.parse_initializer_list_expr(
                        ExprMode::Normal,
                        &[SyntaxKind::Comma, SyntaxKind::Semi],
                    );
                } else {
                    self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Comma, SyntaxKind::Semi]);
                }
            }

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }

        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
    }

    fn parse_function_item(&mut self) {
        let node_kind = match self.classify_function_ahead() {
            Some(FunctionAhead::Decl) => SyntaxKind::FunctionDecl,
            Some(FunctionAhead::Def) => SyntaxKind::FunctionDef,
            None => SyntaxKind::FunctionDecl,
        };

        self.builder.start_node(node_kind.into());
        self.parse_attr_seq_if_present();

        // Optional modifier.
        if self.at(SyntaxKind::KwInline) || self.at(SyntaxKind::KwNoinline) {
            self.bump();
            self.eat_trivia();
        }

        // Return type (structured, but permissive).
        self.parse_type_or_fallback();
        self.eat_trivia();

        // Function name.
        if self.at(SyntaxKind::Ident) {
            self.bump();
        } else {
            // Preserve progress; don't diagnose.
            self.bump();
        }
        self.eat_trivia();

        // Parameters.
        if self.at(SyntaxKind::LParen) {
            self.parse_func_params_structured();
        } else if self.at(SyntaxKind::Semi) || self.at(SyntaxKind::LBrace) {
            // ok
        } else {
            // Preserve tokens until we reach a plausible boundary.
            while !self.at(SyntaxKind::Eof)
                && !self.at(SyntaxKind::LParen)
                && !self.at(SyntaxKind::Semi)
                && !self.at(SyntaxKind::LBrace)
            {
                self.bump();
            }
            if self.at(SyntaxKind::LParen) {
                self.parse_func_params_structured();
            }
        }

        self.eat_trivia_excluding_post_doc();

        if self.at(SyntaxKind::LBrace) {
            self.parse_block();
        } else if self.at(SyntaxKind::Semi) {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_func_params_structured(&mut self) {
        self.builder.start_node(SyntaxKind::FuncParams.into());
        if self.at(SyntaxKind::LParen) {
            self.bump();
        } else {
            self.builder.finish_node();
            return;
        }

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RParen) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.builder
                .start_node(SyntaxKind::TypeFunctionParam.into());

            // Optional attributes in front of the param.
            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                self.eat_trivia();
            }

            self.parse_type_or_fallback();
            self.eat_trivia();

            // Optional name.
            if self.at(SyntaxKind::Ident) {
                self.bump();
                self.eat_trivia();
            }

            // Optional default value.
            if self.at(SyntaxKind::Eq) {
                self.bump();
                self.eat_trivia();
                // Parse default expression properly
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Comma, SyntaxKind::RParen]);
                self.eat_trivia();
            }

            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }

        if self.at(SyntaxKind::RParen) {
            self.bump();
        } else {
            // Recovery: scan forward to `)` or a plausible boundary, without diagnostics.
            while !self.at(SyntaxKind::Eof)
                && !self.at(SyntaxKind::RParen)
                && !self.at(SyntaxKind::Semi)
                && !self.at(SyntaxKind::LBrace)
            {
                self.bump();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
        }
        self.builder.finish_node();
    }

    fn consume_until_comma_or_rparen_balanced(&mut self) {
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            // Allow expression-level attributes.
            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            // Preserve initializer list structure.
            if self.at(SyntaxKind::LBrace) {
                self.parse_initializer_list_expr(
                    ExprMode::Normal,
                    &[SyntaxKind::Comma, SyntaxKind::RParen],
                );
                continue;
            }

            match self.current() {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => {
                    if paren == 0 && bracket == 0 && brace == 0 && angle == 0 {
                        break;
                    }
                    paren = paren.saturating_sub(1)
                }
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.at_template_lt() => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                SyntaxKind::Comma if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                    break
                }
                _ => {}
            }
            self.bump();
        }
    }

    fn parse_type_or_fallback(&mut self) {
        if self.try_parse_type() {
            return;
        }
        // Keep permissive: consume a token so we don't loop.
        if !self.at(SyntaxKind::Eof) {
            self.bump();
        }
    }

    fn try_parse_type(&mut self) -> bool {
        // Very lightweight entry conditions.
        if self.at(SyntaxKind::Eof) {
            return false;
        }
        if self.at(SyntaxKind::Semi) || self.at(SyntaxKind::Comma) {
            return false;
        }

        self.builder.start_node(SyntaxKind::Type.into());

        // Optional leading attributes (type attributes).
        if self.at_double_lbracket() {
            self.parse_attr_seq_if_present();
            self.eat_trivia();
        }

        // Prefixes.
        if self.at(SyntaxKind::KwConst) {
            self.builder.start_node(SyntaxKind::TypeConst.into());
            self.bump();
            self.eat_trivia();
            let _ = self.try_parse_type();
            self.builder.finish_node();
            self.builder.finish_node();
            return true;
        }

        if self.at(SyntaxKind::KwTypename) {
            self.builder.start_node(SyntaxKind::TypeTypename.into());
            self.bump();
            self.eat_trivia();
            let _ = self.try_parse_type_path();
            self.builder.finish_node();
            self.builder.finish_node();
            return true;
        }

        if self.at(SyntaxKind::KwDecltype) {
            self.builder.start_node(SyntaxKind::TypeDecltype.into());
            self.bump();
            self.eat_trivia();
            if self.at(SyntaxKind::LParen) {
                // Structured: `decltype(<expr>)`
                self.parse_paren_expr_for_stmt();
            }
            self.builder.finish_node();
            self.builder.finish_node();
            return true;
        }

        // Function types: `(params) -> T`
        if self.looks_like_function_type_ahead() {
            self.parse_function_type();
            self.builder.finish_node();
            return true;
        }

        // Path-ish types: `Foo::Bar<T>`.
        // Save checkpoint before base type for potential array wrapping.
        let base_checkpoint = self.builder.checkpoint();
        let parsed_path = self.try_parse_type_path();

        // If we couldn't parse a type path, we haven't consumed any tokens,
        // so we should return false to prevent infinite loops.
        if !parsed_path {
            self.builder.finish_node();
            return false;
        }

        // Array suffix: `T[N][M]`.
        if self.at(SyntaxKind::LBracket) {
            self.parse_array_type_suffixes_at(base_checkpoint);
        }

        self.builder.finish_node();
        true
    }

    fn looks_like_function_type_ahead(&self) -> bool {
        if self.current() != SyntaxKind::LParen {
            return false;
        }

        // Look for `) ->` at top-level nesting.
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        for i in 0..512 {
            let idx = self.pos + i;
            let Some(t) = self.tokens.get(idx) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }
            match t.kind {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => {
                    paren = paren.saturating_sub(1);
                    if paren == 0 {
                        // Check for `->`.
                        let Some(next_idx) = self.next_nontrivia_index(idx + 1) else {
                            break;
                        };
                        if self
                            .tokens
                            .get(next_idx)
                            .is_some_and(|x| x.kind == SyntaxKind::Arrow)
                        {
                            return true;
                        }
                        break;
                    }
                }
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.is_template_lt_at(idx) => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                _ => {}
            }

            if bracket != 0 || brace != 0 || angle != 0 {
                continue;
            }
        }

        false
    }

    fn parse_function_type(&mut self) {
        self.builder.start_node(SyntaxKind::TypeFunction.into());

        self.builder
            .start_node(SyntaxKind::TypeFunctionParams.into());
        if self.at(SyntaxKind::LParen) {
            self.bump();
        }
        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RParen) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.builder
                .start_node(SyntaxKind::TypeFunctionParam.into());
            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                self.eat_trivia();
            }

            let _ = self.try_parse_type();
            self.eat_trivia();
            // Optional param name.
            if self.at(SyntaxKind::Ident) {
                self.bump();
            }
            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }
        if self.at(SyntaxKind::RParen) {
            self.bump();
        } else {
            // Recovery: scan forward to `)` without emitting diagnostics.
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                self.bump();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
        }
        self.builder.finish_node();

        self.eat_trivia();
        if self.at(SyntaxKind::Arrow) {
            self.bump();
            self.eat_trivia();
            let _ = self.try_parse_type();
        }

        self.builder.finish_node();
    }

    fn try_parse_type_path(&mut self) -> bool {
        self.builder.start_node(SyntaxKind::TypePath.into());

        // Parse at least one segment.
        if !self.try_parse_type_path_segment() {
            self.builder.finish_node();
            return false;
        }

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::Scope) {
                self.bump();
                self.eat_trivia();
                let _ = self.try_parse_type_path_segment();
                continue;
            }
            break;
        }

        self.builder.finish_node();
        true
    }

    fn try_parse_type_path_segment(&mut self) -> bool {
        self.builder.start_node(SyntaxKind::TypePathSegment.into());

        // Dependent template disambiguator.
        if self.at(SyntaxKind::KwTemplate) {
            self.bump();
            self.eat_trivia();
        }

        let k = self.current();
        if k == SyntaxKind::Ident || is_keyword_kind(k) {
            self.bump();
        } else {
            self.builder.finish_node();
            return false;
        }

        // Optional template args.
        self.eat_trivia();
        if self.at(SyntaxKind::Lt) {
            self.parse_type_template_args();
        }

        self.builder.finish_node();
        true
    }

    fn parse_type_template_args(&mut self) {
        self.builder.start_node(SyntaxKind::TypeTemplateArgs.into());

        if self.at(SyntaxKind::Lt) {
            self.bump();
        } else {
            self.builder.finish_node();
            return;
        }

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::Gt) || self.at(SyntaxKind::Shr) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.builder.start_node(SyntaxKind::TypeTemplateArg.into());
            // Try type first when it plausibly starts a type. If type parsing fails
            // (returns false), fall back to expression parsing.
            let parsed_as_type = if self.looks_like_type_start() {
                self.try_parse_type()
            } else {
                false
            };

            // If we couldn't parse as a type, try as an expression.
            // This handles cases like `(expr)` which looks_like_type_start but isn't a type.
            if !parsed_as_type {
                self.parse_expr_node(
                    ExprMode::TemplateArgRestricted,
                    &[SyntaxKind::Comma, SyntaxKind::Gt, SyntaxKind::Shr],
                );
            }
            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }

        // Close: accept `>` or `>>` as a close, handling `>>` splitting for nested templates.
        self.close_template_bracket();

        self.builder.finish_node();
    }

    /// Close a template argument list with `>`, handling `>>` token splitting.
    /// For nested templates like `Foo<Bar<T>>`, the `>>` token needs to close both.
    fn close_template_bracket(&mut self) {
        // First check if we have a pending `>` from a previous `>>` split.
        // In that case, the token was already emitted, we just need to record that
        // the outer template is closed.
        if self.pending_gt_count > 0 {
            self.pending_gt_count -= 1;
            return;
        }

        // If we have a `>`, consume it normally.
        if self.at(SyntaxKind::Gt) {
            self.bump();
            return;
        }

        // If we have `>>`, we need to split it: emit the token but record that
        // another `>` is available for an outer template close.
        if self.at(SyntaxKind::Shr) {
            self.bump();
            self.pending_gt_count += 1;
            return;
        }

        // Recovery: scan forward to a reasonable boundary.
        while !self.at(SyntaxKind::Eof)
            && !self.at(SyntaxKind::Gt)
            && !self.at(SyntaxKind::Shr)
            && !self.at(SyntaxKind::Comma)
            && !self.at(SyntaxKind::RParen)
            && !self.at(SyntaxKind::RBracket)
            && !self.at(SyntaxKind::RBrace)
            && !self.at(SyntaxKind::Semi)
        {
            self.bump();
        }
        if self.at(SyntaxKind::Gt) {
            self.bump();
        } else if self.at(SyntaxKind::Shr) {
            self.bump();
            self.pending_gt_count += 1;
        }
    }

    fn parse_array_type_suffixes_at(&mut self, checkpoint: rowan::Checkpoint) {
        // Wrap the base type + suffixes using the provided checkpoint.
        self.builder
            .start_node_at(checkpoint, SyntaxKind::TypeArray.into());

        while self.at(SyntaxKind::LBracket) {
            self.builder.start_node(SyntaxKind::TypeArrayDim.into());
            self.bump(); // consume '['
            self.eat_trivia();
            // Parse dimension expression if present (not empty brackets)
            if !self.at(SyntaxKind::RBracket) {
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RBracket]);
                self.eat_trivia();
            }
            if self.at(SyntaxKind::RBracket) {
                self.bump();
            }
            self.builder.finish_node();
            self.eat_trivia();
        }

        self.builder.finish_node();
    }

    fn parse_block(&mut self) {
        self.builder.start_node(SyntaxKind::Block.into());
        self.expect(SyntaxKind::LBrace);

        self.builder.start_node(SyntaxKind::StmtList.into());
        while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBrace) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            self.parse_stmt_or_decl();
        }
        self.builder.finish_node();

        self.expect(SyntaxKind::RBrace);
        self.builder.finish_node();
    }

    fn parse_stmt_or_decl(&mut self) {
        if self.at_double_lbracket() {
            self.builder.start_node(SyntaxKind::AnnotatedStmt.into());
            self.parse_attr_seq_if_present();
            self.eat_trivia();
            self.parse_stmt_or_decl_core();
            self.builder.finish_node();
        } else {
            self.parse_stmt_or_decl_core();
        }
    }

    fn parse_stmt_or_decl_core(&mut self) {
        match self.current() {
            // Declarations are allowed in blocks (e.g. local classes/structs/unions/enums).
            SyntaxKind::KwTemplate if self.peek_next_nontrivia_kind(1) == Some(SyntaxKind::Lt) => {
                // Only treat `template <...> ...` as a declaration. `template Foo<...>(...)` can
                // also appear as an expression (dependent-name disambiguator).
                self.parse_template_item()
            }
            SyntaxKind::KwUsing => self.parse_using_item(),
            SyntaxKind::KwClass => self.parse_class_item(),
            SyntaxKind::KwStruct => self.parse_struct_item(),
            SyntaxKind::KwEnum => self.parse_enum_item(),
            SyntaxKind::KwUnion => self.parse_union_item(),
            SyntaxKind::KwStaticAssert => self.parse_static_assert_decl(),
            SyntaxKind::KwStatic => match self.peek_next_nontrivia_kind(1) {
                Some(SyntaxKind::Ident)
                    if self.peek_next_nontrivia_ident_text(1) == Some("assert") =>
                {
                    self.parse_static_assert_two_word_decl();
                }
                Some(SyntaxKind::KwIf) => self.parse_static_if_stmt(),
                Some(SyntaxKind::KwFor) => self.parse_static_for_stmt(),
                Some(SyntaxKind::KwDefault) => self.parse_static_default_init_stmt(),
                _ if self.looks_like_static_var_decl_ahead() => self.parse_static_var_decl(),
                _ => self.parse_statement(),
            },
            // Local function definitions are allowed inside blocks.
            _ if self.looks_like_braced_function_def_ahead() => self.parse_function_item(),
            _ if self.looks_like_local_var_decl_ahead() => self.parse_local_var_decl(),
            _ => self.parse_statement(),
        }
    }

    fn parse_statement(&mut self) {
        if self.at_double_lbracket() {
            self.builder.start_node(SyntaxKind::AnnotatedStmt.into());
            self.parse_attr_seq_if_present();
            self.eat_trivia();
            self.parse_statement_core();
            self.builder.finish_node();
        } else {
            self.parse_statement_core();
        }
    }

    fn parse_statement_core(&mut self) {
        match self.current() {
            SyntaxKind::Semi => {
                // Empty statement.
                self.bump();
            }
            SyntaxKind::LBrace => {
                // Nested scope.
                self.parse_block();
            }
            SyntaxKind::KwReturn => self.parse_return_stmt(),
            SyntaxKind::KwIf => self.parse_if_stmt(),
            SyntaxKind::KwSwitch => self.parse_switch_stmt(),
            SyntaxKind::KwDo => self.parse_do_while_stmt(),
            SyntaxKind::KwFor => self.parse_range_for_stmt(),
            SyntaxKind::KwUnrolledFor => self.parse_unrolled_for_stmt(),
            SyntaxKind::KwStatic => match self.peek_next_nontrivia_kind(1) {
                Some(SyntaxKind::KwIf) => self.parse_static_if_stmt(),
                Some(SyntaxKind::KwFor) => self.parse_static_for_stmt(),
                _ => self.parse_expr_stmt(),
            },
            SyntaxKind::KwBreak => self.parse_break_stmt(),
            SyntaxKind::KwBarrier => self.parse_barrier_stmt(),
            SyntaxKind::KwReorder => self.parse_reorder_stmt(),
            SyntaxKind::KwAtomic => self.parse_atomic_stmt(),
            SyntaxKind::PlusPlus | SyntaxKind::MinusMinus => self.parse_inc_dec_stmt(),
            _ => match self.classify_simple_semi_stmt(256) {
                Some(SimpleSemiStmtClass::Assign) => self.parse_assign_stmt(),
                Some(SimpleSemiStmtClass::IncDec) => self.parse_inc_dec_stmt(),
                _ => self.parse_expr_stmt(),
            },
        }
    }

    fn parse_return_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::ReturnStmt.into());
        self.expect(SyntaxKind::KwReturn);
        self.eat_trivia();
        if !self.at(SyntaxKind::Semi) && !self.at(SyntaxKind::Eof) {
            self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Semi]);
        }
        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn parse_break_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::BreakStmt.into());
        self.expect(SyntaxKind::KwBreak);
        self.consume_until_semi_balanced();
        self.builder.finish_node();
    }

    fn parse_barrier_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::BarrierStmt.into());
        self.expect(SyntaxKind::KwBarrier);
        self.consume_until_semi_balanced();
        self.builder.finish_node();
    }

    fn parse_reorder_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::ReorderStmt.into());
        self.expect(SyntaxKind::KwReorder);
        self.eat_trivia();
        self.parse_statement();
        self.builder.finish_node();
    }

    fn parse_atomic_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::AtomicStmt.into());
        self.expect(SyntaxKind::KwAtomic);
        self.eat_trivia();
        self.parse_statement();
        self.builder.finish_node();
    }

    fn parse_if_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::IfStmt.into());
        self.expect(SyntaxKind::KwIf);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after if");
        }
        self.eat_trivia();
        self.parse_statement();
        self.eat_trivia();
        if self.at(SyntaxKind::KwElse) {
            self.bump();
            self.eat_trivia();
            self.parse_statement();
        }
        self.builder.finish_node();
    }

    fn parse_static_if_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::StaticIfStmt.into());
        self.expect(SyntaxKind::KwStatic);
        self.eat_trivia();
        self.expect(SyntaxKind::KwIf);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after static if");
        }
        self.eat_trivia();
        self.parse_stmt_or_decl();
        self.eat_trivia();
        if self.at(SyntaxKind::KwElse) {
            self.bump();
            self.eat_trivia();
            self.parse_stmt_or_decl();
        }
        self.builder.finish_node();
    }

    fn parse_static_for_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::StaticForStmt.into());
        self.expect(SyntaxKind::KwStatic);
        self.eat_trivia();
        self.expect(SyntaxKind::KwFor);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_range_for_header_parens();
        } else {
            self.error_here("Expected '(' after static for");
        }
        self.eat_trivia();
        self.parse_statement();
        self.builder.finish_node();
    }

    fn parse_unrolled_for_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::UnrolledForStmt.into());
        self.expect(SyntaxKind::KwUnrolledFor);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_range_for_header_parens();
        } else {
            self.error_here("Expected '(' after unrolled_for");
        }
        self.eat_trivia();
        self.parse_statement();
        self.builder.finish_node();
    }

    fn parse_range_for_header_parens(&mut self) {
        // Parse `(type name : expr)` with a structured `Type` and an `Expr` for the range.
        // Keep the left side permissive to avoid diagnostics.
        self.builder.start_node(SyntaxKind::ParenExpr.into());

        if self.at(SyntaxKind::LParen) {
            self.bump();
        } else {
            self.builder.finish_node();
            return;
        }

        self.eat_trivia();

        // LHS: typically `const uint32 i`, but keep permissive.
        self.parse_type_or_fallback();
        self.eat_trivia();
        if self.at(SyntaxKind::Ident) {
            self.bump();
            self.eat_trivia();
        }

        // Seek ':' at top level inside the parens.
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;
        while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            match self.current() {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => {
                    if paren == 0 && bracket == 0 && brace == 0 && angle == 0 {
                        break;
                    }
                    paren = paren.saturating_sub(1)
                }
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.at_template_lt() => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                SyntaxKind::Colon if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                    self.bump();
                    self.eat_trivia();
                    self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RParen]);
                    self.eat_trivia();
                    break;
                }
                _ => {}
            }

            self.bump();
        }

        if self.at(SyntaxKind::RParen) {
            self.bump();
        } else {
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                self.bump();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
        }

        self.builder.finish_node();
    }

    fn parse_do_while_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::DoWhileStmt.into());
        self.expect(SyntaxKind::KwDo);
        self.eat_trivia();
        self.parse_statement();
        self.eat_trivia();
        self.expect(SyntaxKind::KwWhile);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after while");
        }
        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn parse_range_for_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::RangeForStmt.into());
        self.expect(SyntaxKind::KwFor);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_range_for_header_parens();
        } else {
            self.error_here("Expected '(' after for");
        }
        self.eat_trivia();
        self.parse_statement();
        self.builder.finish_node();
    }

    fn parse_switch_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::SwitchStmt.into());
        self.expect(SyntaxKind::KwSwitch);
        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after switch");
        }
        self.eat_trivia();

        if self.at(SyntaxKind::LBrace) {
            self.expect(SyntaxKind::LBrace);
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBrace) {
                if self.current().is_trivia() {
                    self.bump();
                    continue;
                }

                match self.current() {
                    SyntaxKind::KwCase => {
                        self.builder.start_node(SyntaxKind::CaseLabel.into());
                        self.bump();
                        self.eat_trivia();
                        self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Colon]);
                        self.eat_trivia();
                        if self.at(SyntaxKind::Colon) {
                            self.bump();
                        } else {
                            while !self.at(SyntaxKind::Eof)
                                && !self.at(SyntaxKind::Colon)
                                && !self.at(SyntaxKind::RBrace)
                            {
                                self.bump();
                            }
                            if self.at(SyntaxKind::Colon) {
                                self.bump();
                            }
                        }
                        self.builder.finish_node();
                    }
                    SyntaxKind::KwDefault => {
                        self.builder.start_node(SyntaxKind::DefaultLabel.into());
                        self.bump();
                        if self.at(SyntaxKind::Colon) {
                            self.bump();
                        }
                        self.builder.finish_node();
                    }
                    _ => self.parse_stmt_or_decl(),
                }
            }
            self.expect(SyntaxKind::RBrace);
        } else {
            // Not a braced switch body; preserve.
            self.parse_statement();
        }

        self.builder.finish_node();
    }

    fn parse_expr_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::ExprStmt.into());
        self.eat_trivia();
        if !self.at(SyntaxKind::Semi) && !self.at(SyntaxKind::Eof) {
            self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Semi]);
        }
        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn parse_inc_dec_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::IncDecStmt.into());
        self.eat_trivia();
        if !self.at(SyntaxKind::Semi) && !self.at(SyntaxKind::Eof) {
            self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Semi]);
        }
        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn parse_assign_stmt(&mut self) {
        self.builder.start_node(SyntaxKind::AssignStmt.into());
        self.eat_trivia();
        if !self.at(SyntaxKind::Semi) && !self.at(SyntaxKind::Eof) {
            self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Semi]);
        }
        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn consume_trailing_semi_or_recover(&mut self) {
        if self.at(SyntaxKind::Semi) {
            self.bump();
            return;
        }

        // Recovery: scan forward to ';' or a likely statement boundary.
        while !self.at(SyntaxKind::Eof)
            && !self.at(SyntaxKind::Semi)
            && !self.at(SyntaxKind::RBrace)
            && !self.at(SyntaxKind::KwElse)
        {
            if self.at(SyntaxKind::LBrace) {
                self.parse_initializer_list_expr(ExprMode::Normal, &[SyntaxKind::Semi]);
                continue;
            }
            self.bump();
        }
        if self.at(SyntaxKind::Semi) {
            self.bump();
        }
    }

    fn looks_like_type_start(&self) -> bool {
        matches!(
            self.current(),
            SyntaxKind::Ident
                | SyntaxKind::KwAuto
                | SyntaxKind::KwBool
                | SyntaxKind::KwFloat32
                | SyntaxKind::KwInt
                | SyntaxKind::KwString
                | SyntaxKind::KwUint
                | SyntaxKind::KwVoid
                | SyntaxKind::KwConst
                | SyntaxKind::KwTypename
                | SyntaxKind::KwDecltype
                | SyntaxKind::LParen
        )
    }

    fn parse_expr_node(&mut self, mode: ExprMode, terminators: &[SyntaxKind]) {
        let checkpoint = self.builder.checkpoint();
        self.builder
            .start_node_at(checkpoint, SyntaxKind::Expr.into());

        let start_pos = self.pos;
        self.parse_expr_bp(mode, 0, terminators);

        // Ensure forward progress.
        if self.pos == start_pos
            && !self.at(SyntaxKind::Eof)
            && !terminators.contains(&self.current())
        {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_expr_bp(&mut self, mode: ExprMode, min_bp: u8, terminators: &[SyntaxKind]) {
        self.eat_trivia();

        // Expression-level attributes can prefix expressions.
        while self.at_double_lbracket() {
            self.parse_attr_seq_if_present();
            self.eat_trivia();
        }

        let checkpoint = self.builder.checkpoint();
        if !self.parse_prefix_expr(mode, terminators) {
            return;
        }

        self.parse_postfix_chain(checkpoint, terminators);

        loop {
            self.eat_trivia();

            let k = self.current();
            if terminators.contains(&k) {
                break;
            }

            if k == SyntaxKind::Question {
                // Conditional operator: `cond ? then : else`.
                if 2 < min_bp {
                    break;
                }

                self.builder
                    .start_node_at(checkpoint, SyntaxKind::TernaryExpr.into());
                self.bump();
                self.eat_trivia();

                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Colon]);
                self.eat_trivia();
                if self.at(SyntaxKind::Colon) {
                    self.bump();
                } else {
                    // Recovery: preserve until ':' or boundary.
                    while !self.at(SyntaxKind::Eof)
                        && !self.at(SyntaxKind::Colon)
                        && !terminators.contains(&self.current())
                    {
                        self.bump();
                    }
                    if self.at(SyntaxKind::Colon) {
                        self.bump();
                    }
                }

                self.eat_trivia();
                self.parse_expr_node(mode, terminators);
                self.builder.finish_node();

                self.parse_postfix_chain(checkpoint, terminators);
                continue;
            }

            let Some(op) = binding_power_for_infix(mode, k) else {
                break;
            };

            if op.lbp < min_bp {
                break;
            }

            let node_kind = if is_assignment_like_op(op.kind) {
                SyntaxKind::AssignExpr
            } else {
                SyntaxKind::BinaryExpr
            };

            self.builder.start_node_at(checkpoint, node_kind.into());
            self.bump();
            let next_min_bp = match op.assoc {
                Assoc::Left => op.lbp + 1,
                Assoc::Right => op.lbp,
            };
            self.parse_expr_bp(mode, next_min_bp, terminators);
            self.builder.finish_node();

            self.parse_postfix_chain(checkpoint, terminators);
        }
    }

    fn parse_prefix_expr(&mut self, mode: ExprMode, terminators: &[SyntaxKind]) -> bool {
        self.eat_trivia();

        if self.at(SyntaxKind::LBracket) {
            if self.try_parse_lambda_expr() {
                return true;
            }
        }

        match self.current() {
            SyntaxKind::Plus
            | SyntaxKind::Minus
            | SyntaxKind::Not
            | SyntaxKind::Tilde
            | SyntaxKind::PlusPlus
            | SyntaxKind::MinusMinus => {
                let checkpoint = self.builder.checkpoint();
                self.builder
                    .start_node_at(checkpoint, SyntaxKind::UnaryExpr.into());
                self.bump();
                self.parse_expr_bp(mode, 13, terminators);
                self.builder.finish_node();
                true
            }
            SyntaxKind::KwCast => {
                self.parse_cast_expr(terminators);
                true
            }
            SyntaxKind::KwBitoffsetof | SyntaxKind::KwByteoffsetof => {
                let kind = self.current();
                self.parse_offsetof_call_expr(kind);
                true
            }
            SyntaxKind::KwBitsizeof | SyntaxKind::KwBytesizeof => {
                self.parse_sizeof_expr(terminators);
                true
            }
            _ => self.parse_primary_expr(mode, terminators),
        }
    }

    fn parse_offsetof_call_expr(&mut self, kw: SyntaxKind) {
        // Parse `bitoffsetof(Type, field)` / `byteoffsetof(Type, field)`.
        // Canonically this takes a type + identifier; emit a structured `Type` for the first
        // argument to keep the CST shape stable and useful.
        let checkpoint = self.builder.checkpoint();
        self.builder
            .start_node_at(checkpoint, SyntaxKind::CallExpr.into());

        self.bump();
        self.eat_trivia();

        self.builder.start_node(SyntaxKind::ArgList.into());
        if self.at(SyntaxKind::LParen) {
            self.bump();
        }

        self.eat_trivia();
        if !self.at(SyntaxKind::RParen) && !self.at(SyntaxKind::Eof) {
            self.parse_type_or_fallback();
            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                self.eat_trivia();
            }

            // Second argument: field identifier (keep permissive; allow keywords too).
            if self.at(SyntaxKind::Ident) || is_keyword_kind(self.current()) {
                self.parse_ident_or_qualified_expr();
            } else if !self.at(SyntaxKind::RParen) && !self.at(SyntaxKind::Eof) {
                self.bump();
            }

            // Optional extra args: keep permissive and parse as expressions.
            loop {
                self.eat_trivia();
                if self.at(SyntaxKind::Comma) {
                    self.bump();
                    self.eat_trivia();
                    if self.at(SyntaxKind::RParen) || self.at(SyntaxKind::Eof) {
                        break;
                    }
                    self.parse_expr_node(
                        ExprMode::Normal,
                        &[SyntaxKind::Comma, SyntaxKind::RParen],
                    );
                    continue;
                }
                break;
            }
        }

        if self.at(SyntaxKind::RParen) {
            self.bump();
        } else {
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                self.bump();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
        }

        self.builder.finish_node();
        self.builder.finish_node();

        // Silence unused-variable lint if we ever extend this to share impl.
        let _ = kw;
    }

    fn parse_sizeof_expr(&mut self, terminators: &[SyntaxKind]) {
        // Parse `bitsizeof T`, `bitsizeof(T)`, `bitsizeof expr`, `bitsizeof(expr)`.
        // Similarly for `bytesizeof`.
        // The argument can be either a type or an expression.
        let checkpoint = self.builder.checkpoint();
        self.builder
            .start_node_at(checkpoint, SyntaxKind::UnaryExpr.into());

        self.bump(); // consume 'bitsizeof' or 'bytesizeof'
        self.eat_trivia();

        // Check for parenthesized form
        if self.at(SyntaxKind::LParen) {
            // Could be `sizeof(Type)` or `sizeof(expr)`.
            // Parse as a parenthesized expression which will handle either case.
            self.builder.start_node(SyntaxKind::ParenExpr.into());
            self.bump(); // consume '('
            self.eat_trivia();
            if !self.at(SyntaxKind::RParen) {
                // Try parsing as type first, fall back to expression
                if self.looks_like_type_start() {
                    let parsed_type = self.try_parse_type();
                    if !parsed_type {
                        self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RParen]);
                    }
                } else {
                    self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RParen]);
                }
                self.eat_trivia();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
            self.builder.finish_node(); // ParenExpr
        } else {
            // Non-parenthesized: `sizeof T` or `sizeof expr`.
            // Try parsing as type if it looks like one, otherwise expression.
            if self.looks_like_type_start() {
                let parsed_type = self.try_parse_type();
                if !parsed_type {
                    // Fall back to expression parsing with high precedence
                    self.parse_expr_bp(ExprMode::Normal, 13, terminators);
                }
            } else {
                // Parse as expression with high precedence (tighter than most operators)
                self.parse_expr_bp(ExprMode::Normal, 13, terminators);
            }
        }

        self.builder.finish_node(); // UnaryExpr
    }

    fn parse_primary_expr(&mut self, mode: ExprMode, terminators: &[SyntaxKind]) -> bool {
        self.eat_trivia();
        if self.at(SyntaxKind::Eof) {
            return false;
        }
        if terminators.contains(&self.current()) {
            return false;
        }

        match self.current() {
            SyntaxKind::LParen => {
                self.builder.start_node(SyntaxKind::ParenExpr.into());
                self.bump();
                self.eat_trivia();
                if !self.at(SyntaxKind::RParen) {
                    self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RParen]);
                    self.eat_trivia();
                }
                if self.at(SyntaxKind::RParen) {
                    self.bump();
                } else {
                    while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                        self.bump();
                    }
                    if self.at(SyntaxKind::RParen) {
                        self.bump();
                    }
                }
                self.builder.finish_node();
                true
            }
            SyntaxKind::LBrace => {
                self.parse_initializer_list_expr(mode, terminators);
                true
            }
            SyntaxKind::IntDec
            | SyntaxKind::IntHex
            | SyntaxKind::IntBin
            | SyntaxKind::IntOct
            | SyntaxKind::Float
            | SyntaxKind::Char
            | SyntaxKind::KwTrue
            | SyntaxKind::KwFalse => {
                self.builder.start_node(SyntaxKind::LiteralExpr.into());
                self.bump();
                self.builder.finish_node();
                true
            }
            SyntaxKind::String => {
                // Expanded into a subtree during `bump()`.
                self.bump();
                true
            }
            SyntaxKind::Ident => {
                self.parse_ident_or_qualified_expr();
                true
            }
            k if is_keyword_kind(k) => {
                self.parse_ident_or_qualified_expr();
                true
            }
            _ => false,
        }
    }

    fn parse_ident_or_qualified_expr(&mut self) {
        let checkpoint = self.builder.checkpoint();

        self.bump();
        self.eat_trivia();
        if self.at(SyntaxKind::Lt) && self.at_template_lt() {
            // In expression position, parsing template args type-first can get expensive on large
            // corpora. Keep this as Expr-only (restricted) while still preserving structure.
            self.parse_expr_template_args();
            self.eat_trivia();
        }

        if self.at(SyntaxKind::Scope) {
            self.builder
                .start_node_at(checkpoint, SyntaxKind::QualifiedIdentExpr.into());
            while self.at(SyntaxKind::Scope) {
                self.bump();
                self.eat_trivia();
                if self.at(SyntaxKind::Ident) || is_keyword_kind(self.current()) {
                    self.bump();
                    self.eat_trivia();
                    if self.at(SyntaxKind::Lt) && self.at_template_lt() {
                        self.parse_expr_template_args();
                        self.eat_trivia();
                    }
                } else {
                    break;
                }
            }
            self.builder.finish_node();
        } else {
            self.builder
                .start_node_at(checkpoint, SyntaxKind::IdentExpr.into());
            self.builder.finish_node();
        }
    }

    fn parse_expr_template_args(&mut self) {
        // Parse `<arg, ...>` as a structured subtree, treating all arguments as expressions in
        // restricted mode (so `<`/`>` operators don't consume the whole parse).
        self.builder.start_node(SyntaxKind::TypeTemplateArgs.into());

        if self.at(SyntaxKind::Lt) {
            self.bump();
        } else {
            self.builder.finish_node();
            return;
        }

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::Gt) || self.at(SyntaxKind::Shr) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.builder.start_node(SyntaxKind::TypeTemplateArg.into());
            self.parse_expr_node(
                ExprMode::TemplateArgRestricted,
                &[SyntaxKind::Comma, SyntaxKind::Gt, SyntaxKind::Shr],
            );
            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }

        if self.at(SyntaxKind::Gt) || self.at(SyntaxKind::Shr) {
            self.bump();
        } else {
            while !self.at(SyntaxKind::Eof)
                && !self.at(SyntaxKind::Gt)
                && !self.at(SyntaxKind::Shr)
                && !self.at(SyntaxKind::RParen)
                && !self.at(SyntaxKind::RBracket)
                && !self.at(SyntaxKind::RBrace)
                && !self.at(SyntaxKind::Semi)
            {
                self.bump();
            }
            if self.at(SyntaxKind::Gt) || self.at(SyntaxKind::Shr) {
                self.bump();
            }
        }

        self.builder.finish_node();
    }

    fn parse_postfix_chain(&mut self, checkpoint: rowan::Checkpoint, terminators: &[SyntaxKind]) {
        loop {
            self.eat_trivia();
            if terminators.contains(&self.current()) {
                break;
            }

            match self.current() {
                SyntaxKind::Lt if self.at_template_lt() => {
                    self.consume_balanced_pair(SyntaxKind::Lt, SyntaxKind::Gt);
                }
                SyntaxKind::LParen => {
                    self.builder
                        .start_node_at(checkpoint, SyntaxKind::CallExpr.into());
                    self.parse_arg_list(ExprMode::Normal);
                    self.builder.finish_node();
                }
                SyntaxKind::LBracket => {
                    self.builder
                        .start_node_at(checkpoint, SyntaxKind::SubscriptExpr.into());
                    self.bump();
                    self.eat_trivia();
                    if !self.at(SyntaxKind::RBracket) {
                        self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RBracket]);
                        self.eat_trivia();
                    }
                    if self.at(SyntaxKind::RBracket) {
                        self.bump();
                    } else {
                        while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBracket) {
                            self.bump();
                        }
                        if self.at(SyntaxKind::RBracket) {
                            self.bump();
                        }
                    }
                    self.builder.finish_node();
                }
                SyntaxKind::Dot => {
                    self.builder
                        .start_node_at(checkpoint, SyntaxKind::MemberExpr.into());
                    self.bump();
                    self.eat_trivia();
                    if self.at(SyntaxKind::Ident) || is_keyword_kind(self.current()) {
                        self.bump();
                    } else if !self.at(SyntaxKind::Eof) {
                        self.bump();
                    }
                    self.builder.finish_node();
                }
                SyntaxKind::PlusPlus | SyntaxKind::MinusMinus => {
                    self.builder
                        .start_node_at(checkpoint, SyntaxKind::UnaryExpr.into());
                    self.bump();
                    self.builder.finish_node();
                }
                _ => break,
            }
        }
    }

    fn parse_arg_list(&mut self, mode: ExprMode) {
        self.builder.start_node(SyntaxKind::ArgList.into());
        if self.at(SyntaxKind::LParen) {
            self.bump();
        }

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RParen) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.parse_expr_node(mode, &[SyntaxKind::Comma, SyntaxKind::RParen]);

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }

        if self.at(SyntaxKind::RParen) {
            self.bump();
        } else {
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                self.bump();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            }
        }

        self.builder.finish_node();
    }

    fn parse_cast_expr(&mut self, terminators: &[SyntaxKind]) {
        let checkpoint = self.builder.checkpoint();
        self.builder
            .start_node_at(checkpoint, SyntaxKind::CastExpr.into());

        self.bump();
        self.eat_trivia();

        // `cast<T>(x)`
        if self.at(SyntaxKind::Lt) {
            self.parse_type_template_args();
            self.eat_trivia();
        }

        if self.at(SyntaxKind::LParen) {
            self.bump();
            self.eat_trivia();
            if !self.at(SyntaxKind::RParen) {
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::RParen]);
                self.eat_trivia();
            }
            if self.at(SyntaxKind::RParen) {
                self.bump();
            } else {
                while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RParen) {
                    self.bump();
                }
                if self.at(SyntaxKind::RParen) {
                    self.bump();
                }
            }
        } else {
            // Fallback: parse a single operand expression.
            self.parse_expr_bp(ExprMode::Normal, 13, terminators);
        }

        self.builder.finish_node();
    }

    fn parse_initializer_list_expr(&mut self, _mode: ExprMode, terminators: &[SyntaxKind]) {
        // Distinguish designated initializer lists by looking for `{ .field = ... }`.
        let mut j = self.pos + 1;
        while let Some(t) = self.tokens.get(j) {
            if t.kind.is_trivia() {
                j += 1;
                continue;
            }
            break;
        }

        let designated = self
            .tokens
            .get(j)
            .is_some_and(|t| t.kind == SyntaxKind::Dot);
        let node_kind = if designated {
            SyntaxKind::DesignatedInitializerListExpr
        } else {
            SyntaxKind::InitializerListExpr
        };

        self.builder.start_node(node_kind.into());
        if self.at(SyntaxKind::LBrace) {
            self.bump();
        }

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RBrace) || self.at(SyntaxKind::Eof) {
                break;
            }
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }

            if designated {
                self.builder
                    .start_node(SyntaxKind::DesignatedInitializer.into());
                if self.at(SyntaxKind::Dot) {
                    self.bump();
                    self.eat_trivia();
                }
                if self.at(SyntaxKind::Ident) || is_keyword_kind(self.current()) {
                    self.bump();
                    self.eat_trivia();
                }
                if self.at(SyntaxKind::Eq) {
                    self.bump();
                    self.eat_trivia();
                    self.parse_expr_node(
                        ExprMode::Normal,
                        &[SyntaxKind::Comma, SyntaxKind::RBrace],
                    );
                } else {
                    while !self.at(SyntaxKind::Eof)
                        && !self.at(SyntaxKind::Comma)
                        && !self.at(SyntaxKind::RBrace)
                        && !terminators.contains(&self.current())
                    {
                        if self.at(SyntaxKind::LBrace) {
                            self.parse_initializer_list_expr(ExprMode::Normal, terminators);
                            continue;
                        }
                        self.bump();
                    }
                }
                self.builder.finish_node();
            } else {
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Comma, SyntaxKind::RBrace]);
            }

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }

        if self.at(SyntaxKind::RBrace) {
            self.bump();
        } else {
            while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBrace) {
                self.bump();
            }
            if self.at(SyntaxKind::RBrace) {
                self.bump();
            }
        }

        self.builder.finish_node();
    }

    fn parse_static_default_init_stmt(&mut self) {
        self.builder
            .start_node(SyntaxKind::StaticDefaultInitStmt.into());
        self.expect(SyntaxKind::KwStatic);
        self.eat_trivia();
        self.expect(SyntaxKind::KwDefault);

        self.eat_trivia();
        if self.at(SyntaxKind::Eq) {
            self.bump();
            self.eat_trivia();
            if self.at(SyntaxKind::LBrace) {
                self.parse_initializer_list_expr(ExprMode::Normal, &[SyntaxKind::Semi]);
            } else {
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Semi]);
            }
        }

        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn parse_local_var_decl(&mut self) {
        self.builder.start_node(SyntaxKind::LocalVarDecl.into());
        self.parse_var_decl_like_semicolon_terminated();
        self.builder.finish_node();
    }

    fn parse_static_var_decl(&mut self) {
        self.builder.start_node(SyntaxKind::StaticVarDecl.into());
        self.expect(SyntaxKind::KwStatic);

        self.parse_var_decl_like_semicolon_terminated();
        self.builder.finish_node();
    }

    fn looks_like_static_var_decl_ahead(&self) -> bool {
        if self.current() != SyntaxKind::KwStatic {
            return false;
        }
        match self.peek_next_nontrivia_kind(1) {
            Some(SyntaxKind::KwIf) | Some(SyntaxKind::KwFor) | Some(SyntaxKind::KwDefault) => {
                return false
            }
            _ => {}
        }

        self.looks_like_local_var_decl_ahead_from_offset(1)
    }

    fn looks_like_local_var_decl_ahead(&self) -> bool {
        self.looks_like_local_var_decl_ahead_from_offset(0)
    }

    fn looks_like_local_var_decl_ahead_from_offset(&self, offset: usize) -> bool {
        // Reject statement-only keywords that can never start a type.
        // These keywords should be parsed as statements, not local variable declarations.
        let first_nontrivia = self.peek_next_nontrivia_kind(offset);
        if matches!(
            first_nontrivia,
            Some(
                SyntaxKind::KwReturn
                    | SyntaxKind::KwIf
                    | SyntaxKind::KwWhile
                    | SyntaxKind::KwFor
                    | SyntaxKind::KwDo
                    | SyntaxKind::KwSwitch
                    | SyntaxKind::KwBreak
                    | SyntaxKind::KwBarrier
                    | SyntaxKind::KwCase
                    | SyntaxKind::KwDefault
            )
        ) {
            return false;
        }

        // Shape-first heuristic:
        // - must end in a top-level ';'
        // - must have at least 2 top-level identifiers (type-ish + name)
        // - must NOT have a top-level '(' before any assignment operator (to avoid calls like foo())
        // - and must have at least 2 top-level identifiers *before* the first assignment operator
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;
        let mut saw_arrow_top: bool = false;

        let mut ident_top: usize = 0;
        let mut ident_before_assign: usize = 0;
        let mut saw_assign_op: bool = false;
        let mut saw_lparen_before_assign: bool = false;
        // Track if we see `.` between identifiers at top level before assignment.
        // Patterns like `a.b = x;` are assignments, not var decls.
        let mut saw_dot_between_idents: bool = false;
        // Track if we see `[` at top level right after an identifier before assignment.
        // Patterns like `a[i] = x;` are subscript assignments, not var decls.
        // (Note: `T[N] name = x;` is a var decl, but there the first token is a type not ident.)
        let mut saw_bracket_after_first_ident: bool = false;

        let mut prev_nontrivia: Option<SyntaxKind> = None;

        // Scan up to 1024 tokens ahead to handle complex nested statements with lambdas
        // and large struct initializers with many mux() calls
        for i in offset..(offset + 1024) {
            let Some(t) = self.tokens.get(self.pos + i) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }

            match t.kind {
                SyntaxKind::LParen => {
                    if paren == 0 && bracket == 0 && brace == 0 && angle == 0 && !saw_assign_op {
                        // `decltype(...) name;` is a type + name, not a call.
                        if prev_nontrivia != Some(SyntaxKind::KwDecltype) {
                            saw_lparen_before_assign = true;
                        }
                    }
                    paren += 1;
                }
                SyntaxKind::RParen => paren = paren.saturating_sub(1),
                SyntaxKind::LBracket => {
                    // If we see `[` right after the first identifier at top level before assignment,
                    // it's a subscript pattern like `arr[i] = x;` which is an assignment.
                    if paren == 0
                        && bracket == 0
                        && brace == 0
                        && angle == 0
                        && !saw_assign_op
                        && ident_before_assign == 1
                        && is_decl_ident_like(prev_nontrivia.unwrap_or(SyntaxKind::Eof))
                    {
                        saw_bracket_after_first_ident = true;
                    }
                    bracket += 1;
                }
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => {
                    if paren == 0 && bracket == 0 && brace == 0 && angle == 0 && !saw_assign_op {
                        // Likely a function body: `T name(...) { ... }`.
                        return false;
                    }
                    brace += 1;
                }
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.is_template_lt_at(self.pos + i) => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                SyntaxKind::Dot
                    if paren == 0
                        && bracket == 0
                        && brace == 0
                        && angle == 0
                        && !saw_assign_op
                        && ident_before_assign >= 1 =>
                {
                    // Seeing `.` after at least one identifier (before assignment) means
                    // this is a member access expression, not a var decl.
                    saw_dot_between_idents = true;
                }
                k if is_decl_ident_like(k)
                    && paren == 0
                    && bracket == 0
                    && brace == 0
                    && angle == 0 =>
                {
                    ident_top += 1;
                    if !saw_assign_op {
                        ident_before_assign += 1;
                    }
                }
                k if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                    if is_assignment_like_op(k) {
                        saw_assign_op = true;
                    }
                    if k == SyntaxKind::Arrow {
                        saw_arrow_top = true;
                    }
                    if k == SyntaxKind::Semi {
                        let _ = ident_top;
                        // If we saw `.` between identifiers, it's a member access (assignment), not a var decl.
                        if saw_dot_between_idents {
                            return false;
                        }
                        // If we saw `[` after the first identifier AND there's no second identifier,
                        // it's a subscript like `arr[i] = x;` which is an assignment.
                        // But `T[N] name = x;` (ident_before_assign==2) is a var decl.
                        if saw_bracket_after_first_ident && ident_before_assign == 1 {
                            return false;
                        }
                        // Allow function-type declarations like `(T)->U name;` which contain a top-level
                        // paren group before the variable name.
                        return ident_before_assign >= 2
                            && (!saw_lparen_before_assign || saw_arrow_top);
                    }
                }
                _ => {}
            }

            prev_nontrivia = Some(t.kind);
        }

        false
    }

    fn classify_simple_semi_stmt(&self, limit: usize) -> Option<SimpleSemiStmtClass> {
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        let mut saw_assign: bool = false;
        let mut saw_incdec: bool = false;

        for i in 0..limit {
            let Some(t) = self.tokens.get(self.pos + i) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }

            match t.kind {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => paren = paren.saturating_sub(1),
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.is_template_lt_at(self.pos + i) => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                k if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                    if is_assignment_like_op(k) {
                        saw_assign = true;
                    }
                    if matches!(k, SyntaxKind::PlusPlus | SyntaxKind::MinusMinus) {
                        saw_incdec = true;
                    }
                    if k == SyntaxKind::Semi {
                        break;
                    }
                }
                _ => {}
            }
        }

        if saw_assign {
            Some(SimpleSemiStmtClass::Assign)
        } else if saw_incdec {
            Some(SimpleSemiStmtClass::IncDec)
        } else {
            Some(SimpleSemiStmtClass::Expr)
        }
    }

    fn consume_until_semi_balanced(&mut self) {
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            // Attributes can prefix call expressions, appear in types, etc.
            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            // Lambda expressions start with `[` and contain a `{...}` body.
            if self.at(SyntaxKind::LBracket) {
                if self.try_parse_lambda_expr() {
                    continue;
                }
            }

            // Preserve initializer list structure.
            if self.at(SyntaxKind::LBrace) {
                self.parse_initializer_list_expr(ExprMode::Normal, &[SyntaxKind::Semi]);
                continue;
            }

            match self.current() {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => paren = paren.saturating_sub(1),
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.at_template_lt() => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                SyntaxKind::Semi if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                    self.bump();
                    break;
                }
                _ => {}
            }

            self.bump();
        }
    }

    fn try_parse_lambda_expr(&mut self) -> bool {
        if !self.at(SyntaxKind::LBracket) {
            return false;
        }

        // Avoid treating indexing `x[0]` as a lambda.
        if matches!(
            self.prev_nontrivia_kind(),
            Some(
                SyntaxKind::Ident
                    | SyntaxKind::IntDec
                    | SyntaxKind::IntHex
                    | SyntaxKind::IntBin
                    | SyntaxKind::IntOct
                    | SyntaxKind::Float
                    | SyntaxKind::String
                    | SyntaxKind::Char
                    | SyntaxKind::RParen
                    | SyntaxKind::RBracket
                    | SyntaxKind::RBrace
            )
        ) {
            return false;
        }

        // Heuristic: find the matching `]` and ensure a lambda-ish follower exists.
        let mut depth: usize = 0;
        let mut i: usize = 0;
        let mut end_idx: Option<usize> = None;
        while let Some(t) = self.tokens.get(self.pos + i) {
            if t.kind.is_trivia() {
                i += 1;
                continue;
            }
            match t.kind {
                SyntaxKind::LBracket => depth += 1,
                SyntaxKind::RBracket => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end_idx = Some(self.pos + i);
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
            if i > 512 {
                break;
            }
        }

        let Some(end_idx) = end_idx else {
            return false;
        };

        let mut j = end_idx + 1;
        while let Some(t) = self.tokens.get(j) {
            if t.kind.is_trivia() {
                j += 1;
                continue;
            }
            let follower = t.kind;
            if matches!(
                follower,
                SyntaxKind::LParen | SyntaxKind::Arrow | SyntaxKind::LBrace
            ) {
                self.parse_lambda_expr();
                return true;
            }
            return false;
        }

        false
    }

    fn parse_lambda_expr(&mut self) {
        self.builder.start_node(SyntaxKind::LambdaExpr.into());

        // Capture list: `[a, b, ...]` (can be empty: `[]`).
        self.builder
            .start_node(SyntaxKind::LambdaCaptureList.into());
        self.expect(SyntaxKind::LBracket);
        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RBracket) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.builder.start_node(SyntaxKind::LambdaCapture.into());
            if self.at(SyntaxKind::Ident) {
                self.bump();
            } else {
                // Keep permissive: capture is an identifier in the Haskell parser.
                self.bump();
            }
            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            break;
        }
        self.expect(SyntaxKind::RBracket);
        self.builder.finish_node();

        self.eat_trivia();

        // Optional params.
        if self.at(SyntaxKind::LParen) {
            self.builder.start_node(SyntaxKind::LambdaParams.into());
            self.consume_balanced_pair(SyntaxKind::LParen, SyntaxKind::RParen);
            self.builder.finish_node();
            self.eat_trivia();
        }

        // Optional return type: `-> typ`.
        if self.at(SyntaxKind::Arrow) {
            self.builder.start_node(SyntaxKind::LambdaReturnType.into());
            self.bump();
            self.eat_trivia();
            // Consume type-ish tokens until body `{`.
            while !self.at(SyntaxKind::Eof) {
                if self.current().is_trivia() {
                    self.bump();
                    continue;
                }
                if self.at(SyntaxKind::LBrace) {
                    break;
                }
                // Keep it balanced across type-level constructs.
                if self.at(SyntaxKind::LParen) {
                    self.consume_balanced_pair(SyntaxKind::LParen, SyntaxKind::RParen);
                    continue;
                }
                if self.at(SyntaxKind::LBracket) {
                    self.consume_balanced_pair(SyntaxKind::LBracket, SyntaxKind::RBracket);
                    continue;
                }
                if self.at(SyntaxKind::Lt) {
                    self.consume_balanced_pair(SyntaxKind::Lt, SyntaxKind::Gt);
                    continue;
                }
                self.bump();
            }
            self.builder.finish_node();
            self.eat_trivia();
        }

        // Body.
        if self.at(SyntaxKind::LBrace) {
            self.parse_block();
        } else {
            // Haskell requires braces; keep lossless.
            self.consume_until_semi_balanced();
        }

        self.builder.finish_node();
    }

    fn prev_nontrivia_kind(&self) -> Option<SyntaxKind> {
        if self.pos == 0 {
            return None;
        }
        let mut idx = self.pos;
        while idx > 0 {
            idx -= 1;
            let Some(t) = self.tokens.get(idx) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }
            return Some(t.kind);
        }
        None
    }

    fn at_template_lt(&self) -> bool {
        self.is_template_lt_at(self.pos)
    }

    fn is_template_lt_at(&self, lt_idx: usize) -> bool {
        let Some(curr) = self.tokens.get(lt_idx) else {
            return false;
        };
        if curr.kind != SyntaxKind::Lt {
            return false;
        }

        // Find previous non-trivia token before `lt_idx`.
        let mut prev_idx = lt_idx;
        while prev_idx > 0 {
            prev_idx -= 1;
            let Some(t) = self.tokens.get(prev_idx) else {
                return false;
            };
            if t.kind.is_trivia() {
                continue;
            }

            // Heuristic: treat `<` as a template opener only when it's directly adjacent to a
            // type/function-ish token (e.g. `optional<...`, `cast<...`, `unit::test<1>`, `uint<...>`,
            // `fan_out<...>`). This avoids misclassifying comparisons like `state < 4`.
            if t.span.end != curr.span.start {
                return false;
            }

            return matches!(
                t.kind,
                SyntaxKind::Ident
                    | SyntaxKind::KwCast
                    | SyntaxKind::KwFanOut
                    | SyntaxKind::KwInt
                    | SyntaxKind::KwUint
            );
        }

        false
    }

    fn looks_like_global_var_ahead(&self) -> bool {
        // Avoid eating known top-level starters.
        match self.current() {
            SyntaxKind::KwModule
            | SyntaxKind::KwImport
            | SyntaxKind::KwExtern
            | SyntaxKind::KwExport
            | SyntaxKind::KwTemplate
            | SyntaxKind::KwStruct
            | SyntaxKind::KwEnum
            | SyntaxKind::KwUnion
            | SyntaxKind::KwUsing
            | SyntaxKind::KwStaticAssert
            | SyntaxKind::KwStatic
            | SyntaxKind::Error
            | SyntaxKind::Eof => return false,
            _ => {}
        }

        // Heuristic: if we can find a top-level ';' reasonably soon, it's likely a decl.
        self.find_top_level_semi_within(256)
    }

    fn looks_like_function_ahead(&self) -> bool {
        self.classify_function_ahead().is_some()
    }

    fn looks_like_braced_function_def_ahead(&self) -> bool {
        // Lightweight shape check for a function *definition* (not a call):
        // find an `Ident ( ... ) {` sequence at top-level nesting.
        // Stop scanning at a top-level `;` or `}`.
        let limit = 512;

        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        for i in 0..limit {
            let idx = self.pos + i;
            let Some(t) = self.tokens.get(idx) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }

            if paren == 0 && bracket == 0 && brace == 0 && angle == 0 {
                match t.kind {
                    SyntaxKind::Semi | SyntaxKind::RBrace => break,
                    _ => {}
                }
            }

            match t.kind {
                SyntaxKind::LParen => {
                    paren += 1;
                    continue;
                }
                SyntaxKind::RParen => {
                    paren = paren.saturating_sub(1);
                    continue;
                }
                SyntaxKind::LBracket => {
                    bracket += 1;
                    continue;
                }
                SyntaxKind::RBracket => {
                    bracket = bracket.saturating_sub(1);
                    continue;
                }
                SyntaxKind::LBrace => {
                    brace += 1;
                    continue;
                }
                SyntaxKind::RBrace => {
                    brace = brace.saturating_sub(1);
                    continue;
                }
                SyntaxKind::Lt if self.is_template_lt_at(idx) => {
                    angle += 1;
                    continue;
                }
                SyntaxKind::Gt => {
                    angle = angle.saturating_sub(1);
                    continue;
                }
                SyntaxKind::Shr => {
                    angle = angle.saturating_sub(2);
                    continue;
                }
                _ => {}
            }

            if paren != 0 || bracket != 0 || brace != 0 || angle != 0 {
                continue;
            }

            if t.kind != SyntaxKind::Ident {
                continue;
            }

            let Some(lparen_idx) = self.next_nontrivia_index(idx + 1) else {
                continue;
            };
            let Some(lparen_tok) = self.tokens.get(lparen_idx) else {
                continue;
            };
            if lparen_tok.kind != SyntaxKind::LParen {
                continue;
            }

            let Some(rparen_idx) = self.find_matching_rparen(lparen_idx) else {
                continue;
            };

            let Some(after_params_idx) = self.next_nontrivia_index(rparen_idx + 1) else {
                continue;
            };

            if let Some(tok) = self.tokens.get(after_params_idx) {
                if tok.kind == SyntaxKind::LBrace {
                    return true;
                }
            }
        }

        false
    }

    fn find_top_level_semi_within(&self, limit: usize) -> bool {
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        for i in 0..limit {
            let Some(t) = self.tokens.get(self.pos + i) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }

            match t.kind {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => paren = paren.saturating_sub(1),
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.is_template_lt_at(self.pos + i) => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                SyntaxKind::Semi if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                    return true
                }
                _ => {}
            }
        }

        false
    }

    fn classify_function_ahead(&self) -> Option<FunctionAhead> {
        // Find `Ident (` at top-level nesting, then match the end of the params and see `{` or `;`.
        // Important: don't match `Ident (` that only appears inside nested constructs (e.g. inside
        // `static if { ... }` bodies), or the parser will misclassify surrounding forms.
        let limit = 512;

        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        for i in 0..limit {
            let idx = self.pos + i;
            let Some(t) = self.tokens.get(idx) else {
                break;
            };
            if t.kind.is_trivia() {
                continue;
            }

            // Don't look past the end of the current brace-delimited scope.
            if paren == 0
                && bracket == 0
                && brace == 0
                && angle == 0
                && t.kind == SyntaxKind::RBrace
            {
                break;
            }

            // Don't scan past the end of the current statement/declaration.
            if paren == 0 && bracket == 0 && brace == 0 && angle == 0 {
                if t.kind == SyntaxKind::Semi {
                    break;
                }
                if is_assignment_like_op(t.kind) {
                    break;
                }
            }

            match t.kind {
                SyntaxKind::LParen => {
                    paren += 1;
                    continue;
                }
                SyntaxKind::RParen => {
                    paren = paren.saturating_sub(1);
                    continue;
                }
                SyntaxKind::LBracket => {
                    bracket += 1;
                    continue;
                }
                SyntaxKind::RBracket => {
                    bracket = bracket.saturating_sub(1);
                    continue;
                }
                SyntaxKind::LBrace => {
                    brace += 1;
                    continue;
                }
                SyntaxKind::RBrace => {
                    brace = brace.saturating_sub(1);
                    continue;
                }
                SyntaxKind::Lt if self.is_template_lt_at(idx) => {
                    angle += 1;
                    continue;
                }
                SyntaxKind::Gt => {
                    angle = angle.saturating_sub(1);
                    continue;
                }
                SyntaxKind::Shr => {
                    angle = angle.saturating_sub(2);
                    continue;
                }
                _ => {}
            }

            if paren != 0 || bracket != 0 || brace != 0 || angle != 0 {
                continue;
            }
            if t.kind != SyntaxKind::Ident {
                continue;
            }

            let Some(lparen_idx) = self.next_nontrivia_index(idx + 1) else {
                continue;
            };
            if self.tokens.get(lparen_idx)?.kind != SyntaxKind::LParen {
                continue;
            }

            let Some(rparen_idx) = self.find_matching_rparen(lparen_idx) else {
                continue;
            };

            let Some(after_params_idx) = self.next_nontrivia_index(rparen_idx + 1) else {
                continue;
            };
            match self.tokens.get(after_params_idx)?.kind {
                SyntaxKind::LBrace => return Some(FunctionAhead::Def),
                SyntaxKind::Semi => return Some(FunctionAhead::Decl),
                _ => continue,
            }
        }

        None
    }

    fn find_matching_rparen(&self, lparen_idx: usize) -> Option<usize> {
        let mut depth: usize = 0;
        for idx in lparen_idx..(self.pos + 1024).min(self.tokens.len()) {
            let t = self.tokens.get(idx)?;
            match t.kind {
                SyntaxKind::LParen => depth += 1,
                SyntaxKind::RParen => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Some(idx);
                    }
                }
                _ => {}
            }
        }
        None
    }

    fn next_nontrivia_index(&self, mut idx: usize) -> Option<usize> {
        while let Some(t) = self.tokens.get(idx) {
            if !t.kind.is_trivia() {
                return Some(idx);
            }
            idx += 1;
        }
        None
    }

    fn peek_next_nontrivia_kind(&self, offset: usize) -> Option<SyntaxKind> {
        let mut idx = self.pos + offset;
        while let Some(t) = self.tokens.get(idx) {
            if !t.kind.is_trivia() {
                return Some(t.kind);
            }
            idx += 1;
        }
        None
    }

    fn peek_next_nontrivia_ident_text(&self, lookahead: usize) -> Option<&'a str> {
        let mut seen: usize = 0;
        for i in 1..=512 {
            let Some(t) = self.tokens.get(self.pos + i) else {
                return None;
            };
            if t.kind.is_trivia() {
                continue;
            }
            if seen == lookahead - 1 {
                if t.kind == SyntaxKind::Ident {
                    return Some(self.slice(t));
                }
                return None;
            }
            seen += 1;
        }
        None
    }

    fn parse_template_item(&mut self) {
        self.builder.start_node(SyntaxKind::TemplateDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwTemplate);
        self.eat_trivia();

        // Parse template parameter list if present.
        if self.at(SyntaxKind::Lt) {
            self.parse_template_params();
            self.eat_trivia();
        }

        // The template should apply to the next item.
        match self.current() {
            SyntaxKind::KwClass => self.parse_class_item(),
            SyntaxKind::KwStruct => self.parse_struct_item(),
            SyntaxKind::KwEnum => self.parse_enum_item(),
            SyntaxKind::KwUnion => self.parse_union_item(),
            SyntaxKind::KwUsing => self.parse_using_item(),
            _ => {
                // Template often targets functions as well.
                if self.looks_like_function_ahead() {
                    self.parse_function_item();
                } else {
                    // Unknown template target; preserve tokens until we hit a plausible boundary.
                    self.consume_until_item_boundary();
                }
            }
        }

        self.builder.finish_node();
    }

    fn parse_template_params(&mut self) {
        self.builder.start_node(SyntaxKind::TemplateParams.into());
        self.expect(SyntaxKind::Lt);
        self.eat_trivia();

        loop {
            if self.at(SyntaxKind::Gt) || self.at(SyntaxKind::Shr) || self.at(SyntaxKind::Eof) {
                break;
            }

            self.builder.start_node(SyntaxKind::TemplateParam.into());

            // Template param can be:
            // - `typename T` or just `T` for type params
            // - `type name` for value params (e.g., `int N`)
            // - `type name = default` for params with defaults
            // - `template <...> typename Name = default` for template template params
            //
            // Track whether this is a type parameter (default should be a type)
            // or a value parameter (default should be an expression)
            let mut is_type_param = false;
            let mut is_auto_param = false;

            if self.at(SyntaxKind::KwTemplate) {
                // Template template parameter: `template <typename, auto> typename Memory = default`
                is_type_param = true;
                self.bump(); // consume 'template'
                self.eat_trivia();
                // Parse the nested template params
                if self.at(SyntaxKind::Lt) {
                    self.parse_template_params();
                    self.eat_trivia();
                }
                // Expect 'typename' or 'class' followed by name
                if self.at(SyntaxKind::KwTypename) || self.at(SyntaxKind::KwClass) {
                    self.bump();
                    self.eat_trivia();
                }
            } else if self.at(SyntaxKind::KwTypename) || self.at(SyntaxKind::KwClass) {
                is_type_param = true;
                self.bump(); // consume 'typename' or 'class'
                self.eat_trivia();
            }

            // Parse the type (for value params) or name (for type params)
            if self.looks_like_type_start() && !self.at(SyntaxKind::Gt) {
                // Check if this is `auto` type
                is_auto_param = self.at(SyntaxKind::KwAuto);
                self.parse_type_or_fallback();
                self.eat_trivia();
            }

            // Optional parameter name (for value params)
            if self.at(SyntaxKind::Ident) {
                self.bump();
                self.eat_trivia();
            }

            // Optional default value
            if self.at(SyntaxKind::Eq) {
                self.bump();
                self.eat_trivia();

                // Decide whether to parse default as type or expression:
                // - For type params (typename T), default is a type
                // - For auto params (auto N), default is an expression
                // - For other value params (int N), could be either, but expression is safer
                //
                // Special cases that indicate expression:
                // - `((...)` - nested parens (expression, not function type)
                // - `auto` param type (default must be expression)
                let is_nested_paren = self.at(SyntaxKind::LParen) && {
                    self.peek_next_nontrivia_kind(1) == Some(SyntaxKind::LParen)
                };

                // For type params, parse as type; otherwise parse as expression
                if is_type_param && !is_nested_paren {
                    self.parse_type_or_fallback();
                } else {
                    self.parse_expr_node(ExprMode::TemplateArgRestricted, &[SyntaxKind::Comma, SyntaxKind::Gt, SyntaxKind::Shr]);
                }
                self.eat_trivia();
            }

            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                self.eat_trivia();
                continue;
            }
            break;
        }

        // Handle `>` or `>>`
        if self.at(SyntaxKind::Gt) {
            self.bump();
        } else if self.at(SyntaxKind::Shr) {
            // Split `>>` into two `>` tokens - just consume for now
            self.bump();
        }
        self.builder.finish_node();
    }

    fn parse_class_item(&mut self) {
        self.builder.start_node(SyntaxKind::ClassDecl.into());

        // Haskell parser doesn't accept attributes here today, but keeping this permissive helps
        // preserve tokens if the surface syntax evolves.
        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwClass);
        self.eat_trivia();

        if self.at(SyntaxKind::Ident) {
            self.bump();
            self.eat_trivia_excluding_post_doc();
        }

        if self.at(SyntaxKind::LBrace) {
            self.parse_class_body();
        } else {
            // Be permissive: preserve until we reach a plausible boundary.
            self.consume_until_body_or_semi();
        }

        self.eat_trivia_excluding_post_doc();
        if self.at(SyntaxKind::Semi) {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_class_body(&mut self) {
        self.builder.start_node(SyntaxKind::ClassBody.into());
        self.expect(SyntaxKind::LBrace);

        while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBrace) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            match self.current() {
                SyntaxKind::KwPublic | SyntaxKind::KwPrivate => {
                    self.builder.start_node(SyntaxKind::AccessSpecifier.into());
                    self.bump();
                    self.eat_trivia();
                    if self.at(SyntaxKind::Colon) {
                        self.bump();
                    }
                    self.builder.finish_node();
                }
                SyntaxKind::KwDefault => self.parse_default_init_decl(),
                SyntaxKind::KwStaticAssert => self.parse_static_assert_decl(),
                SyntaxKind::KwStatic
                    if self.peek_next_nontrivia_ident_text(1) == Some("assert") =>
                {
                    self.parse_static_assert_two_word_decl()
                }
                SyntaxKind::KwStatic
                    if self.peek_next_nontrivia_kind(1) == Some(SyntaxKind::KwIf) =>
                {
                    // Avoid misclassifying `static if (...) { ... }` as a member variable prefix.
                    self.parse_static_if_decl();
                }
                SyntaxKind::KwTemplate => self.parse_template_item(),
                SyntaxKind::KwUsing => self.parse_using_item(),
                SyntaxKind::KwEnum => self.parse_enum_item(),
                SyntaxKind::KwStruct => self.parse_struct_item(),
                SyntaxKind::KwUnion => self.parse_union_item(),
                SyntaxKind::KwClass => self.parse_class_item(),
                SyntaxKind::KwElse => {
                    // Stray `else` can happen if a prior `static if` arm didn't get consumed
                    // as a single decl-like node. Preserve it and try to recover.
                    self.bump();
                    self.eat_trivia();
                    if self.at(SyntaxKind::KwStatic)
                        && self.peek_next_nontrivia_kind(1) == Some(SyntaxKind::KwIf)
                    {
                        self.parse_static_if_decl();
                    } else {
                        self.consume_until_member_boundary();
                    }
                }
                _ => {
                    // Member functions and member variables share a prefix.
                    if self.looks_like_local_var_decl_ahead() {
                        self.parse_class_var_decl();
                    } else if self.looks_like_function_ahead() {
                        self.parse_function_item();
                    } else {
                        // Preserve unknown member forms, but avoid getting confused by nested
                        // braces (e.g. `static if (...) { ... }`) which would otherwise trip the
                        // `while !RBrace` loop termination.
                        self.consume_until_member_boundary();
                    }
                }
            }
        }

        self.expect(SyntaxKind::RBrace);
        self.builder.finish_node();
    }

    fn parse_default_init_decl(&mut self) {
        self.builder.start_node(SyntaxKind::DefaultInitDecl.into());
        self.expect(SyntaxKind::KwDefault);

        self.eat_trivia();
        if self.at(SyntaxKind::Eq) {
            self.bump();
            self.eat_trivia();
            if self.at(SyntaxKind::LBrace) {
                self.parse_initializer_list_expr(ExprMode::Normal, &[SyntaxKind::Semi]);
            } else {
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Semi]);
            }
        }

        self.eat_trivia();
        self.consume_trailing_semi_or_recover();
        self.builder.finish_node();
    }

    fn parse_class_var_decl(&mut self) {
        self.builder.start_node(SyntaxKind::ClassVarDecl.into());
        self.parse_var_decl_like_semicolon_terminated();
        self.builder.finish_node();
    }

    fn consume_until_member_boundary(&mut self) {
        let mut paren: usize = 0;
        let mut bracket: usize = 0;
        let mut brace: usize = 0;
        let mut angle: usize = 0;

        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            // At top-level, a member can be terminated by `;` or a balanced `{...}` body.
            if paren == 0 && bracket == 0 && brace == 0 && angle == 0 {
                if self.at(SyntaxKind::Semi) {
                    self.bump();
                    break;
                }
                if self.at(SyntaxKind::LBrace) {
                    self.consume_balanced_pair(SyntaxKind::LBrace, SyntaxKind::RBrace);
                    break;
                }
                if self.at(SyntaxKind::RBrace) {
                    // Don't consume: likely end of the enclosing class body.
                    break;
                }
            }

            match self.current() {
                SyntaxKind::LParen => paren += 1,
                SyntaxKind::RParen => paren = paren.saturating_sub(1),
                SyntaxKind::LBracket => bracket += 1,
                SyntaxKind::RBracket => bracket = bracket.saturating_sub(1),
                SyntaxKind::LBrace => brace += 1,
                SyntaxKind::RBrace => brace = brace.saturating_sub(1),
                SyntaxKind::Lt if self.at_template_lt() => angle += 1,
                SyntaxKind::Gt => angle = angle.saturating_sub(1),
                SyntaxKind::Shr => angle = angle.saturating_sub(2),
                _ => {}
            }

            self.bump();
        }
    }

    fn parse_struct_item(&mut self) {
        self.builder.start_node(SyntaxKind::StructDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwStruct);
        self.eat_trivia();

        // Name (optional for now; keep permissive).
        if self.at(SyntaxKind::Ident) {
            self.bump();
            self.eat_trivia();
        }

        // Optional constraints/etc. Consume until we hit '{' or ';'.
        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }
            match self.current() {
                SyntaxKind::LBrace => {
                    self.parse_struct_body();
                    self.eat_trivia_excluding_post_doc();
                    if self.at(SyntaxKind::Semi) {
                        self.bump();
                    }
                    break;
                }
                SyntaxKind::Semi => {
                    self.bump();
                    break;
                }
                _ => self.bump(),
            }
        }

        self.builder.finish_node();
    }

    fn parse_struct_body(&mut self) {
        self.builder.start_node(SyntaxKind::StructBody.into());
        self.expect(SyntaxKind::LBrace);

        while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBrace) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            self.builder.start_node(SyntaxKind::StructMemberDecl.into());
            self.parse_var_decl_like_semicolon_terminated();
            self.builder.finish_node();
            self.eat_trivia();
        }

        self.expect(SyntaxKind::RBrace);
        self.builder.finish_node();
    }

    fn parse_enum_item(&mut self) {
        self.builder.start_node(SyntaxKind::EnumDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwEnum);
        self.eat_trivia();

        if self.at(SyntaxKind::Ident) {
            self.bump();
            self.eat_trivia();
        }

        // Haskell requires `: <type> { ... }`.
        // Parse the base type properly.
        if self.at(SyntaxKind::Colon) {
            self.bump();
            self.eat_trivia();
            // Parse enum underlying type
            if !self.at(SyntaxKind::LBrace) && !self.at(SyntaxKind::Semi) {
                self.parse_type_or_fallback();
                self.eat_trivia();
            }
        }

        if self.at(SyntaxKind::LBrace) {
            self.parse_enum_body();
            self.eat_trivia_excluding_post_doc();
            if self.at(SyntaxKind::Semi) {
                self.bump();
            }
        } else {
            self.consume_until_body_or_semi();
        }

        self.builder.finish_node();
    }

    fn parse_enum_body(&mut self) {
        self.builder.start_node(SyntaxKind::EnumBody.into());
        self.expect(SyntaxKind::LBrace);

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RBrace) {
                break;
            }
            if self.at(SyntaxKind::Eof) {
                break;
            }

            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            self.builder.start_node(SyntaxKind::EnumVariant.into());

            // Variant name.
            if self.at(SyntaxKind::Ident) {
                self.bump();
            } else {
                // Keep going; enum bodies often have comments/docs.
                self.error_here("Expected enum constant name");
            }

            // Optional initializer: `= <expr>`
            self.eat_trivia();
            if self.at(SyntaxKind::Eq) {
                self.bump();
                self.eat_trivia();
                self.parse_expr_node(ExprMode::Normal, &[SyntaxKind::Comma, SyntaxKind::RBrace]);
            }

            self.builder.finish_node();

            self.eat_trivia();
            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }
            // Trailing comma allowed; otherwise stop on '}' or keep preserving.
            if self.at(SyntaxKind::RBrace) {
                break;
            }
            // If not a comma, attempt to continue by consuming until next comma/}.
            if !self.at(SyntaxKind::Eof) {
                self.error_here("Expected ',' or '}' after enum constant");
                while !self.at(SyntaxKind::Eof)
                    && !self.at(SyntaxKind::Comma)
                    && !self.at(SyntaxKind::RBrace)
                {
                    self.bump();
                }
                if self.at(SyntaxKind::Comma) {
                    self.bump();
                }
            }
        }

        self.expect(SyntaxKind::RBrace);
        self.builder.finish_node();
    }

    fn parse_union_item(&mut self) {
        self.builder.start_node(SyntaxKind::UnionDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwUnion);
        self.eat_trivia();

        if self.at(SyntaxKind::Ident) {
            self.bump();
            self.eat_trivia();
        }

        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }
            match self.current() {
                SyntaxKind::LBrace => {
                    self.parse_union_body();
                    self.eat_trivia_excluding_post_doc();
                    if self.at(SyntaxKind::Semi) {
                        self.bump();
                    }
                    break;
                }
                SyntaxKind::Semi => {
                    self.bump();
                    break;
                }
                _ => self.bump(),
            }
        }

        self.builder.finish_node();
    }

    fn parse_union_body(&mut self) {
        self.builder.start_node(SyntaxKind::UnionBody.into());
        self.expect(SyntaxKind::LBrace);

        while !self.at(SyntaxKind::Eof) && !self.at(SyntaxKind::RBrace) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            if self.at_double_lbracket() {
                self.parse_attr_seq_if_present();
                continue;
            }

            self.builder.start_node(SyntaxKind::UnionMemberDecl.into());
            self.parse_var_decl_like_semicolon_terminated();
            self.builder.finish_node();
            self.eat_trivia();
        }

        self.expect(SyntaxKind::RBrace);
        self.builder.finish_node();
    }

    fn parse_using_item(&mut self) {
        self.builder.start_node(SyntaxKind::UsingDecl.into());

        self.parse_attr_seq_if_present();
        self.eat_trivia();

        self.expect(SyntaxKind::KwUsing);

        self.eat_trivia();

        // Canonical: `using Name = Type;`
        if self.at(SyntaxKind::Ident) {
            self.bump();
            self.eat_trivia();

            if self.at(SyntaxKind::Eq) {
                self.bump();
                self.eat_trivia();
                self.parse_type_or_fallback();
                self.eat_trivia();

                if self.at(SyntaxKind::Semi) {
                    self.bump();
                } else {
                    // Recovery: consume to semicolon to keep progress.
                    self.consume_until_semi_or_eof();
                }

                self.builder.finish_node();
                return;
            }
        }

        // Fallback: consume until semicolon at top-level nesting.
        self.consume_until_semi_or_eof();

        self.builder.finish_node();
    }

    fn parse_extern_decl(&mut self) {
        self.builder.start_node(SyntaxKind::ExternDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwExtern);
        self.eat_trivia();

        // `extern` is followed by a type (possibly with template args), then semicolon.
        // Examples: `extern Foo;` or `extern Foo<T, N>;`
        if !self.try_parse_type() {
            self.error_here("Expected type after 'extern'");
        }

        self.eat_trivia_excluding_post_doc();
        if self.at(SyntaxKind::Semi) {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_export_decl(&mut self) {
        self.builder.start_node(SyntaxKind::ExportDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwExport);
        self.eat_trivia();

        // `export` is followed by a type (possibly with template args), then semicolon.
        // Examples: `export Foo;` or `export Foo<T, N>;`
        if !self.try_parse_type() {
            self.error_here("Expected type after 'export'");
        }

        self.eat_trivia_excluding_post_doc();
        if self.at(SyntaxKind::Semi) {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_static_assert_decl(&mut self) {
        self.builder.start_node(SyntaxKind::StaticAssertDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwStaticAssert);
        self.eat_trivia();

        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after static_assert");
        }

        self.eat_trivia_excluding_post_doc();
        if self.at(SyntaxKind::Semi) {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_static_assert_two_word_decl(&mut self) {
        self.builder.start_node(SyntaxKind::StaticAssertDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwStatic);
        self.eat_trivia();

        // `assert` is not a reserved keyword in the Haskell lexer; it is parsed as a bare word.
        if self.at(SyntaxKind::Ident) {
            if self.slice(self.tokens.get(self.pos).unwrap()) != "assert" {
                self.error_here("Expected `assert` after `static`");
            }
            self.bump();
        } else {
            self.error_here("Expected `assert` after `static`");
        }

        self.eat_trivia();
        if self.at(SyntaxKind::LParen) {
            self.parse_paren_expr_for_stmt();
        } else {
            self.error_here("Expected '(' after static assert");
        }

        self.eat_trivia_excluding_post_doc();
        if self.at(SyntaxKind::Semi) {
            self.bump();
        }

        self.builder.finish_node();
    }

    fn parse_common_decl_after_wrappers(&mut self) {
        match self.current() {
            SyntaxKind::KwExtern => self.parse_extern_decl(),
            SyntaxKind::KwExport => self.parse_export_decl(),
            SyntaxKind::KwUsing => self.parse_using_item(),
            SyntaxKind::KwEnum => self.parse_enum_item(),
            SyntaxKind::KwStruct => self.parse_struct_item(),
            SyntaxKind::KwUnion => self.parse_union_item(),
            SyntaxKind::KwClass => self.parse_class_item(),
            SyntaxKind::KwStaticAssert => self.parse_static_assert_decl(),
            _ => self.consume_until_body_or_semi(),
        }
    }

    fn parse_module_decl(&mut self) {
        self.builder.start_node(SyntaxKind::ModuleDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwModule);
        self.eat_trivia();

        self.parse_module_name();
        self.eat_trivia_excluding_post_doc();

        if self.at(SyntaxKind::LBrace) {
            self.parse_module_exports();
        }

        // Remaining tokens (declarations inside module) are preserved for now.
        self.builder.finish_node();
    }

    fn parse_import_decl(&mut self) {
        self.builder.start_node(SyntaxKind::ImportDecl.into());

        self.parse_attr_seq_if_present();

        self.expect(SyntaxKind::KwImport);
        self.eat_trivia();

        self.parse_module_name();
        self.eat_trivia_excluding_post_doc();

        if self.at(SyntaxKind::KwAs) {
            self.bump();
            self.eat_trivia();
            // Alias
            if self.at(SyntaxKind::Ident) {
                self.bump();
            } else {
                self.error_here("Expected identifier after `as`");
            }
        }

        self.builder.finish_node();
    }

    fn parse_module_name(&mut self) {
        self.builder.start_node(SyntaxKind::ModuleName.into());

        // Handles:
        // - .options / .cmdargs : Dot Ident
        // - foo.bar.baz         : segment (Dot segment)*
        // - segments may contain '-' in source; lexer emits it as Minus between Idents.
        self.parse_module_name_segment();
        while self.at(SyntaxKind::Dot) {
            self.bump();
            self.parse_module_name_segment();
        }

        self.builder.finish_node();
    }

    fn parse_module_name_segment(&mut self) {
        self.builder
            .start_node(SyntaxKind::ModuleNameSegment.into());

        // Optional leading '.' for special modules.
        if self.at(SyntaxKind::Dot) {
            self.bump();
        }

        let k = self.current();
        if k == SyntaxKind::Ident || is_keyword_kind(k) {
            self.bump();

            // Allow hyphens inside module segments as `name-name-name` or `name-7`.
            // Module names can contain numbers after hyphens (e.g., `agilex-7`, `stratix-10`).
            while self.at(SyntaxKind::Minus) {
                self.bump();
                let k = self.current();
                if k == SyntaxKind::Ident || is_keyword_kind(k) || self.is_number_token(k) {
                    self.bump();
                } else {
                    self.error_here("Expected identifier or number after '-' in module name segment");
                    break;
                }
            }
        } else {
            self.error_here("Expected module name segment");
        }

        self.builder.finish_node();
    }

    /// Check if a token is a numeric literal (for module name segments like `agilex-7`).
    fn is_number_token(&self, k: SyntaxKind) -> bool {
        matches!(k, SyntaxKind::IntDec | SyntaxKind::IntHex | SyntaxKind::IntBin | SyntaxKind::IntOct)
    }

    fn parse_module_exports(&mut self) {
        self.builder.start_node(SyntaxKind::ModuleExports.into());

        self.expect(SyntaxKind::LBrace);

        loop {
            self.eat_trivia();
            if self.at(SyntaxKind::RBrace) {
                break;
            }

            self.parse_export_item();
            self.eat_trivia();

            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }

            // Allow trailing comma or closing brace; otherwise bail.
            if self.at(SyntaxKind::RBrace) {
                break;
            }

            // Preserve progress.
            self.error_here("Expected ',' or '}' in module export list");
            break;
        }

        self.expect(SyntaxKind::RBrace);
        self.builder.finish_node();
    }

    fn parse_export_item(&mut self) {
        self.builder.start_node(SyntaxKind::ExportItem.into());

        if self.at(SyntaxKind::KwModule) {
            // module <name> [\\ <name>]
            self.builder.start_node(SyntaxKind::ModuleReference.into());
            self.bump();
            self.eat_trivia();
            self.parse_module_name();

            self.eat_trivia();
            if self.at(SyntaxKind::Backslash) {
                self.builder.start_node(SyntaxKind::ModuleDiff.into());
                self.bump();
                self.eat_trivia();
                self.parse_module_name();
                self.builder.finish_node();
            }

            self.builder.finish_node();
        } else if self.at(SyntaxKind::Ident) {
            self.bump();
        } else {
            self.error_here("Expected export item");
        }

        self.builder.finish_node();
    }

    fn eat_trivia(&mut self) {
        while self.current().is_trivia() {
            self.bump();
        }
    }

    fn eat_trivia_excluding_post_doc(&mut self) {
        while self.current().is_trivia() && !self.at(SyntaxKind::DocLineCommentPost) {
            self.bump();
        }
    }

    fn parse_attr_seq_if_present(&mut self) {
        if !self.at_double_lbracket() {
            return;
        }

        self.builder.start_node(SyntaxKind::Attrs.into());
        while self.at_double_lbracket() {
            self.parse_attr_block();
            self.eat_trivia();
        }
        self.builder.finish_node();
    }

    fn parse_attr_block(&mut self) {
        self.builder.start_node(SyntaxKind::AttrBlock.into());

        // `[[`
        self.expect(SyntaxKind::LBracket);
        self.expect(SyntaxKind::LBracket);

        loop {
            self.eat_trivia();
            if self.at_double_rbracket() || self.at(SyntaxKind::Eof) {
                break;
            }

            self.parse_attr_item();
            self.eat_trivia();

            if self.at(SyntaxKind::Comma) {
                self.bump();
                continue;
            }

            if self.at_double_rbracket() {
                break;
            }

            // Keep progress.
            self.bump();
        }

        // `]]`
        self.expect(SyntaxKind::RBracket);
        self.expect(SyntaxKind::RBracket);

        self.builder.finish_node();
    }

    fn parse_attr_item(&mut self) {
        self.builder.start_node(SyntaxKind::AttrItem.into());

        // Usually an identifier (async, pipelined, latency, ...). Keep permissive.
        if !self.at(SyntaxKind::Eof) && !self.at_double_rbracket() && !self.at(SyntaxKind::Comma) {
            self.bump();
        }

        self.eat_trivia();

        if self.at(SyntaxKind::LParen) {
            self.consume_balanced_pair(SyntaxKind::LParen, SyntaxKind::RParen);
        }

        self.builder.finish_node();
    }

    fn at_double_lbracket(&self) -> bool {
        self.at(SyntaxKind::LBracket)
            && self
                .tokens
                .get(self.pos + 1)
                .is_some_and(|t| t.kind == SyntaxKind::LBracket)
    }

    fn at_double_rbracket(&self) -> bool {
        self.at(SyntaxKind::RBracket)
            && self
                .tokens
                .get(self.pos + 1)
                .is_some_and(|t| t.kind == SyntaxKind::RBracket)
    }

    fn consume_until_body_or_semi(&mut self) {
        // Consume tokens until we hit a braced body or a terminating semicolon.
        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }

            match self.current() {
                SyntaxKind::LBrace => {
                    self.consume_balanced_pair(SyntaxKind::LBrace, SyntaxKind::RBrace);
                    // Optional trailing semicolon.
                    self.eat_trivia_excluding_post_doc();
                    if self.at(SyntaxKind::Semi) {
                        self.bump();
                    }
                    break;
                }
                SyntaxKind::Semi => {
                    self.bump();
                    break;
                }
                _ => self.bump(),
            }
        }
    }

    fn consume_until_semi_or_eof(&mut self) {
        while !self.at(SyntaxKind::Eof) {
            if self.at(SyntaxKind::Semi) {
                self.bump();
                break;
            }
            self.bump();
        }
    }

    fn consume_until_item_boundary(&mut self) {
        // Stop before the next known top-level item keyword.
        while !self.at(SyntaxKind::Eof) {
            if self.current().is_trivia() {
                self.bump();
                continue;
            }
            match self.current() {
                SyntaxKind::KwModule
                | SyntaxKind::KwImport
                | SyntaxKind::KwExtern
                | SyntaxKind::KwExport
                | SyntaxKind::KwTemplate
                | SyntaxKind::KwStruct
                | SyntaxKind::KwEnum
                | SyntaxKind::KwUnion
                | SyntaxKind::KwUsing
                | SyntaxKind::KwStatic
                | SyntaxKind::KwStaticAssert => break,
                _ => self.bump(),
            }
        }
    }

    fn consume_balanced_pair(&mut self, open: SyntaxKind, close: SyntaxKind) {
        // Assumes current token is `open`.
        if !self.at(open) {
            return;
        }

        let mut depth: usize = 0;

        while !self.at(SyntaxKind::Eof) {
            if self.at(open) {
                depth += 1;
                self.bump();
                continue;
            }

            // Treat `>>` as two `>` tokens when balancing `<...>` lists.
            if open == SyntaxKind::Lt && close == SyntaxKind::Gt && self.at(SyntaxKind::Shr) {
                depth = depth.saturating_sub(2);
                self.bump();
                if depth == 0 {
                    break;
                }
                continue;
            }

            if self.at(close) {
                depth = depth.saturating_sub(1);
                self.bump();
                if depth == 0 {
                    break;
                }
                continue;
            }

            self.bump();
        }
    }

    fn wrap_error_token(&mut self) {
        self.builder.start_node(SyntaxKind::ErrorNode.into());
        self.bump();
        self.builder.finish_node();
    }

    fn at(&self, kind: SyntaxKind) -> bool {
        self.current() == kind
    }

    fn current(&self) -> SyntaxKind {
        self.tokens
            .get(self.pos)
            .map(|t| t.kind)
            .unwrap_or(SyntaxKind::Eof)
    }

    fn current_span(&self) -> crate::Span {
        self.tokens
            .get(self.pos)
            .map(|t| t.span)
            .unwrap_or(crate::Span::new(self.text.len(), self.text.len()))
    }

    fn bump(&mut self) {
        let Some(token) = self.tokens.get(self.pos).cloned() else {
            return;
        };
        self.pos += 1;

        match token.kind {
            SyntaxKind::Eof => {}
            SyntaxKind::Error => {
                // Keep lexer error tokens visible in the tree.
                self.builder
                    .token(SyntaxKind::Error.into(), self.slice(&token));
            }
            SyntaxKind::String => {
                self.emit_string_literal_token(&token);
            }
            _ => self.builder.token(token.kind.into(), self.slice(&token)),
        }
    }

    fn emit_string_literal_token(&mut self, token: &LexedToken) {
        let s = self.slice(token);

        // Defensive: if it isn't a quoted string for some reason, just preserve as-is.
        if !s.starts_with('"') || !s.ends_with('"') || s.len() < 2 {
            self.builder.token(SyntaxKind::String.into(), s);
            return;
        }

        let has_interp = self.string_has_interpolation(s);
        let node_kind = if has_interp {
            SyntaxKind::InterpolatedStringExpr
        } else {
            SyntaxKind::StringLiteralExpr
        };

        self.builder.start_node(node_kind.into());

        // Opening quote.
        self.builder.token(SyntaxKind::StringQuote.into(), &s[0..1]);

        // Body: split into text/escape/interpolation chunks.
        let body = &s[1..s.len() - 1];
        let mut i: usize = 0;
        let mut text_start: usize = 0;

        while i < body.len() {
            let b = body.as_bytes()[i];

            // Escape sequence.
            if b == b'\\' {
                if text_start < i {
                    self.builder
                        .token(SyntaxKind::StringText.into(), &body[text_start..i]);
                }

                let esc_end = (i + 2).min(body.len());
                self.builder
                    .token(SyntaxKind::StringEscape.into(), &body[i..esc_end]);
                i = esc_end;
                text_start = i;
                continue;
            }

            // Interpolation start: a single '{' (treat '{{' as literal text).
            if b == b'{' {
                if i + 1 < body.len() && body.as_bytes()[i + 1] == b'{' {
                    // Literal "{{".
                    i += 2;
                    continue;
                }

                if text_start < i {
                    self.builder
                        .token(SyntaxKind::StringText.into(), &body[text_start..i]);
                }

                if let Some(end) = Self::find_matching_rbrace_in_string(body, i) {
                    self.builder
                        .start_node(SyntaxKind::StringInterpolation.into());
                    // Include braces as real tokens for downstream tooling.
                    self.builder
                        .token(SyntaxKind::LBrace.into(), &body[i..i + 1]);
                    if i + 1 < end {
                        self.builder
                            .token(SyntaxKind::StringText.into(), &body[i + 1..end]);
                    }
                    self.builder
                        .token(SyntaxKind::RBrace.into(), &body[end..end + 1]);
                    self.builder.finish_node();

                    i = end + 1;
                    text_start = i;
                    continue;
                }

                // No matching '}' -> treat the '{' as text.
                i += 1;
                continue;
            }

            i += 1;
        }

        if text_start < body.len() {
            self.builder
                .token(SyntaxKind::StringText.into(), &body[text_start..]);
        }

        // Closing quote.
        self.builder
            .token(SyntaxKind::StringQuote.into(), &s[s.len() - 1..]);

        self.builder.finish_node();
    }

    fn string_has_interpolation(&self, s: &str) -> bool {
        let body = &s[1..s.len().saturating_sub(1)];
        let mut i: usize = 0;
        while i < body.len() {
            let b = body.as_bytes()[i];
            if b == b'\\' {
                i = (i + 2).min(body.len());
                continue;
            }
            if b == b'{' {
                if i + 1 < body.len() && body.as_bytes()[i + 1] == b'{' {
                    i += 2;
                    continue;
                }
                if Self::find_matching_rbrace_in_string(body, i).is_some() {
                    return true;
                }
            }
            i += 1;
        }
        false
    }

    fn find_matching_rbrace_in_string(body: &str, start_lbrace: usize) -> Option<usize> {
        // `start_lbrace` indexes into `body` at a '{'. Find the matching '}' while
        // respecting nested braces inside the interpolation expression.
        if start_lbrace >= body.len() || body.as_bytes()[start_lbrace] != b'{' {
            return None;
        }

        let bytes = body.as_bytes();
        let mut i = start_lbrace;
        let mut depth: usize = 0;

        while i < body.len() {
            let b = bytes[i];

            if b == b'\\' {
                i = (i + 2).min(body.len());
                continue;
            }

            if b == b'{' {
                depth += 1;
                i += 1;
                continue;
            }

            if b == b'}' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(i);
                }
                i += 1;
                continue;
            }

            i += 1;
        }

        None
    }
    fn slice(&self, token: &LexedToken) -> &'a str {
        &self.text[token.span.start..token.span.end]
    }

    fn expect(&mut self, kind: SyntaxKind) {
        if self.at(kind) {
            self.bump();
        } else {
            self.error_here(format!("Expected {:?}", kind));
        }
    }

    fn error_here(&mut self, msg: impl Into<String>) {
        let span = self.current_span();
        self.diagnostics.push(Diagnostic::error(msg, span));

        // Make forward progress by consuming something.
        if !self.at(SyntaxKind::Eof) {
            self.wrap_error_token();
        }
    }
}
