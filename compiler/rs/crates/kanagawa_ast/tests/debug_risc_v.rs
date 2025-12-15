//! Debug test for template declaration error in risc_v files

use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};
use kanagawa_ast::lower_file;

fn print_tree(node: &SyntaxNode, src: &str, indent: usize, max_depth: usize) {
    if indent > max_depth {
        return;
    }
    let offset: usize = node.text_range().start().into();
    let line = src[..offset].matches('\n').count() + 1;
    let text: String = node.text().to_string().chars().take(60).collect();
    eprintln!(
        "{}L{} {:?} {:?}",
        "  ".repeat(indent),
        line,
        node.kind(),
        text.replace('\n', "\\n")
    );
    for child in node.children() {
        print_tree(&child, src, indent + 1, max_depth);
    }
}

#[test]
fn debug_risc_v_template() {
    // Test exact pattern from risc_v/internal/core.k lines 73-87
    let src = r#"
template <
    auto HARTS,
    auto IMEM_LENGTH,
    auto DMEM_LENGTH,
    auto MMIO_LENGTH = 0,
    auto IMEM_ORIGIN = 0,
    auto DMEM_ORIGIN = ((IMEM_ORIGIN + IMEM_LENGTH) << 2),
    auto MMIO_ORIGIN = DMEM_ORIGIN + DMEM_LENGTH,
    auto IMEM_TCM_SIZE = IMEM_LENGTH,
    template <typename, auto> typename DataMemory = memory_norep,
    auto EXTENSIONS = Extension::None,
    auto CONFIG = Optimize::Area,
    Base ISA = Base::RV32I,
    auto BTB_SIZE = 1024,
    template <typename, auto> typename InstrMemory = memory_init>
class Core
{
    const bool EXTERNAL_FETCH = false;
}
"#;
    let parse = parse_file(src);

    eprintln!("CST diagnostics: {:?}", parse.diagnostics);

    // Count TemplateDecls
    let template_count = parse.syntax_node().descendants()
        .filter(|n| n.kind() == SyntaxKind::TemplateDecl)
        .count();
    eprintln!("Found {} TemplateDecl nodes (should be 1)", template_count);

    // Print full tree for templates
    for node in parse.syntax_node().descendants() {
        if node.kind() == SyntaxKind::TemplateDecl {
            let offset: usize = node.text_range().start().into();
            let line = src[..offset].matches('\n').count() + 1;
            let children: Vec<_> = node.children().map(|c| c.kind()).collect();
            eprintln!("\nTemplateDecl at line {}: children = {:?}", line, children);
        }
    }

    match lower_file(&parse.syntax_node()) {
        Ok(_) => eprintln!("\nAST lowering succeeded!"),
        Err(e) => eprintln!("\nAST lowering failed: {:?}", e),
    }
}
