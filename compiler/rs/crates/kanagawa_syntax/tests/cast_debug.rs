//! Debug test for cast expression CST structure.

use kanagawa_syntax::{parse_file, SyntaxNode};

fn print_tree(node: &SyntaxNode, indent: usize) {
    let text: String = node.text().to_string().chars().take(50).collect();
    eprintln!(
        "{}{:?} {:?}",
        " ".repeat(indent),
        node.kind(),
        text
    );
    for child in node.children() {
        print_tree(&child, indent + 2);
    }
    // Also print token children for leaf inspection
    for token in node.children_with_tokens() {
        if let rowan::NodeOrToken::Token(t) = token {
            if !t.kind().is_trivia() {
                let ttext: String = t.text().chars().take(30).collect();
                eprintln!("{}  TOKEN {:?} {:?}", " ".repeat(indent), t.kind(), ttext);
            }
        }
    }
}

#[test]
fn debug_cast_cst() {
    let src = r#"
function test() {
    const auto x = cast<uint32>(1);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_cast_in_static_assert() {
    let src = r#"
function test() {
    static assert(cast<U>(-1) > 0);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_cast_nested_template() {
    let src = r#"
function test() {
    const auto x = cast<index_t<5>>(10);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_cast_paren_in_template() {
    let src = r#"
function test(uint32 fraction) {
    const auto x = cast<Foo<1, (2 - 1)>>(fraction);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_cast_bitsizeof_in_template() {
    let src = r#"
function test(uint32 input) {
    auto input_bits = cast<bool[bitsizeof input]>(input);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_template_template_param() {
    let src = r#"
template
    < auto Size
    , template <typename, auto> typename Memory = memory
    >
class bitarray
{
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_do_while_empty_body() {
    let src = r#"
function test() {
    do ; while (x > 0);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_do_while_block_body() {
    let src = r#"
function test() {
    do { x = x + 1; } while (x > 0);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_export_name() {
    let src = r#"
class Foo { }
export Foo;
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_array_member_assign() {
    let src = r#"
function test() {
    result.data[i] = x;
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_subscript_assign() {
    let src = r#"
function test() {
    r[i] = f(x);
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}

#[test]
fn debug_double_subscript_assign() {
    let src = r#"
function test() {
    results[0][i] = x;
}
"#;
    let parse = parse_file(src);

    eprintln!("Diagnostics: {:?}", parse.diagnostics);
    print_tree(&parse.syntax_node(), 0);
}
