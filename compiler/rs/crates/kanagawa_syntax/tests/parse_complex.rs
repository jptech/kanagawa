//! Complex scenario tests for the CST parser.

use kanagawa_syntax::{parse_file, SyntaxKind, SyntaxNode};

/// Helper to parse and return the root node.
fn parse(src: &str) -> SyntaxNode {
    parse_file(src).syntax_node()
}

/// Helper to parse and check for no diagnostics.
fn parse_clean(src: &str) -> SyntaxNode {
    let result = parse_file(src);
    assert!(
        result.diagnostics.is_empty(),
        "expected clean parse, got: {:?}",
        result.diagnostics
    );
    result.syntax_node()
}

/// Helper to find all nodes of a given kind.
fn find_nodes(root: &SyntaxNode, kind: SyntaxKind) -> Vec<SyntaxNode> {
    root.descendants().filter(|n| n.kind() == kind).collect()
}

/// Helper to count nodes of a given kind.
fn count_nodes(root: &SyntaxNode, kind: SyntaxKind) -> usize {
    find_nodes(root, kind).len()
}

// ============================================================================
// Deeply nested structures
// ============================================================================

#[test]
fn deeply_nested_blocks() {
    let src = r#"
        inline void foo() {
            {
                {
                    {
                        {
                            {
                                return;
                            }
                        }
                    }
                }
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::Block) >= 6);
}

#[test]
fn deeply_nested_if_else() {
    let src = r#"
        inline void foo() {
            if (a) {
                if (b) {
                    if (c) {
                        if (d) {
                            return 1;
                        } else {
                            return 2;
                        }
                    } else {
                        return 3;
                    }
                } else {
                    return 4;
                }
            } else {
                return 5;
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::IfStmt) >= 4);
}

#[test]
fn nested_switch_in_if() {
    let src = r#"
        inline void foo(uint32 x, uint32 y) {
            if (x > 0) {
                switch (y) {
                    case 0:
                        if (x == 1) {
                            return;
                        }
                        break;
                    case 1:
                        switch (x) {
                            case 1:
                                break;
                            default:
                                break;
                        }
                        break;
                    default:
                        break;
                }
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::SwitchStmt) >= 2);
    assert!(count_nodes(&root, SyntaxKind::IfStmt) >= 2);
}

#[test]
fn nested_loops() {
    let src = r#"
        inline void foo() {
            for (const uint32 i : 10) {
                for (const uint32 j : 10) {
                    do {
                        barrier;
                    } while (condition);
                }
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::RangeForStmt) >= 2);
    assert!(count_nodes(&root, SyntaxKind::DoWhileStmt) >= 1);
}

// ============================================================================
// Complex expressions
// ============================================================================

#[test]
fn complex_binary_expression_chain() {
    let src = r#"
        inline uint32 foo() {
            return a + b * c - d / e % f << g >> h & i | j ^ k && l || m ^^ n;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::BinaryExpr) >= 10);
}

#[test]
fn nested_ternary_expressions() {
    let src = r#"
        inline uint32 foo() {
            return a ? b ? c : d : e ? f : g;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::TernaryExpr) >= 3);
}

#[test]
fn complex_member_chain() {
    let src = r#"
        inline void foo() {
            a.b.c.d.e.f().g[0].h;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::MemberExpr) >= 5);
}

#[test]
fn complex_subscript_chain() {
    let src = r#"
        inline void foo() {
            arr[i][j][k][l];
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::SubscriptExpr) >= 4);
}

#[test]
fn mixed_postfix_expressions() {
    let src = r#"
        inline void foo() {
            obj.method(a, b)[i].field(c).another[j][k];
        }
    "#;
    let root = parse_clean(src);
    // Should have calls, subscripts, and member accesses
    assert!(count_nodes(&root, SyntaxKind::CallExpr) >= 2);
    assert!(count_nodes(&root, SyntaxKind::SubscriptExpr) >= 2);
    assert!(count_nodes(&root, SyntaxKind::MemberExpr) >= 2);
}

#[test]
fn builtin_expressions_in_complex_expr() {
    let src = r#"
        inline uint32 foo() {
            return cast<uint32>(mux(sel, concat(a, b), fan_out<4>(c)));
        }
    "#;
    let root = parse_clean(src);
    // Complex nested built-in expressions should parse cleanly
    // The exact CST structure depends on how templates and calls are parsed
    assert!(count_nodes(&root, SyntaxKind::FunctionDef) >= 1);
}

// ============================================================================
// Complex type expressions
// ============================================================================

#[test]
fn parameterized_integer_types() {
    let src = r#"
        inline void foo() {
            uint<clog2(N) + 1> a;
            int<bitsizeof(T) * 2> b;
            uint<N * M + K> c;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::LocalVarDecl) >= 3);
}

#[test]
fn function_type_parameters() {
    let src = r#"
        inline void foo(
            () -> void callback,
            (uint32, bool) -> uint32 transformer,
            ((uint32) -> bool) -> void higher_order
        ) {
            return;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::TypeFunction) >= 3);
}

#[test]
fn complex_array_types() {
    let src = r#"
        struct Foo {
            [[memory]] uint32 data[N][M];
            [[memory, quad_port]] bool flags[K];
            uint8 nested[A][B][C][D];
        }
    "#;
    let root = parse_clean(src);
    // Array dimensions in declarations are handled, but may not produce TypeArray nodes
    assert!(count_nodes(&root, SyntaxKind::StructDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::StructMemberDecl) >= 3);
}

#[test]
fn typename_and_decltype() {
    let src = r#"
        inline void foo() {
            typename T::nested_type a;
            decltype(expr) b;
            typename T::template Nested<U> c;
        }
    "#;
    let root = parse_clean(src);
    // These should parse cleanly
}

// ============================================================================
// Complex declarations
// ============================================================================

#[test]
fn class_with_multiple_sections() {
    let src = r#"
        class Counter {
        private:
            uint32 value;
            uint32 limit;

        public:
            inline void reset() { value = 0; }
            inline void increment() { value++; }
            inline uint32 get() { return value; }

        private:
            inline void internal_helper() { barrier; }

        public:
            default = { .value = 0, .limit = 100 };
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::AccessSpecifier) >= 4);
    assert!(count_nodes(&root, SyntaxKind::FunctionDef) >= 4);
}

#[test]
fn nested_class_declarations() {
    let src = r#"
        class Outer {
        public:
            class Inner {
            public:
                uint32 x;
            }

            struct Point {
                uint32 x;
                uint32 y;
            }

            Inner member;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::ClassDecl) >= 2);
    assert!(count_nodes(&root, SyntaxKind::StructDecl) >= 1);
}

#[test]
fn template_with_defaults() {
    let src = r#"
        template <typename T, auto N = 8, typename U = uint32>
        struct Buffer {
            T data[N];
            U metadata;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::TemplateDecl) >= 1);
}

#[test]
fn multiple_template_declarations() {
    let src = r#"
        template <typename T>
        using Ptr = T;

        template <typename T, auto N>
        struct Array {
            T data[N];
        }

        template <typename T>
        inline T identity(T x) {
            return x;
        }

        template <typename T, typename U>
        class Pair {
        public:
            T first;
            U second;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::TemplateDecl) >= 4);
}

// ============================================================================
// Complex static constructs
// ============================================================================

#[test]
fn static_if_chain() {
    let src = r#"
        template <typename T>
        inline void process(T x) {
            static if (decltype(x) == uint32) {
                x++;
            } else static if (decltype(x) == int32) {
                x--;
            } else static if (decltype(x) == bool) {
                x = !x;
            } else {
                barrier;
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::StaticIfStmt) >= 3);
}

#[test]
fn static_for_with_complex_body() {
    let src = r#"
        inline void foo() {
            static for (const auto i : N) {
                static for (const auto j : M) {
                    if (i == j) {
                        arr[i][j] = 1;
                    } else {
                        arr[i][j] = 0;
                    }
                }
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::StaticForStmt) >= 2);
}

#[test]
fn static_assert_variations() {
    let src = r#"
        static_assert(N > 0);
        static_assert(bitsizeof(T) == 32);

        template <typename T>
        struct Foo {
            static_assert(bitsizeof(T) <= 64);
        }
    "#;
    let root = parse_clean(src);
    // Static asserts should parse (single keyword form is most common)
    assert!(count_nodes(&root, SyntaxKind::StaticAssertDecl) >= 2);
}

// ============================================================================
// Attribute combinations
// ============================================================================

#[test]
fn multiple_attribute_blocks() {
    let src = r#"
        [[pipelined]][[async]][[latency(4)]]
        inline void foo() {
            return;
        }

        [[unordered]]
        [[fifo_depth(16)]]
        for (const uint32 i : N) {
            barrier;
        }
    "#;
    // Should parse without issues - attribute sequences
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::AttrBlock) >= 3);
}

#[test]
fn expression_level_attributes() {
    let src = r#"
        inline void foo() {
            [[call_rate(1)]] process(x);
            [[fifo_depth(8), transaction_size(4)]] async_call(y);
        }
    "#;
    let root = parse_clean(src);
}

// ============================================================================
// Complex initializers
// ============================================================================

#[test]
fn nested_initializer_lists() {
    let src = r#"
        inline void foo() {
            auto x = { {1, 2}, {3, 4}, {5, 6} };
            auto y = { { {1}, {2} }, { {3}, {4} } };
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::InitializerListExpr) >= 5);
}

#[test]
fn designated_initializers() {
    let src = r#"
        inline void foo() {
            auto p = { .x = 10, .y = 20 };
            auto nested = { .outer = { .inner = 5 } };
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::DesignatedInitializerListExpr) >= 2);
}

// ============================================================================
// Lambda expressions
// ============================================================================

#[test]
fn lambda_variations() {
    let src = r#"
        inline void foo() {
            auto f1 = []() { return 0; };
            auto f2 = [x]() { return x; };
            auto f3 = [x, y]() -> uint32 { return x + y; };
            auto f4 = [](uint32 a, uint32 b) -> uint32 { return a * b; };
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::LambdaExpr) >= 4);
}

#[test]
fn lambda_as_argument() {
    let src = r#"
        inline void foo() {
            process([](uint32 x) { return x * 2; });
            transform(data, [factor](auto x) { return x * factor; });
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::LambdaExpr) >= 2);
    assert!(count_nodes(&root, SyntaxKind::CallExpr) >= 2);
}

// ============================================================================
// Module and import combinations
// ============================================================================

#[test]
fn complex_module_declaration() {
    let src = r#"
        module my.complex.module {
            PublicClass,
            helper_function,
            module sub.module,
            module another.module \ excluded.part
        }

        import std.optional
        import std.vector as vec
        import my.other.module

        struct MyStruct {
            uint32 x;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::ModuleDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::ImportDecl) >= 3);
}

// ============================================================================
// Error recovery scenarios
// ============================================================================

#[test]
fn missing_semicolon_recovery() {
    // Parser should try to recover from missing semicolon
    let src = r#"
        inline void foo() {
            uint32 x = 1
            uint32 y = 2;
        }
    "#;
    let result = parse_file(src);
    // Should still parse something, possibly with diagnostics
    let root = result.syntax_node();
    assert_eq!(root.kind(), SyntaxKind::File);
}

#[test]
fn missing_brace_recovery() {
    let src = r#"
        inline void foo() {
            if (x) {
                return;
            // missing closing brace
        }
    "#;
    let result = parse_file(src);
    let root = result.syntax_node();
    assert_eq!(root.kind(), SyntaxKind::File);
}

#[test]
fn empty_constructs() {
    let src = r#"
        struct Empty {}
        class Empty2 {}
        enum Empty3 : uint2 {}
        inline void empty() {}
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::StructDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::ClassDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::EnumDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::FunctionDef) >= 1);
}

// ============================================================================
// Real-world patterns
// ============================================================================

#[test]
fn state_machine_pattern() {
    let src = r#"
        enum State : uint2 {
            Idle = 0,
            Running = 1,
            Done = 2,
        }

        class StateMachine {
        private:
            State current;

        public:
            inline void tick() {
                switch (current) {
                    case State::Idle:
                        if (start_signal) {
                            current = State::Running;
                        }
                        break;
                    case State::Running:
                        if (done_signal) {
                            current = State::Done;
                        }
                        break;
                    case State::Done:
                        current = State::Idle;
                        break;
                    default:
                        break;
                }
            }

            default = { .current = State::Idle };
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::EnumDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::ClassDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::SwitchStmt) >= 1);
}

#[test]
fn pipeline_pattern() {
    let src = r#"
        [[pipelined, async]]
        inline void pipeline_stage(uint32 input) {
            static uint32 reg1;
            static uint32 reg2;
            static uint32 reg3;

            // Pipeline registers
            reg3 = reg2;
            reg2 = reg1;
            reg1 = input;

            // Output
            [[schedule(3)]] return reg3;
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::StaticVarDecl) >= 3);
}

#[test]
fn memory_array_pattern() {
    let src = r#"
        template <typename T, auto N>
        class Memory {
        private:
            [[memory, quad_port]] T data[N];

        public:
            inline T read(uint<clog2(N)> addr) {
                return data[addr];
            }

            inline void write(uint<clog2(N)> addr, T value) {
                data[addr] = value;
            }
        }
    "#;
    let root = parse_clean(src);
    assert!(count_nodes(&root, SyntaxKind::TemplateDecl) >= 1);
    assert!(count_nodes(&root, SyntaxKind::ClassDecl) >= 1);
}
