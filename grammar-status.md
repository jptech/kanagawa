# Kanagawa grammar status (Rust frontend)

This document tracks the current implementation/testing status of the Rust frontend grammar work against:

- Canonical language notes: [grammar.md](grammar.md)
- Canonical parser implementation: [compiler/hs/lib/Language/Kanagawa/Parser.hs](compiler/hs/lib/Language/Kanagawa/Parser.hs) and [compiler/hs/lib/Language/Kanagawa/Parser/Lexer.hs](compiler/hs/lib/Language/Kanagawa/Parser/Lexer.hs)
- Editor-oriented (approximate) grammar: [tools/editors/vscode-new/grammar/grammar.js](tools/editors/vscode-new/grammar/grammar.js)

## Current Implementation Scope

The Rust frontend currently implements four layers:

1. **Lexer** (`kanagawa_syntax`): Tokenizes source files into a token stream with full keyword/operator coverage
2. **CST Parser** (`kanagawa_syntax`): Builds a lossless Concrete Syntax Tree using rowan
3. **AST Layer** (`kanagawa_ast`): Provides typed AST nodes and CST→AST lowering
4. **HIR Layer** (`kanagawa_hir`): Semantic representation with name resolution, symbol table, and type information

**Not yet implemented:** Full type checking, template instantiation, AST→ParseTree emission via C ABI.

## Legend

- **Working**: Fully implemented with dedicated CST/AST nodes and covered by unit tests
- **Partial**: Implemented but with limitations (e.g., parsed generically rather than specifically)
- **Missing**: Not specially recognized or structured yet

Test coverage is primarily under:
- [compiler/rs/crates/kanagawa_syntax/tests/](compiler/rs/crates/kanagawa_syntax/tests/) (42 tests)
- [compiler/rs/crates/kanagawa_ast/tests/](compiler/rs/crates/kanagawa_ast/tests/) (35 tests)
- [compiler/rs/crates/kanagawa_hir/tests/](compiler/rs/crates/kanagawa_hir/tests/) (39 tests, 0 ignored)
- `kanagawa_hir` unit tests (25 tests) and doc tests (3 tests)

## High-level Status

| Component | Status | Test Count |
|-----------|--------|------------|
| Lexer | Working | 4 tests |
| CST Parser | Working | 38 tests |
| AST Types | Working | - |
| CST→AST Lowering | Working | 35 tests |
| HIR Types | Working | 25 tests |
| AST→HIR Lowering | Working | 39 tests (0 ignored) |

## 1) Lexical Structure

| Area | Status | Evidence |
|------|--------|----------|
| Keywords (full reserved set) | Working | `lexer.rs:207-263` - 45 keywords including `mux`, `concat`, `fan_out`, `lutmul`, `cast`, `bitsizeof`, etc. |
| Operators (arithmetic, bitwise, logical) | Working | `lexer.rs:44-170` - All operators including `^^` (logical xor) |
| Compound assignment operators | Working | `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `\|=`, `^=`, `&&=`, `\|\|=` |
| Integer literals (dec/hex/bin/oct + suffix) | Working | `lexer.rs:34-49` + `tests/lexer_repo.rs` |
| Float literals | Working | `lexer.rs:43-46` |
| String literals | Working | Plain strings + interpolated strings with `{expr}` |
| Nested block comments `/* ... /* ... */ ... */` | Working | `lexer.rs:173-205` + `tests/lexer_repo.rs` |
| Doc comments `//\|` and `//<` | Working | `lexer.rs:16-20` + `tests/doc_attach.rs` |

## 2) Modules and Imports

| Construct | CST Status | AST Status | Tests |
|-----------|------------|------------|-------|
| `module <name> { exports }` | Working | Working | `tests/parse_module_import.rs`, `tests/lower_basic.rs` |
| `import <name> [as alias]` | Working | Working | `tests/parse_module_import.rs`, `tests/lower_basic.rs` |
| Special modules `.cmdargs` / `.options` | Working | Working | `parse.rs` module name segments |
| Module exports (ident, `module X`, `module A \ B`) | Working | Working | `tests/parse_module_import.rs` |

## 3) Attributes (`[[...]]`)

| Attribute Context | CST Status | AST Status | Tests |
|-------------------|------------|------------|-------|
| Item attributes (before decls) | Working | Working | `tests/parse_top_level_more.rs` |
| Expression/call-site attributes | Working | Working | `tests/parse_expr_attrs.rs` |
| Statement attributes | Working | Working | `tests/parse_statements.rs` |
| Loop attributes | Working | Working | Harness (`loops.k`, `static-for.k`) |
| Memory/array attributes in types | Working | Working | `tests/parse_type_nodes.rs` |

## 4) Types

| Type Form | CST Status | AST Status | Tests |
|-----------|------------|------------|-------|
| Primitives (`void`, `bool`, `string`, `float32`, `auto`) | Working | Working | `tests/lower_basic.rs` |
| Fixed-width integers (`uint32`, `int8`) | Working | Working | `tests/lower_basic.rs` |
| Parameterized integers (`uint<N>`, `int<clog2(M)+1>`) | Working | Working | `tests/parse_expressions.rs` |
| `const T` | Working | Working | `parse.rs`, `types.rs:ConstType` |
| Array types `T[N]` | Working | Working | `tests/parse_type_nodes.rs` |
| Function types `(T, U) -> R` | Working | Working | `tests/parse_type_nodes.rs` |
| `typename T::Dependent` | Working | Working | `tests/parse_type_nodes.rs` |
| `decltype(expr)` | Working | Working | `tests/parse_type_nodes.rs` |

## 5) Declarations

| Construct | CST Status | AST Status | Tests |
|-----------|------------|------------|-------|
| Global variable declarations | Working | Working | `tests/parse_functions_vars.rs` |
| Local/static variable declarations | Working | Working | `tests/parse_block_decls.rs`, `tests/lower_basic.rs` |
| `using Name = Type;` | Working | Working | `tests/lower_basic.rs` |
| `enum Name : Type { variants }` | Working | Working | `tests/parse_types.rs`, `tests/lower_basic.rs` |
| `struct` / `union` with members | Working | Working | `tests/parse_types.rs`, `tests/lower_basic.rs` |
| `class` with members + access labels | Working | Working | `tests/parse_class.rs`, `tests/lower_basic.rs` |
| Class `default = <expr>;` | Working | Working | `tests/parse_decls_structured.rs` |
| Function declarations/definitions | Working | Working | `tests/parse_functions_vars.rs`, `tests/lower_basic.rs` |
| Templates `template <...> decl` | Working | Working | Harness (`template.k`) |
| `extern` / `export` wrappers | Working | Working | Harness (`extern-class.k`) |
| `static if` at top-level | Working | Working | `tests/parse_functions_vars.rs` |
| `static_assert(...)` / `static assert(...)` | Working | Working | `tests/parse_static_assert.rs`, `tests/lower_basic.rs` |

## 6) Statements

| Construct | CST Status | AST Status | Tests |
|-----------|------------|------------|-------|
| Empty `;` and expression statements | Working | Working | `tests/parse_statements.rs` |
| `return [expr];` | Working | Working | `tests/parse_statements.rs`, `tests/lower_basic.rs` |
| `barrier;` | Working | Working | `tests/parse_statements.rs` |
| `atomic` / `reorder` prefixes | Working | Working | `tests/parse_statements.rs`, Harness (`atomic.k`) |
| `if` / `else` | Working | Working | `tests/parse_statements.rs`, `tests/lower_basic.rs` |
| `switch { case ... }` | Working | Working | `tests/parse_statements.rs` |
| Range-for `for (const T i : expr) stmt` | Working | Working | `tests/parse_statements.rs`, `tests/lower_basic.rs` |
| `do stmt while (cond);` | Working | Working | `tests/parse_statements.rs`, `tests/lower_basic.rs` |
| `static if` / `static for` in blocks | Working | Working | `tests/parse_statements.rs`, Harness |
| `unrolled_for` | Working | Working | `tests/parse_unrolled_for.rs` |
| `break;` | Working | Working | `tests/parse_statements.rs` |
| `++x; x++; x += 1;` | Working | Working | `tests/parse_statements.rs` |
| Variable declarations in blocks | Working | Working | `tests/parse_block_decls.rs` |
| Annotated statements `[[attr]] stmt` | Working | Working | `tests/parse_statements.rs` |

## 7) Expressions

| Expression Form | CST Status | AST Status | Tests |
|-----------------|------------|------------|-------|
| Operator precedence (Pratt parser) | Working | Working | `tests/parse_expressions.rs`, `tests/lower_basic.rs` |
| Binary operators (`+ - * / % & \| ^ && \|\| ^^ << >>`) | Working | Working | `tests/parse_expressions.rs`, `tests/lower_basic.rs` |
| Unary operators (`- ! ~`) | Working | Working | Expression parsing |
| Ternary conditional `cond ? a : b` | Working | Working | Expression parsing |
| Assignment expressions | Working | Working | `tests/parse_expressions.rs` |
| Function calls `foo(a, b)` | Working | Working | `tests/lower_basic.rs` |
| Member access `x.field` | Working | Working | Expression parsing |
| Array subscript `arr[i]` | Working | Working | Expression parsing |
| `cast<Type>(expr)` | Working | Working | `tests/parse_builtin_terms.rs` |
| `mux(sel, a, b, ...)` | Working | Working | `tests/parse_builtin_terms.rs`, `tests/lower_basic.rs` |
| `concat(a, b, ...)` | Working | Working | `tests/parse_builtin_terms.rs`, `tests/lower_basic.rs` |
| `fan_out<N>(expr)` | Working | Working | `tests/parse_builtin_terms.rs` |
| `lutmul(a, b)` | Working | Working | `tests/parse_builtin_terms.rs` |
| `static(expr)` | Working | Working | `tests/lower_basic.rs` |
| `bitsizeof(T)` / `bytesizeof(T)` | Working | Working | `tests/parse_builtin_terms.rs`, `tests/lower_basic.rs` |
| `bitoffsetof(T, field)` / `byteoffsetof(T, field)` | Working | Partial | `tests/parse_builtin_terms.rs` |
| `clog2(expr)` | Working | Working | AST recognition in `lower_call_expr` |
| Template argument expressions (restricted mode) | Working | Working | `tests/parse_expressions.rs` |
| Lambdas `[captures](params) -> T { body }` | Working | Working | `tests/parse_lambda.rs` |
| Initializer lists `{a, b, c}` | Working | Working | `tests/parse_initializers.rs` |
| Designated initializers `{.x = a}` | Working | Working | `tests/parse_initializers.rs` |
| Interpolated strings `"{expr}"` | Working | Working | `tests/parse_strings.rs` |

*Note: `bitoffsetof` and `byteoffsetof` require special handling as they take a Type and field name rather than expressions. These are not yet fully lowered to dedicated AST types.*

## 8) AST Layer Details

The `kanagawa_ast` crate provides typed AST definitions and CST→AST lowering:

### AST Type Coverage

| Category | Types Defined |
|----------|---------------|
| File structure | `File`, `ModuleDecl`, `ModuleName`, `ModuleExport`, `ImportDecl` |
| Names | `Name`, `QualifiedName` |
| Declarations | `FunctionDecl`, `VariableDecl`, `StructDecl`, `EnumDecl`, `ClassDecl`, `UnionDecl`, `UsingDecl`, `TemplateDecl`, `StaticIfDecl`, `StaticAssertDecl`, `ExternDecl`, `ExportDecl` |
| Statements | `Block`, `ReturnStmt`, `IfStmt`, `SwitchStmt`, `DoWhileStmt`, `RangeForStmt`, `StaticForStmt`, `UnrolledForStmt`, `StaticIfStmt`, `ReorderStmt`, `AtomicStmt`, `ExprStmt`, `AssignStmt`, `AnnotatedStmt` |
| Expressions | `IntLiteral`, `FloatLiteral`, `BoolLiteral`, `StringLiteral`, `InterpolatedString`, `IdentExpr`, `BinaryExpr`, `UnaryExpr`, `TernaryExpr`, `CallExpr`, `MemberExpr`, `SubscriptExpr`, `CastExpr`, `MuxExpr`, `ConcatExpr`, `FanOutExpr`, `StaticExpr`, `InitializerList`, `DesignatedInitializer`, `LambdaExpr`, `SizeofExpr`, `OffsetofExpr` |
| Types | `PrimitiveType`, `IntegerType`, `NamedType`, `ArrayType`, `FunctionType`, `ConstType`, `TypenameType`, `DecltypeType` |
| Attributes | `Attribute`, `AttributeKind`, `AttributeFlag`, `AttributeName` |

### CST→AST Lowering Coverage

The `lower_file()` function converts CST to AST with the following capabilities:

- **Fully lowered:** Modules, imports, all declaration types, all statement types, all expression types including built-in expressions (`mux`, `concat`, `fan_out`, `static`, `bitsizeof`, `bytesizeof`, `clog2`)
- **Partially lowered:** `bitoffsetof`/`byteoffsetof` (require Type and field name, not expressions)

## 9) Test Summary

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `kanagawa_syntax/tests/doc_attach.rs` | 3 | Doc comment attachment |
| `kanagawa_syntax/tests/lexer_repo.rs` | 4 | Lexer correctness |
| `kanagawa_syntax/tests/parse_*.rs` | 31 | CST parsing |
| `kanagawa_syntax/tests/parse_syntax_harness.rs` | 2 | Syntax harness blocks |
| `kanagawa_ast/tests/lower_basic.rs` | 21 | CST→AST lowering (basic constructs + built-ins) |
| `kanagawa_ast/tests/lower_more.rs` | 14 | CST→AST lowering (advanced) |
| `kanagawa_hir/src/*.rs` (unit tests) | 25 | HIR types, symbols, namespace |
| `kanagawa_hir/src/*.rs` (doc tests) | 3 | Namespace encoding |
| `kanagawa_hir/tests/lower_test.rs` | 39 | AST→HIR full pipeline |
| **Total** | **143** | (1 harness test ignored) |

## 10) HIR (High-level Intermediate Representation)

The `kanagawa_hir` crate provides semantic representation with resolved names and types, following the Haskell frontend's architecture.

### HIR Components

| Component | Description | Status |
|-----------|-------------|--------|
| `Ty` (semantic types) | Resolved type information with widths, fields | Working |
| `DefId` | Unique identifiers for all named definitions | Working |
| `SymbolTable` | Name→DefId mapping with lexical scopes | Working |
| `HirFile` | Top-level HIR representation | Working |
| `HirItem` | Declaration items (functions, types, etc.) | Working |
| `HirStmt` | Statement representation | Working |
| `HirExpr` | Expression representation with types | Working |

### HIR Test Coverage

| Test Category | Tests | Status |
|---------------|-------|--------|
| Unit tests (ty, def, symbol, namespace) | 25 | Passing |
| Integration tests (full pipeline) | 39 | Passing |
| Doc tests | 3 | Passing |
| **Total** | **67** | All passing |

## 11) AST → HIR Lowering Status

The `lower_file()` function converts AST to HIR while building the symbol table and performing initial type inference.

### Declarations

| Construct | Lowering Status | Notes |
|-----------|-----------------|-------|
| Functions | **Working** | Full signature, params, body; DefId assigned |
| Variables | **Working** | Type, init, flags (const/static) |
| Structs | **Working** | Members with types and initializers |
| Enums | **Working** | Variants and base type fully parsed |
| Classes | **Working** | Members and methods fully supported |
| Unions | **Working** | Members with types |
| Using (type alias) | **Working** | Alias name and target type |
| Templates | **Working** | Item and template params lowered |
| Static if (decl) | **Working** | Condition and branches |
| Static assert | **Working** | Condition |
| Extern/Export | **Working** | Attributes and wrapped item |

### Statements

| Construct | Lowering Status | Notes |
|-----------|-----------------|-------|
| Block | **Working** | Nested scopes created |
| Return | **Working** | Optional value |
| If/else | **Working** | Condition and branches |
| Switch | **Working** | Expression and cases fully lowered |
| Do-while | **Working** | Condition, body, attributes |
| Range-for | **Working** | Loop variable gets DefId |
| Static for | **Working** | Loop variable gets DefId |
| Unrolled for | **Working** | Loop variable gets DefId |
| Static if (stmt) | **Working** | Condition and branches |
| Barrier | **Working** | Span only |
| Reorder/Atomic | **Working** | Body statement |
| Break | **Working** | Span only |
| Expr stmt | **Working** | Expression |
| Assignment | **Working** | LHS and RHS fully extracted |
| Var decl (local) | **Working** | Type, init, DefId |
| Annotated | **Working** | Attributes and wrapped statement |

### Expressions

| Construct | Lowering Status | Notes |
|-----------|-----------------|-------|
| Int literal | **Working** | Type inferred from value/suffix |
| Float literal | **Working** | Type: Float |
| Bool literal | **Working** | Type: Bool |
| String literal | **Working** | Type: String |
| Interpolated string | **Working** | Parts with format specs |
| Identifier | **Working** | Resolved to DefId via symbol table |
| Qualified identifier | **Working** | Path resolution |
| Binary operators | **Working** | Type inference for result |
| Unary operators | **Working** | Type inference for result |
| Ternary conditional | **Working** | Common supertype of branches |
| Function call | **Working** | Return type from callee |
| Member access | **Working** | Type resolved from struct/class fields |
| Subscript | **Working** | Element type from array |
| Cast | **Working** | Target type |
| Mux | **Working** | Common supertype of args |
| Concat | **Working** | Sum of widths |
| Fan-out | **Working** | Unresolved (needs template) |
| Static | **Working** | Inner expression type |
| Initializer list | **Working** | Initializer type |
| Designated init | **Working** | Fields collected |
| Paren | **Working** | Inner type |
| Type expr | **Working** | Type(inner) |
| Lambda | **Working** | Captures, params, body |
| Sizeof/Offsetof | **Working** | Operand lowered |

### Types

| Type Form | Lowering Status | Notes |
|-----------|-----------------|-------|
| Primitives (void, bool, string, float, auto) | **Working** | Direct mapping to Ty variants |
| Fixed-width integers (int32, uint8) | **Working** | Ty::Signed/Unsigned |
| Parameterized integers (int<N>) | **Partial** | Returns Ty::Unresolved |
| Const types | **Working** | Ty::Const wrapper |
| Named types | **Working** | Resolved via symbol table |
| Array types | **Working** | Element type and dimensions fully parsed |
| Function types | **Working** | Params, return type, attrs |
| Typename (dependent) | **Partial** | Returns Ty::Unresolved |
| Decltype | **Partial** | Returns Ty::Unresolved |

### Symbol Table Features

| Feature | Status | Notes |
|---------|--------|-------|
| Define names in scope | **Working** | Returns DefId |
| Lookup by simple name | **Working** | Searches current + parent scopes |
| Lookup by qualified name | **Working** | Path-based resolution |
| Scope push/pop | **Working** | Function, Block, Struct, Class, Enum, Template, Union |
| Module namespace prefix | **Working** | @-encoded module path |
| Definition metadata | **Working** | Kind, visibility, type, span |

## 12) Previously Known Parser Limitations (Now Fixed)

The following limitations were previously blocking HIR tests but have now been resolved:

| Issue | Fix Applied |
|-------|-------------|
| Array dimensions not wrapped in TypeArray node | Parser now creates checkpoints before base type and wraps dimensions correctly |
| Enum base type not parsed as Type node | Parser now calls `parse_type_or_fallback()` for base types |
| AssignExpr not created inside AssignStmt | AST lowering now uses `descendants()` to find AssignExpr inside Expr wrapper |
| Assignment in class methods fails AST lowering | Fixed along with assignment extraction |
| Default parameter values not captured | Parser now calls `parse_expr_node()` and AST lowerer extracts defaults |
| Template parameters not populated | Added `TemplateParams`/`TemplateParam` SyntaxKinds and full parsing/lowering |
| Switch cases not lowered | AST lowering now iterates direct children instead of looking for Block |
| Top-level static not fully supported | Parser now calls `parse_static_var_decl()` and AST lowering handles `StaticVarDecl` |
| Keywords used as identifiers in expression position | AST lowering now accepts keyword tokens as identifiers (e.g., `mux`, `concat`, `static`) |

## 13) Language Feature Coverage Summary

Cross-referencing with language requirements from grammar.md:

### Fully Supported (CST → AST → HIR)

- Module declarations and imports
- Function declarations with params, default values, and bodies
- Variable declarations with initializers (including static variables)
- Struct, union, class definitions with members and methods
- Enum definitions with base types and variants
- Type aliases (using)
- Template declarations with params
- All statement types (if, switch with cases, loops, return, etc.)
- All expression types (binary, unary, ternary, calls, assignments, etc.)
- Built-in expressions (mux, concat, fan_out, cast, sizeof, clog2)
- Lambda expressions with captures
- Attributes on declarations, statements, expressions
- Initializer lists and designated initializers
- Interpolated strings
- Array types with dimensions
- Static if/for at all levels

### Partially Supported

- Parameterized integer widths (returns Ty::Unresolved, needs template instantiation)
- Dependent types (typename, decltype) - returns Ty::Unresolved
- `bitoffsetof`/`byteoffsetof` - require Type+field name extraction

### Not Yet Implemented

- Full type inference/checking
- Cross-module name resolution
- Template instantiation
- Constant expression evaluation (beyond int literals)
- AST→ParseTree emission for C++ backend

## 14) What's Next

Recommended next steps for the Rust frontend:

1. **Implement full type checking**: Build on HIR infrastructure for semantic validation
2. **Complete `bitoffsetof`/`byteoffsetof` lowering**: Extract Type and field name arguments properly
3. **Implement AST→ParseTree emission**: Use the existing C ABI seam (`compiler/cpp/parse_tree.h`) to emit ParseTree for the C++ backend
4. **Integration testing**: End-to-end tests compiling real `.k` files through the Rust frontend
5. **Cross-module name resolution**: Implement module loading and cross-file symbol resolution

## 15) Tree-sitter Mismatches

The VS Code tree-sitter grammar is approximate and may accept constructs not in the canonical compiler:

- `continue` and `protected` appear in tree-sitter keyword lists but are not in the Haskell reserved list
- `inspectable(...)` is modeled as a declaration in tree-sitter but not in the Haskell parser
