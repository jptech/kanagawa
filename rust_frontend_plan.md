# Rust Frontend Replacement Plan & Specification (Kanagawa)

**Goal:** Replace the existing Haskell frontend with a Rust implementation while keeping the **C++ backend completely unchanged** by continuing to emit the **existing ParseTree ABI** defined in `compiler/cpp/parse_tree.h`.

This document is intentionally detailed and prescriptive: it is meant to be sufficient for a human or automated agent to implement the Rust frontend correctly, with high confidence of behavioral parity.

---

## 0) Constraints, scope, and success criteria

### 0.1 Hard constraints (non-negotiable)

- **Backend remains as-is.** No changes to `compiler/cpp/*` behavior are required for the initial migration.
- **ParseTree ABI is the boundary.** The Rust frontend must build ParseTree nodes by calling the existing C API in `compiler/cpp/parse_tree.h`.
- **CLI compatibility.** The Rust driver must accept the same compile-mode options and pass an `Options` struct to `InitCompiler` as the Haskell frontend does today.
- **Behavioral parity over refactors.** Prefer reproducing current semantics (even if odd) over “fixing” behavior.

### 0.2 Explicit in-scope deliverables

- A new Rust binary (recommended name: `kanagawa-rs`, later optionally renamed to `kanagawa`).
- A Rust frontend pipeline that:
  1. loads source files, resolves imports, and constructs a whole program representation
  2. parses source with accurate spans and robust error recovery
  3. performs the necessary frontend validations/desugar/template work/type inference
  4. emits a ParseTree (via ABI calls) consistent with what the backend expects
  5. invokes `InitCompiler` + `Codegen` from the backend
- A testing harness that runs both frontends (Haskell and Rust) on the same corpus and compares outputs.

### 0.3 Explicit out-of-scope (for the initial replacement)

- Changing the ParseTree ABI.
- Replacing the backend IR, scheduler, placer, or Verilog emission.
- A full LSP implementation.

(However, **tooling-ready architecture** is in-scope: the Rust frontend should be designed so that formatter/docgen/LSP can be built on top of it later without re-architecting.)

### 0.4 Acceptance criteria

A Rust frontend is “replacement-grade” when:

- **Compilation parity:** For a defined corpus (at minimum `library/**/*.k` and the existing `test/**/*.k` suites that compile), the Rust frontend produces:
  - the same exit status and error/warning counts (modulo formatting),
  - generated SystemVerilog that is identical or acceptably equivalent (see §15.3),
  - backend reports (resource usage, debug symbols, etc.) that match within specified tolerances.
- **Span quality:** Diagnostics point at the correct source ranges (begin/end) for primary errors.
- **Performance:** No major regressions vs the Haskell frontend on the same corpus; target a measurable improvement once parity is achieved.

---

## 1) Why Text → CST → AST/HIR is the right architecture here

Kanagawa needs a frontend that supports three overlapping workloads:

1. **Batch compilation** (fast, deterministic, correct)
2. **Developer tooling** (formatter, doc generator, LSP)
3. **High-quality diagnostics** (precise spans, recovery, suggestions)

A **lossless CST** (Concrete Syntax Tree) is the only structure that naturally supports all three without duplicating parsing logic.

### 1.1 Architectural decision: use a lossless green tree (`rowan`)

- **Decision:** Build a lossless CST using `rowan` (immutable “green tree”) with typed wrappers.
- **Why:**
  - preserves trivia (comments/whitespace/doc comments) needed for formatter and docgen
  - enables error nodes and recovery, crucial for tooling and better diagnostics
  - aligns with rust-analyzer style architecture (battle-tested)
- **Alternative rejected:** AST-only parsing.
  - simpler for a batch compiler, but makes formatting/docgen/LSP significantly harder and forces re-parsing/re-tokenizing for many operations.

### 1.2 Architectural decision: hand-written recursive descent + Pratt expressions

- **Decision:** Implement parsing as hand-written recursive descent over a token stream, with a Pratt parser for expressions.
- **Why:**
  - fine-grained control over recovery points and span attribution
  - predictable performance
  - easier to implement Kanagawa-specific “restricted parsing modes” (e.g. template argument expression restrictions)

### 1.3 Lexer decision: `logos`

- **Decision:** Use `logos` for lexing, producing tokens including trivia.
- **Why:**
  - fast
  - simple token definitions
  - easy to preserve trivia for CST

---

## 2) Repo integration strategy (keep backend unchanged)

### 2.1 Keep ParseTree ABI exactly

The Rust frontend must call the exact exported functions in `compiler/cpp/parse_tree.h`, including:

- `InitCompiler(const Options*)`
- `Codegen(..., ParseTreeNodePtr root)`
- constructors such as `ParseFunction`, `ParseDeclare`, `ParseBinaryOp`, etc.
- location APIs: `SetLocation2`, `UnknownLocation`
- type API: `SetNodeType` for typed integer and enum leaf nodes

This matches the current Haskell bridge in `compiler/hs/app/ParseTree.hs`.

### 2.2 ABI bindings decision: `bindgen` + thin safe wrappers

- **Decision:** Use `bindgen` to generate Rust FFI bindings for `parse_tree.h` and `options.h`.
- **Why:**
  - avoids manual drift as the backend evolves
  - ensures struct layout matches backend (`Options`, nested options)
- **Implementation detail:**
  - generate to `compiler/rs/crates/kanagawa_parsetree_sys/src/bindings.rs`
  - wrap raw FFI in a safe-ish API (`kanagawa_parsetree`) that enforces ordering invariants (location before node creation, list building patterns, string lifetime rules).

### 2.3 Link strategy

- The Rust binary links against the already-built backend shared library.
- The build system continues to be CMake-driven at repo root.

Two supported build shapes:

1. **CMake drives Cargo** (recommended):

- add a CMake target that runs `cargo build` for the Rust crates
- ensure include paths and link flags match the backend build

2. **Cargo builds backend via `cmake` crate** (not recommended initially):

- would duplicate build orchestration already working in the repo

### 2.4 Options ABI: how the Rust driver must call `InitCompiler`

The backend expects an `Options` struct (declared in `compiler/cpp/options.h`) populated exactly as the Haskell frontend does via `compiler/hs/app/Options/FFI.hsc`.

**Decision:** The Rust driver owns constructing and populating an `Options` value and calling:

- `InitCompiler(&options)`

**Critical fields that must be populated (parity requirements):**

- `Options::_cmdArgs` must point to a C string containing the original command-line string (used for debug/reporting).
- `Options::_deviceName` must point to the target device name.
- `Options::_fileNames` must point to a **null-terminated** `char*[]` array containing the complete `all_files` list in the exact same order used for `_fileIndex` in `Location`.
- `CodeGenOptions::_verbosity` must be set based on CLI verbosity (quiet/normal/verbose).

**Implementation requirements:**

- Do not attempt to “partially fill” `Options`. Populate all fields that are user-visible via CLI flags.
- Use `bindgen` to ensure struct layout and nested struct offsets match.
- The `char*[]` array and each `CString` must remain valid until `InitCompiler` returns (and conservatively, until `Codegen` returns, unless confirmed otherwise).

**Suggested implementation pattern:**

- Create a `BackendOptionsArena` that stores:
  - `CString` for `_cmdArgs`, `_deviceName`, output paths, etc.
  - `Vec<CString>` for all file names
  - `Vec<*const c_char>` with a final null pointer (the `char*[]`)
- Expose `fn as_ffi(&self) -> *const sys::Options`.

**Why this is necessary:**

- The backend uses `_fileNames` when generating debug symbols and diagnostics. If ordering or values drift, locations and debug output become confusing and differential testing becomes unreliable.

---

## 3) Crate layout and responsibilities

Proposed Cargo workspace at `compiler/rs/`:

- `compiler/rs/Cargo.toml` (workspace)
- `compiler/rs/crates/kanagawa_source`
- `compiler/rs/crates/kanagawa_lex`
- `compiler/rs/crates/kanagawa_syntax`
- `compiler/rs/crates/kanagawa_ast`
- `compiler/rs/crates/kanagawa_hir`
- `compiler/rs/crates/kanagawa_ty`
- `compiler/rs/crates/kanagawa_diag`
- `compiler/rs/crates/kanagawa_frontend`
- `compiler/rs/crates/kanagawa_parsetree_sys` (bindgen output)
- `compiler/rs/crates/kanagawa_parsetree` (safe wrapper)
- `compiler/rs/crates/kanagawa_driver` (CLI binary)

### 3.1 Guiding rules

- `*_syntax` owns CST and parsing.
- `*_ast` are zero-copy typed views over CST.
- `*_hir` is the semantic representation used for type inference and lowering.
- `*_parsetree` owns the ABI calls and converts HIR → ParseTree nodes.
- `*_driver` owns CLI and file loading.

This separation ensures tooling can reuse `syntax/ast/hir` without depending on backend emission.

---

## 4) Source model, file identity, and spans

### 4.1 File identity must match backend expectations

The backend `Location` includes `_fileIndex`. The Haskell frontend assigns file indices based on `allFiles` ordering:

- It uses `elemIndex (sourceName begin) allFiles`.

**Decision:** The Rust frontend must:

- compute an `all_files: Vec<PathBuf>` in a deterministic order,
- use that ordering to assign each loaded file a `FileId` and backend file index,
- ensure spans in diagnostics use this mapping.

### 4.2 Span model

Define:

- `TextOffset` = byte offset in UTF-8
- `TextRange { start: TextOffset, end: TextOffset }`

Maintain a `LineIndex` per file for (line, col) mapping.

**Backend `Location` conversion** requires:

- 1-based line and column indices (match `SourcePos` behavior)
- begin/end positions

### 4.3 Location API usage invariant

The ParseTree interface uses a global “current location” (set by `SetLocation2` / `UnknownLocation`) used by subsequently constructed nodes.

**Invariant:** Every time the Rust frontend emits a ParseTree node corresponding to source text:

- call `SetLocation2(&Location)` immediately before calling the `Parse*` constructor.

For compiler-generated nodes without a clear origin:

- call `UnknownLocation()`.

This must match Haskell’s `parseWithLoc` behavior.

### 4.4 Module namespace encoding (must match current Haskell behavior)

Kanagawa internally represents module namespaces using a mangled name form built from `@` prefixes (see `moduleNamespace` / `unmangleModuleNamespace` in `compiler/hs/lib/Language/Kanagawa/Parser/Syntax.hs`).

**Decision:** The Rust frontend must adopt the same internal module-namespace encoding for any symbol names that participate in:

- import/export resolution
- template mangling/unmangling
- qualified-name emission into ParseTree (`ParseQualifiedName`, `ParseNamespaceScopePtr`)

**Canonical encoding:**

- A module path consisting of segments `[s0, s1, ...]` is encoded into a single “module namespace name” string by concatenating each segment prefixed with `@`:

  - `moduleNamespace(["data", "optional"])` → `"@data@optional"`
  - `moduleNamespace(["xilinx", "ultrascale", "bram"])` → `"@xilinx@ultrascale@bram"`

- The human-readable inverse mapping replaces `@`-separated segments with dot-separated segments for display.

**Implications:**

- A fully-qualified symbol name in many frontend structures is a vector of segments where the first segment may be this encoded module namespace (e.g. `["@data@optional", "optional"]`).
- When passing qualified names to the backend, preserve this representation exactly. Do not “prettify” module scopes to dot syntax.

**Why:**

- The existing frontend uses this encoding to avoid collisions and to track scope/module origin. Replacing it risks changing symbol identity and template instance names.

---

## 5) Lexing (kanagawa_lex)

### 5.1 Token categories

Tokens must support:

- keywords (as in `grammar.md`)
- identifiers
- module-name segments (including `-`)
- punctuation/operators
- numeric literals (with optional `iN`/`uN` suffix, no underscore before suffix)
- strings and interpolated-string structure
- comments:
  - `//` line
  - nested `/* */`
  - doc comments `//|` and `//<`

**Decision:** include trivia tokens in the token stream:

- `Whitespace`
- `LineComment`
- `BlockComment`
- `DocCommentPre` (`//|`)
- `DocCommentPost` (`//<`)

The parser consumes trivia but preserves it into the CST.

### 5.2 String interpolation lexical shape

The Haskell parser treats interpolated strings as a sequence of literal segments with optional `{...}` expressions.

**Decision:** The lexer produces:

- `StringStart`, `StringText`, `StringEnd`
- `InterpStart` for `{` inside string context
- `InterpEnd` for `}`

Alternatively, the lexer can produce a single `StringLiteral` token and delegate segmentation to the parser, but that makes precise spans and recovery harder.

**Recommendation:** implement a dedicated string-mode lexer for interpolation.

---

## 6) CST and parser (kanagawa_syntax)

### 6.1 Syntax tree design (rowan)

Define:

- `SyntaxKind` enum covering:
  - token kinds (ident, keywords, literals, operators)
  - node kinds (ModuleDecl, Import, Function, Struct, ExprBinary, etc.)
  - error nodes (`Error`) and placeholders (`Missing`)

Use:

- `type SyntaxNode = rowan::SyntaxNode<KanagawaLanguage>`

### 6.2 Parsing strategy

Top-down parsing with explicit recovery:

- At each grammar boundary (item list, parameter list, statement list, expression), implement recovery sets (expected delimiters like `;`, `}`, `)`, `]`, `,`).

### 6.3 Expression parsing (Pratt)

Must support operators documented in `grammar.md`:

- arithmetic: `+ - * / %`
- shifts: `<< >>`
- bitwise: `& | ^ ~`
- logical: `&& || !` plus `^^`
- comparisons: `== != < <= > >=`
- ternary: `? :`
- assignment and compound assignment
- member access `.`
- qualification `::`

Also parse built-in forms:

- `mux(...)`
- `fan_out<...>(...)`
- `concat(...)`
- `cast<...>(...)`
- `lutmul(...)`
- `bitsizeof(...)`, `bytesizeof(...)`, `bitoffsetof(...)`, `byteoffsetof(...)`, `clog2(...)`

### 6.4 Template argument parsing mode

The Haskell parser uses a restricted template-expression mode to avoid ambiguity with `<`/`>`.

**Decision:** implement two expression entrypoints:

- `parse_expr_normal()`
- `parse_expr_template_arg()`

Rules for template-arg expression mode should be derived from current behavior and validated by differential tests.

Practical rule of thumb:

- avoid treating `<` and `>` as comparison operators inside template args unless parenthesized or otherwise disambiguated.

### 6.5 Attributes parsing

Attributes have the surface form:

- `[[a, b]]` and can be chained: `[[a]][[b]]`

They appear in multiple contexts:

- before function declarations/definitions
- before function types
- before call expressions
- before statements
- before loops
- inside array/type forms (`[[memory, quad_port]] T[N]`)

**Decision:** represent attributes in CST as an `AttrList` node containing one or more `AttrGroup` nodes.

Parsing must not assume a single allowed attribute set; semantic validation happens in later passes.

---

## 7) AST typed views (kanagawa_ast)

### 7.1 Purpose

Provide ergonomic, typed wrappers over CST nodes without copying.

Examples:

- `ast::FunctionDef`
- `ast::StructDef`
- `ast::Expr` enum wrapper (`BinaryExpr`, `CallExpr`, etc.)

### 7.2 AST nodes should preserve raw syntax

Do not “simplify” at AST level (e.g. don’t desugar `++` into `+=` yet). This preserves formatting and enables better diagnostics.

---

## 8) HIR (kanagawa_hir): the semantic core

HIR is the first representation where names resolve to definitions and types can be inferred.

### 8.1 HIR design principles

- HIR should be **stable, explicit, and easy to type-check**.
- HIR should **encode scope** and **qualified names** explicitly.
- HIR should be amenable to future incremental compilation.

### 8.2 Core entities

- `Module` (name, exports, imports, items)
- `Item`:
  - `Function`, `Struct`, `Union`, `Class`, `Enum`, `Alias`, `Extern`, `ExportType`, etc.
- `TypeRef`:
  - primitives (void/bool/string/float32/auto)
  - int/uint (fixed width or width expression)
  - array types with optional memory attrs
  - function types
  - qualified named types, template instances
  - `decltype(expr)`
- `Expr`:
  - literals, identifiers, member access, calls, builtins, ternary, unary/binary ops
- `Stmt`:
  - if, switch, range-for, do-while, static-for, reorder, barrier, atomic blocks, return

### 8.3 Name resolution model

Kanagawa has:

- module namespace mangling using `@` prefixes internally (see `moduleNamespace` in `compiler/hs/lib/Language/Kanagawa/Parser/Syntax.hs`)
- qualified names using `::`
- import aliases

**Decision:** Represent a resolved name as:

- `ResolvedName { scope: Vec<NameSegment>, ident: NameSegment, def_id: DefId }`

Where `scope` includes module-namespace segments.

Resolution must mirror Haskell’s `resolveNames`/`undefinedSymbols` behavior in spirit:

- provide “not in scope” diagnostics
- include suggestions (edit distance) when possible

---

## 9) Frontend semantic passes: required parity with current Haskell pipeline

The current frontend pipeline is defined in `compiler/hs/lib/Language/Kanagawa/Frontend.hs` and includes (order matters):

1. `validateProgram` (structure validation)
2. `interpolatedStringPost` (format/alignment/precision validation)
3. `deduceAuto`
4. `postDesugar` (resolve names, static asserts, unresolved, return-void, this reference)
5. `removeTemplate`
6. `validateExtern`
7. `validateExportableClasses`
8. `unresolvedTemplates`
9. `unresolvedFunctionTemplateArgs`
10. `typeErrors`
11. `undefinedSymbols`
12. `instantiateTemplates` (multi-iteration)
13. `trimExternClasses`
14. `inferType`
15. `intrinsics`
16. `deduceTemplateArgs`
17. `captureThis . reifyEnums`
18. `higherOrderFunctions`
19. final combined pass:
    - `validateTypedLiterals`
    - `interpolatedStringPre`
    - `freeNonInlineFunctions`
    - `localMemberFunctions`
    - `redundantNameScope`

### 9.1 Pass parity policy

- The Rust frontend should implement the same _logical effects_ even if the internal data structures differ.
- Some checks may be redundant with backend checks; still implement them if they are currently user-visible.

### 9.2 Rust pass pipeline structure

Implement passes as:

- `fn run_pass(&mut self, program: &mut HirProgram, diag: &mut Diagnostics)`

and organize into phases:

- Phase A: syntax validation and early desugars
- Phase B: template instantiation (iterative)
- Phase C: type inference/checking
- Phase D: late desugars and final validations

### 9.3 Critical behavior details to match

#### Interpolated string pre/post

Haskell behaviors:

- `interpolatedStringPre` expands `{x=}` into a prefix like `"x = "` (exact formatting matters in emitted string segments).
- `interpolatedStringPost` validates format specifiers and may infer default precision based on expression bit width.

**Rust requirement:**

- Preserve this transformation and validation exactly as observed by tests.

#### Enum constant auto-values (`reifyEnums`)

Haskell auto-assigns missing enum values by incrementing the previous value.

**Rust requirement:**

- Implement identical defaulting behavior.

#### Free functions must be `inline`

Haskell enforces: “Free functions must be declared `inline`”.

**Rust requirement:**

- Enforce this rule with the same diagnostic severity.

#### Typed integer literals validation

Haskell validates `0xffu16` ranges and literal widths.

**Rust requirement:**

- Validate numeric ranges for typed literals in the same way and report consistent errors.

---

## 10) Templates: instantiation, mangling, and instance naming

Template behavior is a high-risk parity area.

### 10.1 Template parameter kinds

Support:

- type params: `typename T` (optional default type)
- non-type params: `<type> N` (optional default expression)
- template-template params: `template <...> typename TT`

### 10.2 Instance identity and deduplication

Haskell’s template engine deduplicates instances for certain declaration kinds (class/struct/union/alias/template/function) using qualified name equality.

**Rust requirement:**

- Maintain an instance cache keyed by:
  - template qualified name
  - normalized template arguments (after inference/deduction)
- Ensure deduplication produces a stable ordering.

### 10.3 Mangling algorithm must match

Haskell template name mangling (see `compiler/hs/lib/Language/Kanagawa/Mangle.hs`) uses:

- `"<|" ... "|>"` wrappers
- `$` prefix for compiler-internal strings
- `@` prefix for user identifiers and scalar literals

**Rust requirement:**

- Re-implement `mangleTemplateScopedName` and `mangleTemplateIdentifier` exactly.

This is necessary to preserve:

- symbol identity
- backend naming stability
- diagnostics and debug symbol stability

### 10.4 Unmangled instance names passed to backend

When emitting ParseTree nodes for template instances, the Haskell frontend sometimes passes an explicit `unmangledName` string (see `ParseTree.hs` `withUnmangledName`).

Backend behavior (in `compiler/cpp/parse_tree.cpp`) uses `GetOptionalUnmangledName(unmangledName, defaultNameNode)`.

**Rust requirement:**

- Pass `nullptr` when not a template instance.
- Pass the correct unmangled name string for instances.

Implement `unmangleInstanceName` equivalent to `compiler/hs/lib/Language/Kanagawa/Type.hs`:

- `TInstance template qualified_name args` renders as `Name<arg1, arg2, ...>`
- if nested, prefix outer qualifier with `::`.

---

## 11) Type system and inference

### 11.1 Type forms to support

From current syntax and type model:

- primitives: void, bool, string, float32, auto
- int/uint fixed widths: `int32`, `uint7`
- computed widths: `uint<clog2(N)+1>`
- arrays: `T[N]`, multi-dimensional
- function types: `(T1, T2) -> R` with optional attributes
- named and qualified types, including `Foo::template Bar<T>`
- `const T`
- `decltype(expr)`

### 11.2 Type inference goals

- Achieve parity with Haskell `inferType` and related inference helpers.
- Preserve “unresolved” states during early pipeline phases.

### 11.3 Backend interop requirement: explicit leaf types via `SetNodeType`

Haskell does:

- if `typeOf expr` is integer or enum, it calls `SetNodeType(node, intTypeNode)`.

**Rust requirement:**

- For integer and enum expression nodes that are literals/leafs (and any other nodes where frontend explicitly pins type today), call `SetNodeType` to match backend expectations.

This is important because backend diagnostics and type checking sometimes assume leaf widths are known.

---

## 12) ParseTree emission (kanagawa_parsetree)

### 12.1 Design goal

Provide a _safe-by-construction_ builder API that prevents common ABI misuses.

### 12.2 Core builder API

A suggested API shape:

- `struct ParseTreeBuilder { files: Vec<PathBuf>, ... }`
- `fn with_location(&mut self, span: Span, f: impl FnOnce(&mut Self) -> NodePtr) -> NodePtr`
- `fn unknown_location(&mut self) -> Guard`

Also provide helpers mirroring Haskell patterns:

- `fn list(&mut self, elems: impl IntoIterator<Item = NodePtr>) -> NodePtr` using `ParseBaseList` + `ParseAppendList`
- `fn qualified_name(&mut self, qn: &[String]) -> NodePtr` using `ParseQualifiedName`

### 12.3 String lifetime rules

The C ABI takes `const char*` in many places. The backend typically copies these into `std::string` internally, but **do not assume** this without verifying.

**Safe rule:**

- treat all `const char*` passed to ParseTree constructors as needing to be valid for the duration of the ABI call.
- allocate using `CString` and keep it alive across the call.

A convenient approach:

- store `CString` values in an arena owned by the builder for the compilation duration.

### 12.4 Mapping HIR → ParseTree nodes

The mapping should follow the existing Haskell `ParseTree.hs` case analysis.

Key mappings:

- `Hir::Alias` → `ParseTypedef`
- `Hir::AnnotatedStmt` → `ParseAnnotatedStatement`
- `Hir::ArrayType` → `ParseArrayType`
- `Hir::ArrayAccess` → `ParseAccessArray`
- `Hir::Assign` → `ParseAssign`
- attributes:
  - memory flags → `ParseFlagAttribute`
  - int attrs → `ParseIntAttribute`
  - function modifiers → `ParseFunctionModifier`
- control flow:
  - if → `ParseIf`
  - do-while → `ParseDoWhile`
  - static-for/unrolled-for → `ParseUnrolledFor`
  - range-for → `ParseRangeFor`
  - switch/case/default → `ParseSwitch` / `ParseSwitchBlock`
- functions:
  - params → `ParseFunctionParam`
  - function type params → `ParseFunctionTypeParam`
  - function type → `ParseFunctionType`
  - function def → `ParseFunction`
  - external function decl → `ParseExternalFunction`
- literals:
  - bool → `ParseBoolLiteral`
  - float → `ParseFloatLiteral`
  - int literal → `ParseDecimalLiteral` (string form)
  - string literal → `ParseStringLiteral`
  - interpolated string → `ParseInterpolatedString` + `ParseInterpolatedStringSegment` + `ParseInterpolationExpression`

### 12.5 Required enum/flag mappings (match backend ABI)

This section is intentionally explicit: it prevents “semantic drift” where the Rust frontend emits a different ParseTree encoding than the Haskell frontend.

#### 12.5.1 Variable declaration flags (`ParseDeclare`)

`ParseDeclare(..., flags, scope)` takes a bitmask using the `DECLARE_FLAG_*` constants in `compiler/cpp/parse_tree.h`.

**Decision:** The Rust frontend must map declaration kinds to flags consistent with existing behavior.

Minimum mapping requirements:

- `const` variable declarations must include `DECLARE_FLAG_CONST`.
- global declarations must include `DECLARE_FLAG_GLOBAL`.
- `static` locals must include `DECLARE_FLAG_STATIC`.
- class/member declarations must include `DECLARE_FLAG_CLASS` when representing members.
- uninitialized `const` forms (if used) must include `DECLARE_FLAG_UNINIT_CONST`.

**Parity note:** the Haskell frontend’s internal flags are mapped in `compiler/hs/app/ParseTree.hs` (`declareFlag = \case ...`). During implementation, use differential tests to validate that for each declaration form in the corpus, the emitted `flags` bitmask matches.

#### 12.5.2 Attribute mapping

The ParseTree ABI distinguishes:

- **flag attributes**: `ParseFlagAttribute(unsigned int attr)`
- **int attributes**: `ParseIntAttribute(unsigned int attr, node)`
- **named/typed attributes**: `ParseAttribute(unsigned int attr, node)`

Backend attribute enum is `ParseTreeAttribute` in `compiler/cpp/parse_tree.h`:

- `ParseTreeCallRateAttr`
- `ParseTreeFifoDepthAttr`
- `ParseTreeLatencyAttr`
- `ParseTreeMaxThreadsAttr`
- `ParseTreeScheduleAttr`
- `ParseTreeThreadRateAttr`
- `ParseTreeTransactionSizeAttr`
- `ParseTreeNameAttr`
- `ParseTreeMarshalAttr`

**Decision:** Encode surface attributes as follows:

- `[[call_rate(N)]]` → `ParseIntAttribute(ParseTreeCallRateAttr, <N expr node>)`
- `[[fifo_depth(N)]]` → `ParseIntAttribute(ParseTreeFifoDepthAttr, <N expr node>)`
- `[[latency(N)]]` → `ParseIntAttribute(ParseTreeLatencyAttr, <N expr node>)`
- `[[max_threads(N)]]` → `ParseIntAttribute(ParseTreeMaxThreadsAttr, <N expr node>)`
- `[[schedule(expr)]]` (statement annotation) → `ParseIntAttribute(ParseTreeScheduleAttr, <expr node>)`
- `[[thread_rate(N)]]` → `ParseIntAttribute(ParseTreeThreadRateAttr, <N expr node>)`
- `[[transaction_size(N)]]` → `ParseIntAttribute(ParseTreeTransactionSizeAttr, <N expr node>)`

Name-like attributes:

- `[[rename("...")]]` (or whatever surface form is supported) must map to `ParseAttribute(ParseTreeNameAttr, <string node>)`.

Memory-related attributes and flags:

- Memory placement flags that affect array/memory types should use `ParseFlagAttribute` and `ParseTreeMemoryType`-related encodings as required by the backend.

**Parity note:** The Haskell bridge currently maps only a subset directly (see `attr` and `intAttr` in `compiler/hs/app/ParseTree.hs`). The Rust frontend should support at least that same subset and add others only when confirmed by backend expectations.

#### 12.5.3 Function modifier mapping

Use `ParseFunctionModifier(ParseTreeFunctionModifier)` to encode function modifiers and some function-level flags.

Minimum required modifiers (per `ParseTreeFunctionModifier` enum in `compiler/cpp/parse_tree.h`):

- `inline` → `ParseTreeFunctionModifierInline`
- `noinline` → `ParseTreeFunctionModifierNoInline`
- `[[async]]` → `ParseTreeFunctionModifierAsync`
- `[[pipelined]]` → `ParseTreeFunctionModifierPipelined`
- `[[unordered]]` → `ParseTreeFunctionModifierUnordered`
- `[[no_backpressure]]` → `ParseTreeFunctionModifierNoBackPressure`
- `[[reorder_by_looping]]` → `ParseTreeFunctionModifierReorderByLooping`
- `[[reset]]` → `ParseTreeFunctionModifierReset`
- `[[pure]]` → `ParseTreeFunctionModifierPure`

**Important:** the backend has an `Export` modifier bit with a comment indicating it should eventually go away. The Rust frontend should preserve whatever current user-visible semantics exist, but should avoid introducing new dependence on deprecated bits.

### 12.6 Dealing with currently-unimplemented Haskell cases

In `ParseTree.hs`, some AST forms are `undefined` (e.g. `StaticIf`, `Template`, certain offsets, etc.).

**Rust policy:**

- Implement based on actual grammar and backend expectations (preferred), OR
- If the backend does not support it, surface a frontend diagnostic "feature not supported".

Do not silently drop nodes.

---

## 13) Driver, module loading, and import resolution

### 13.1 Module system requirements

From `grammar.md`:

- module declaration with explicit export list
- imports with optional `as` alias
- special modules: `.cmdargs`, `.options`

Also from CLI options:

- `--import-dir` search paths
- implicit base import unless `--no-implicit-base`
- `--define` and `--using` inject global definitions

### 13.2 Source loading algorithm

1. Start from CLI `files`.
2. Resolve each file path to an absolute canonical path.
3. Load file text.
4. Parse module header (module decl + imports) early.
5. Build an import graph.
6. Resolve imports using:
   - relative to importing file
   - then `--import-dir` paths
   - then library directories as configured
7. Produce `all_files` ordering deterministically (e.g. topo order + stable tie-breaker by path).

**Why:** backend `Location._fileIndex` must be stable and deterministic.

### 13.3 `.cmdargs` / `.options` integration

These are special modules used to inject command-line configuration.

Rust driver must:

- synthesize module content or symbol definitions equivalent to the Haskell behavior
- ensure they appear in the module graph so references resolve

Implementation approach:

- Create virtual files with `FileId` that map to a synthetic path like `<cmdargs>`.
- Ensure the backend sees correct `Location` for these (likely `UnknownLocation`), unless existing behavior assigns file indices.

**Parity note:** confirm current behavior by observing Haskell compilation diagnostics and file list outputs.

### 13.4 `--file-list` output behavior (parity requirement)

The existing Haskell driver updates the file named by `--file-list` whenever the set/order of compiled files (including imported files) changes.

Observed behavior (see `updateFileList` usage in `compiler/hs/app/Main.hs`):

- After compilation, if `file_list` is non-empty and `fileNames` is non-empty:
  - compute `parsedFiles = sort fileNames`, then filter out entries whose first character is `'.'`
  - read the existing file contents (if any) and split by lines
  - if the old lines differ from `parsedFiles`, write `unlines parsedFiles`

**Decision:** The Rust driver must implement the same behavior to avoid breaking editor/tooling workflows that rely on this file.

---

## 14) Diagnostics model (kanagawa_diag)

### 14.1 Data model

Define:

- `Diagnostic { severity, code, message, primary_span, labels: Vec<Label>, notes: Vec<String> }`
- `Label { span, message }`

### 14.2 Error recovery principle

- Parsing should attempt to produce a CST even with errors.
- Lowering to HIR should operate in a "best effort" mode, producing placeholder nodes and emitting diagnostics.

### 14.3 Suggestions

Reproduce Haskell’s undefined-symbol suggestions:

- edit distance on symbol names
- scope-aware suggestions

This is a strong user experience differentiator.

---

## 15) Testing and validation strategy

### 15.1 Differential compilation (primary strategy)

Keep both frontends during migration:

- `kanagawa-hs` (existing)
- `kanagawa-rs` (new)

Run both on the same corpus and compare:

- exit code
- diagnostics categories and counts
- backend artifacts:
  - `.sv` output (exact compare where feasible)
  - `.json` serialized IR outputs (`--write-ir-post-opt`, `--write-circt-ir`) if enabled
  - debug symbol outputs

### 15.2 Golden tests

For parser and diagnostics:

- snapshot CST pretty dumps for tricky syntax
- snapshot error messages and spans

### 15.3 SV equivalence policy

Exact SV matches may differ due to nondeterminism or ordering differences.

Define tiers:

- Tier 1: byte-for-byte match (preferred)
- Tier 2: match after normalizing whitespace/comments
- Tier 3: match by running a semantic equivalence check (e.g. existing test harness or Verilator-based tests)

Start with Tier 1 for small units, Tier 2/3 for larger designs.

### 15.4 Fuzzing (optional but high value)

Use `cargo-fuzz` to fuzz the parser and ensure:

- no panics
- stable recovery
- no exponential blowups

---

## 16) Performance considerations (without premature optimization)

Key performance choices:

- avoid per-token heap allocation in lexer
- store CST using `rowan` green nodes
- use arenas (e.g. `bumpalo`) for HIR allocation
- avoid repeated whole-program traversals by caching computed facts (symbols/types) per pass

FFI overhead:

- ParseTree building is inherently per-node.
- Minimize overhead by:
  - using a `CString` arena
  - minimizing conversions and repeated qualified-name arrays

---

## 17) Migration milestones (concrete roadmap)

### Milestone 0: scaffolding and CI wiring

- Create `compiler/rs/` workspace and a trivial `kanagawa-rs` binary that prints version.
- Wire CMake to build it.
- Add a CI job that builds both frontends.

Exit criteria:

- `cmake --build` builds Rust artifacts.

### Milestone 1: parse-only frontend

- Implement file loading, import graph, CST parser.
- Add a `--dump-cst` debug mode.

Exit criteria:

- parses `library/base.k` without crashing
- produces good spans

### Milestone 2: minimal semantic + ParseTree emission for a tiny subset

- Implement HIR for basic declarations + expressions.
- Emit ParseTree for:
  - simple functions
  - variable declarations
  - integer ops
- Invoke backend `Codegen`.

Exit criteria:

- can compile a tiny program end-to-end

### Milestone 3: full declarations and control flow

- structs/unions/classes/enums, switch, loops, attributes.
- implement required validations.

Exit criteria:

- compiles most of `library/`.

### Milestone 4: templates + type inference parity

- implement template instantiation, mangling, deduction.
- implement type inference and late passes.

Exit criteria:

- differential tests pass for corpus

### Milestone 5: replacement mode

- make `kanagawa` default to Rust frontend (optionally keep `--frontend=hs` escape hatch for a while).

---

## 18) Known risk areas and mitigations

- **Templates:** implement mangling and instance identity exactly; add targeted differential tests early.
- **Span correctness:** adopt a single canonical span model and test spans in snapshots.
- **Backend expectations of types:** ensure `SetNodeType` is applied consistently.
- **Import/module subtlety:** validate `.cmdargs`/`.options` behavior and export lists by differential tests.

---

## 19) Implementation checklists

### 19.1 ParseTree builder checklist

- [ ] `SetLocation2` called before every node creation
- [ ] `UnknownLocation` used for synthetic nodes
- [ ] file index mapping is stable
- [ ] qualified names arrays are null-terminated
- [ ] integer literals passed as decimal strings
- [ ] `SetNodeType` applied for int/enum leaves

### 19.2 Frontend parity checklist

- [ ] `interpolatedStringPre` and `interpolatedStringPost`
- [ ] `reifyEnums`
- [ ] `freeNonInlineFunctions`
- [ ] typed literal range checks
- [ ] template mangling parity

---

## 20) References (authoritative in-repo)

- `grammar.md` — repo-derived syntax and C/C++ differences
- `about_repo.md` — architecture overview and pipeline
- `compiler/hs/lib/Language/Kanagawa/Frontend.hs` — current pass ordering
- `compiler/hs/app/ParseTree.hs` — current ParseTree emission mapping
- `compiler/cpp/parse_tree.h` — ABI contract
- `compiler/cpp/options.h` — backend options struct
