# Kanagawa Rust Frontend Audit

**Date:** 2025-12-15
**Scope:** Full comparison of Rust frontend vs Haskell frontend, progress evaluation, architecture planning

---

## Executive Summary

The Rust frontend has made **significant progress** on the core compilation pipeline. Parsing and IR lowering are mature (100% success on 467 real-world files). However, semantic analysis is under-tested, code generation is not implemented, and tooling infrastructure is minimal.

**Overall Progress: ~65% toward feature parity with Haskell frontend**

| Component | Rust Status | Haskell Parity | Notes |
|-----------|-------------|----------------|-------|
| Lexer | Complete | 100% | All tokens, comments, string interpolation |
| Parser | Complete | 95% | Missing some error recovery paths |
| AST | Complete | 90% | Template instantiation incomplete |
| HIR | Partial | 75% | Member DefIds, constexpr TODO |
| Type System | Partial | 70% | Core rules done, inference partial |
| Module Resolution | Partial | 60% | No tests, export cycles untested |
| Semantic Validation | Partial | 75% | No tests |
| Code Generation | Not Started | 0% | Critical gap |
| Pretty Printer | Not Started | 0% | Tooling gap |
| Language Server | Not Started | 0% | Tooling gap |

---

## Goal Evaluation

### Goal 1: Rewrite in Rust
**Status: On Track (65%)**

The core architecture is sound and idiomatic Rust:
- Clean crate separation with clear responsibilities
- Proper use of `thiserror`, `logos`, `rowan` ecosystem
- Memory-safe FFI layer for backend integration
- No unsafe code outside FFI boundary

**Remaining Work:**
- Complete type checking inference
- Implement code generation (ParseTree emission)
- Add tooling crates (formatter, LSP)

### Goal 2: Improve Runtime Performance
**Status: Partially Addressed**

**Performance-Ready Architecture:**
- `logos` lexer is 10-100x faster than hand-rolled parsers
- `rowan` green tree enables incremental re-parsing
- Separate CST/AST/HIR layers allow lazy evaluation
- No garbage collection overhead (vs Haskell GHC)

**Not Yet Measured:**
- No benchmarks comparing to Haskell frontend
- Parallel compilation not implemented (Haskell has `parallel`/`parallelChunksOf`)
- No incremental compilation support

**Recommendation:** Add benchmarks before claiming performance improvement.

### Goal 3: Solid Foundation for Tooling
**Status: Well-Positioned**

**Strengths:**
- `rowan` CST preserves all tokens (whitespace, comments) - essential for formatter
- Span tracking throughout all IRs - enables precise error locations
- Lossless parsing - round-trip source reconstruction possible
- Symbol table with scope tracking - LSP "go to definition" ready

**Gaps:**
- No formatter implementation
- No LSP infrastructure
- No incremental parsing hooks
- No document synchronization layer

### Goal 4: Excellent Diagnostics
**Status: Infrastructure Good, Polish Needed**

**What's Implemented:**
- Error codes for all phases (S001-S499, T001-T199, R001-R199)
- Span-based error location
- Severity levels (error, warning, info)
- Related locations for "first defined here" style messages
- Note attachments for context

**What's Missing vs Haskell:**
- No symbol suggestion engine (Damerau-Levenshtein distance)
- No error context stacking (call chain tracking)
- No rich formatting (colors, line snippets with carets)
- No "did you mean X?" suggestions
- No error recovery continuation (stops at first major error)

---

## Detailed Discrepancies with Haskell Frontend

### 1. Compilation Pipeline

**Haskell (19 passes):**
```
validateProgram → interpolatedStringPost → deduceAuto → postDesugar
→ removeTemplate → validateExtern → validateExportableClasses
→ unresolvedTemplates → unresolvedFunctionTemplateArgs → typeErrors
→ undefinedSymbols → instantiateTemplates → trimExternClasses
→ inferType → intrinsics → deduceTemplateArgs → captureThis
→ reifyEnums → higherOrderFunctions → final desugaring
```

**Rust (current):**
```
Lex → Parse (CST) → Lower to AST → Lower to HIR → [TypeCheck] → [Resolve] → [Sema]
                                                   (partial)   (untested) (untested)
```

**Missing Passes:**
| Haskell Pass | Rust Status |
|--------------|-------------|
| `deduceAuto` | Not implemented (Auto types stay unresolved) |
| `instantiateTemplates` | Not implemented |
| `inferType` | Partial in kanagawa_typeck |
| `deduceTemplateArgs` | Not implemented |
| `desugarLambdas` | Not implemented |
| `higherOrderFunctions` | Not implemented |
| `constexpr evaluation` | Not implemented (marked TODO) |
| `closureCalls` | Not implemented |
| `captureThis` | Not implemented |
| `reifyEnums` | Not implemented |

### 2. Type System

**Haskell Type Coverage:**
- 30+ type constructors
- Complete type inference with unification
- Template type parameter substitution
- Width arithmetic (`uint<a> + uint<b> → uint<max(a,b)+1>`)
- Closure types with capture tracking
- Dependent types for template parameters

**Rust Type Coverage:**
- Core type constructors: Complete
- Type inference: Partial (missing unification)
- Template substitution: Not implemented
- Width arithmetic: Implemented in rules, not applied
- Closure types: Defined but not tracked
- Dependent types: Not implemented

### 3. Template Instantiation

**Haskell:**
- Recursive template instantiation with iteration limit
- Template argument deduction from call sites
- Abbreviated function template support
- Template-specific type checking pass

**Rust:**
- Template definitions parsed and lowered to HIR
- No instantiation machinery
- No argument deduction
- No specialization support

### 4. Error Handling

**Haskell:**
- `ParseError` with Megaparsec error bundle
- `ExtendedError` for imports and context
- Error context stacking (tracks call chain)
- Symbol suggestions with edit distance
- Continues parsing after errors
- Parallel error collection

**Rust:**
- `Diagnostic` with span and message
- No error context stacking
- No symbol suggestions
- Some error recovery in parser
- Sequential error collection

### 5. Tooling

**Haskell Has:**
- Pretty printer (`--format` mode) with indent/width options
- Language server infrastructure (commented out)
- Dump modes: `--dump-parse`, `--dump-types`, `--dump-program`, `--dump-source`
- 60+ command-line flags for fine control

**Rust Has:**
- `--lex` and `--parse` flags
- `--smoke-codegen` for backend testing
- No formatter
- No dump modes
- Minimal CLI

---

## What's Working Well

### 1. Parsing Infrastructure (Grade: A)
- 100% success rate on 467 real-world files
- Comprehensive token coverage
- String interpolation with nested expression parsing
- Excellent error recovery preserving malformed nodes
- 34 integration tests

### 2. AST/HIR Architecture (Grade: A-)
- Clean separation of CST/AST/HIR
- DefId-based definition tracking
- Scope-aware symbol table
- Type-preserving lowering
- Good test coverage (40+ tests)

### 3. Type System Design (Grade: B+)
- Complete type enumeration
- Width-aware integer semantics
- Attribute system (TyAttr, TyAttrFlag, TyAttrName)
- Function types with attributes
- Rules for operator type checking

### 4. Semantic Validation (Grade: B)
- Duplicate detection comprehensive
- Control flow analysis correct
- Attribute validation thorough
- Memory annotation validation complete
- Good error codes and messages

### 5. Memory Safety (Grade: A)
- No unsafe outside FFI
- CString arena for safe C interop
- Proper lifetime management
- No panics in production paths

---

## What Needs Work

### Critical (Blocks Compilation)

1. **Code Generation (ParseTree Emission)** - Priority: CRITICAL
   - No implementation exists
   - Requires HIR → ParseTree translation
   - Estimated: 2000-3000 lines

2. **Constant Expression Evaluation** - Priority: HIGH
   - All constexpr returns Unresolved
   - Blocks template instantiation
   - Blocks static_if/static_for evaluation
   - Estimated: 500-800 lines

3. **Template Instantiation** - Priority: HIGH
   - No machinery for instantiation
   - Blocks generic code compilation
   - Estimated: 1500-2500 lines

### Important (Quality/Completeness)

4. **Test Coverage for Semantic Passes** - Priority: HIGH
   - kanagawa_resolve: 0 tests (3K lines)
   - kanagawa_sema: 0 tests (3.6K lines)
   - kanagawa_typeck: 1 test only
   - Risk: Silent bugs in untested logic

5. **Type Inference Completion** - Priority: MEDIUM
   - Unification not fully implemented
   - Template argument deduction missing
   - Auto type resolution incomplete

6. **Error Suggestions** - Priority: MEDIUM
   - No "did you mean?" for undefined symbols
   - No typo correction
   - Add Damerau-Levenshtein distance

### Tooling (Future Value)

7. **Pretty Printer** - Priority: MEDIUM
   - Required for formatter goal
   - CST already preserves whitespace
   - Estimated: 1000-1500 lines

8. **Language Server** - Priority: LOW (after core complete)
   - Foundation exists (symbol table, spans)
   - Needs incremental infrastructure
   - Estimated: 3000-5000 lines

9. **Documentation Generator** - Priority: LOW
   - Doc comments parsed
   - Needs extraction and formatting
   - Estimated: 500-1000 lines

---

## Architecture Recommendations

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         kanagawa_driver                              │
│                    (CLI entry point, backend FFI)                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                         kanagawa_sema                                │
│                    (Semantic validation passes)                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                        kanagawa_resolve                              │
│                    (Module resolution, exports)                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                        kanagawa_typeck                               │
│                    (Type checking, inference)                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                         kanagawa_hir                                 │
│                    (High-level IR, definitions)                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                         kanagawa_ast                                 │
│                    (Typed AST, CST lowering)                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                        kanagawa_syntax                               │
│                    (Lexer, parser, CST)                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Proposed Architecture (Complete Ecosystem)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              TOOLING LAYER                                       │
├────────────────┬────────────────┬────────────────┬─────────────────────────────┤
│ kanagawa_fmt   │ kanagawa_lsp   │ kanagawa_doc   │ kanagawa_driver             │
│ (Formatter)    │ (Lang Server)  │ (Doc Gen)      │ (CLI + Backend)             │
└───────┬────────┴───────┬────────┴───────┬────────┴──────────┬──────────────────┘
        │                │                │                   │
        │   ┌────────────▼────────────────▼───────────────────▼──────────────┐
        │   │                    kanagawa_query                               │
        │   │        (Incremental computation, caching, change tracking)      │
        │   └────────────────────────────┬───────────────────────────────────┘
        │                                │
┌───────▼────────────────────────────────▼───────────────────────────────────────┐
│                              SEMANTIC LAYER                                     │
├────────────────────────┬───────────────────────┬───────────────────────────────┤
│   kanagawa_typeck      │   kanagawa_resolve    │     kanagawa_sema             │
│   (Type inference)     │   (Name resolution)   │     (Validation)              │
└───────────┬────────────┴───────────┬───────────┴──────────┬────────────────────┘
            │                        │                      │
┌───────────▼────────────────────────▼──────────────────────▼────────────────────┐
│                              kanagawa_hir                                       │
│            (Symbol table, definitions, scopes, semantic types)                  │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────────────┐
│                              kanagawa_ast                                       │
│                    (Typed AST nodes, lowering from CST)                         │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────────────┐
│                             kanagawa_syntax                                     │
│                    (Lexer, parser, lossless CST via rowan)                      │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────────────┐
│                            kanagawa_source                                      │
│            (Source text, line index, change tracking, file IDs)                 │
└────────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │         kanagawa_codegen             │
                    │   (HIR → ParseTree for C++ backend)  │
                    └──────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────────────┐
│                           kanagawa_parsetree                                    │
│                    (Safe Rust wrapper over C FFI)                               │
└────────────────────────────────────────────────────────────────────────────────┘
```

### New Crates to Add

#### 1. `kanagawa_source` (Foundation)
**Purpose:** Unified source text management
```rust
pub struct SourceFile {
    pub id: FileId,
    pub path: PathBuf,
    pub text: String,
    pub line_index: LineIndex,
}

pub struct SourceDatabase {
    files: HashMap<FileId, SourceFile>,
    path_to_id: HashMap<PathBuf, FileId>,
}

impl SourceDatabase {
    pub fn add_file(&mut self, path: PathBuf, text: String) -> FileId;
    pub fn get_text(&self, id: FileId) -> &str;
    pub fn line_col(&self, id: FileId, offset: u32) -> (u32, u32);
    pub fn apply_change(&mut self, id: FileId, change: TextChange);
}
```

**Rationale:** Currently span management is scattered. Centralizing source text enables:
- Consistent line/column computation for errors
- Incremental text updates for LSP
- Memory-efficient text storage (rope data structure if needed)

#### 2. `kanagawa_query` (Incremental Infrastructure)
**Purpose:** Demand-driven, incremental computation (like rust-analyzer's salsa)
```rust
#[salsa::query_group(SyntaxDatabaseStorage)]
pub trait SyntaxDatabase: SourceDatabase {
    fn parse(&self, file: FileId) -> Parse<SourceFile>;
}

#[salsa::query_group(HirDatabaseStorage)]
pub trait HirDatabase: SyntaxDatabase {
    fn lower_file(&self, file: FileId) -> Arc<HirFile>;
    fn symbol_table(&self, file: FileId) -> Arc<SymbolTable>;
}

#[salsa::query_group(TypeDatabaseStorage)]
pub trait TypeDatabase: HirDatabase {
    fn infer_types(&self, file: FileId) -> Arc<TypeInference>;
}
```

**Rationale:** Essential for LSP responsiveness. Re-parsing only changed files, re-type-checking only affected functions.

#### 3. `kanagawa_codegen` (Code Generation)
**Purpose:** HIR → ParseTree translation
```rust
pub struct CodeGen<'db> {
    db: &'db dyn TypeDatabase,
    arena: CStringArena,
    tree: ParseTree,
}

impl<'db> CodeGen<'db> {
    pub fn emit_file(&mut self, file: &HirFile) -> Result<(), CodeGenError>;
    pub fn emit_function(&mut self, func: &HirFunction) -> Result<(), CodeGenError>;
    pub fn emit_expr(&mut self, expr: &HirExpr) -> Result<ExprHandle, CodeGenError>;
    pub fn emit_type(&mut self, ty: &Ty) -> Result<TypeHandle, CodeGenError>;
}
```

**Rationale:** Separation from driver allows testing codegen in isolation.

#### 4. `kanagawa_fmt` (Formatter)
**Purpose:** Source code formatting
```rust
pub struct FormatConfig {
    pub indent_width: u32,
    pub max_line_width: u32,
    pub trailing_commas: TrailingCommas,
    pub brace_style: BraceStyle,
}

pub fn format(source: &str, config: &FormatConfig) -> String;
pub fn format_range(source: &str, range: TextRange, config: &FormatConfig) -> TextEdit;
```

**Rationale:**
- Uses CST (preserves comments/whitespace)
- Independent from compilation (can format invalid code)
- Range formatting for LSP "format selection"

#### 5. `kanagawa_lsp` (Language Server)
**Purpose:** IDE integration via LSP
```rust
pub struct LanguageServer {
    db: Database,
    connection: Connection,
}

impl LanguageServer {
    pub fn run(self) -> Result<(), Error>;

    // Request handlers
    fn handle_completion(&mut self, params: CompletionParams) -> Vec<CompletionItem>;
    fn handle_hover(&mut self, params: HoverParams) -> Option<Hover>;
    fn handle_goto_definition(&mut self, params: GotoDefinitionParams) -> Option<Location>;
    fn handle_references(&mut self, params: ReferenceParams) -> Vec<Location>;
    fn handle_rename(&mut self, params: RenameParams) -> Option<WorkspaceEdit>;
    fn handle_diagnostics(&mut self, uri: Url) -> Vec<Diagnostic>;
}
```

**Rationale:** Modern IDE experience is expected. Foundation (symbol table, spans) already exists.

#### 6. `kanagawa_doc` (Documentation Generator)
**Purpose:** Generate documentation from source
```rust
pub struct DocConfig {
    pub output_dir: PathBuf,
    pub format: DocFormat, // Html, Markdown
    pub include_private: bool,
}

pub fn generate_docs(files: &[HirFile], config: &DocConfig) -> Result<(), DocError>;
```

**Rationale:** Doc comments are already parsed. Low effort for high value.

---

### Recommended Implementation Order

#### Phase 1: Core Completion (Enables Compilation)
1. **Constant Expression Evaluation** (1 week)
   - Evaluate integer arithmetic at compile time
   - Handle `constexpr` functions
   - Enable static_if/static_for

2. **Template Instantiation** (2-3 weeks)
   - Template argument deduction
   - Specialization selection
   - Recursive instantiation with depth limit

3. **Code Generation** (2-3 weeks)
   - HIR → ParseTree translation
   - All expression and statement nodes
   - Function and type emission

4. **Test Coverage** (1-2 weeks)
   - Tests for kanagawa_resolve
   - Tests for kanagawa_sema
   - More tests for kanagawa_typeck

#### Phase 2: Quality & Polish (Production Ready)
5. **Error Improvements** (1 week)
   - Symbol suggestions with edit distance
   - Error context stacking
   - Rich terminal formatting

6. **Type Inference Completion** (1-2 weeks)
   - Full unification algorithm
   - Auto type resolution
   - Template argument deduction

7. **Benchmarks** (1 week)
   - Compare to Haskell frontend
   - Identify bottlenecks
   - Optimize hot paths

#### Phase 3: Tooling (Developer Experience)
8. **Pretty Printer** (1-2 weeks)
   - CST → formatted source
   - Configurable style options
   - Integration with driver

9. **Language Server** (3-4 weeks)
   - Basic features: hover, goto definition
   - Diagnostics publishing
   - Completion basics

10. **Documentation Generator** (1 week)
    - Extract doc comments
    - Generate HTML/Markdown
    - Cross-reference linking

---

## Risk Assessment

### High Risk
1. **Template Instantiation Complexity**
   - Haskell has 8 nested passes inside `instantiateTemplates`
   - May require significant design iteration
   - Test with complex generic code

2. **ParseTree Format Matching**
   - Must exactly match C++ backend expectations
   - No specification exists - reverse engineer from Haskell
   - Requires extensive integration testing

3. **Untested Semantic Passes**
   - 6.6K lines with zero tests
   - Likely contains subtle bugs
   - Add tests before further development

### Medium Risk
4. **Performance Regression**
   - No benchmarks to validate improvement claim
   - May need optimization work
   - Consider parallel compilation

5. **Incremental Architecture**
   - Adding salsa/query later is harder than upfront
   - May need refactoring for LSP
   - Consider now vs later tradeoff

### Low Risk
6. **Tooling Implementation**
   - Well-understood problem space
   - Good foundation exists
   - Standard patterns available

---

## Conclusion

The Rust frontend is **on track** for its primary goals but has **critical gaps** in code generation and template instantiation. The architecture is sound and the foundation is solid.

**Recommended Next Steps:**
1. Add test coverage for kanagawa_resolve and kanagawa_sema (immediate)
2. Implement constant expression evaluation (blocks templates)
3. Implement template instantiation (blocks generic code)
4. Implement code generation (blocks compilation)
5. Add benchmarks to validate performance goals
6. Then proceed to tooling (formatter, LSP)

**Timeline Estimate to Feature Parity:** 8-12 weeks of focused development

The investment in Rust is paying off with a cleaner architecture, better tooling potential, and memory safety guarantees. The remaining work is substantial but well-defined.
