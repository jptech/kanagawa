use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

fn has(root: &SyntaxNode, kind: SyntaxKind) -> bool {
    root.descendants().any(|n| n.kind() == kind)
}

fn node_has_token(node: &SyntaxNode, kind: SyntaxKind) -> bool {
    node.descendants_with_tokens()
        .any(|it| it.as_token().is_some_and(|tok| tok.kind() == kind))
}

fn find_call_with_callee_kw(root: &SyntaxNode, kw: SyntaxKind) -> SyntaxNode {
    root.descendants()
        .find(|n| n.kind() == SyntaxKind::CallExpr && node_has_token(n, kw))
        .unwrap_or_else(|| panic!("expected CallExpr containing token {kw:?}"))
}

#[test]
fn parses_builtin_spellings_as_stable_call_subtrees() {
    let src = r#"
        inline uint32 f(uint32 x) {
            // Builtins modeled as keywords in the lexer.
            auto a = mux(1, 2, 3);
            auto b = concat(1, 2, 3);
            auto c = lutmul(4, 5);
            auto d = static(1 + 2 * 3);
            auto e = fan_out<2>(x);
            auto bo = bitoffsetof(uint32, field);
            auto byo = byteoffsetof(uint32, field);
            return a + b + c + d + e + bo + byo;
        }
    "#;

    let parse = parse_file(src);
    assert!(parse.diagnostics.is_empty(), "{:?}", parse.diagnostics);

    let root = parse.syntax_node();
    assert!(has(&root, SyntaxKind::CallExpr));

    let mux_call = find_call_with_callee_kw(&root, SyntaxKind::KwMux);
    assert!(mux_call.descendants().any(|n| n.kind() == SyntaxKind::ArgList));

    let concat_call = find_call_with_callee_kw(&root, SyntaxKind::KwConcat);
    assert!(concat_call.descendants().any(|n| n.kind() == SyntaxKind::ArgList));

    let lutmul_call = find_call_with_callee_kw(&root, SyntaxKind::KwLutmul);
    assert!(lutmul_call.descendants().any(|n| n.kind() == SyntaxKind::ArgList));

    let static_call = find_call_with_callee_kw(&root, SyntaxKind::KwStatic);
    assert!(
        static_call
            .descendants()
            .any(|n| n.kind() == SyntaxKind::BinaryExpr),
        "expected parsed binary ops inside static(...)"
    );

    let fanout_call = find_call_with_callee_kw(&root, SyntaxKind::KwFanOut);
    assert!(
        fanout_call
            .descendants()
            .any(|n| n.kind() == SyntaxKind::TypeTemplateArgs),
        "expected structured template args for fan_out<...>(...)"
    );
    assert!(
        fanout_call
            .descendants()
            .any(|n| n.kind() == SyntaxKind::TypeTemplateArg && n.descendants().any(|c| c.kind() == SyntaxKind::Expr)),
        "expected at least one value template arg parsed as Expr"
    );

    let bitoffsetof_call = find_call_with_callee_kw(&root, SyntaxKind::KwBitoffsetof);
    assert!(
        bitoffsetof_call
            .descendants()
            .any(|n| n.kind() == SyntaxKind::Type),
        "expected first argument parsed as Type"
    );

    let byteoffsetof_call = find_call_with_callee_kw(&root, SyntaxKind::KwByteoffsetof);
    assert!(
        byteoffsetof_call
            .descendants()
            .any(|n| n.kind() == SyntaxKind::Type),
        "expected first argument parsed as Type"
    );
}
