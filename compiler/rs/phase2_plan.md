# Kanagawa Rust Frontend: Phase 2 Comprehensive Plan

**Document Version:** 1.0
**Date:** 2025-12-15
**Scope:** Complete roadmap from current state to production-ready toolchain

---

## Table of Contents

1. [Vision & Goals Alignment](#1-vision--goals-alignment)
2. [Architectural Decisions](#2-architectural-decisions)
   - Decision 1-7: Original decisions
   - Decision 8: Diagnostic Rendering (ariadne)
   - Decision 9: Template Performance Strategy
   - Decision 10: Threading Configuration
   - Decision 11: Type Inference Architecture
   - Decision 12: Error Recovery Strategy
   - Decision 13: Import Resolution
3. [Workstreams Overview](#3-workstreams-overview)
4. [Detailed Technical Specifications](#4-detailed-technical-specifications)
5. [Implementation Phases](#5-implementation-phases)
6. [Integration Points](#6-integration-points)
7. [Risk Assessment & Mitigation](#7-risk-assessment--mitigation)
8. [Success Criteria](#8-success-criteria)
9. [Appendices](#9-appendices)
10. [Implementation Roadmap: What to Build Next](#10-implementation-roadmap-what-to-build-next)

---

## 1. Vision & Goals Alignment

### Primary Goals (Restated)

| Goal | Success Metric | Current State |
|------|----------------|---------------|
| **Rewrite in Rust** | Full compilation pipeline functional | 65% - Missing codegen, templates |
| **Improve Performance** | 2x faster than Haskell frontend | Unknown - No benchmarks |
| **Tooling Foundation** | LSP + Formatter shipping | 0% - Infrastructure ready |
| **Excellent Diagnostics** | Parity with rustc-quality errors | 40% - Basic errors, no suggestions |

### Strategic Principles

1. **Incremental by Design** - Every component should support incremental computation from day one
2. **Fail Gracefully** - Handle malformed code without crashing; provide partial results
3. **Composable Architecture** - Each crate should be usable independently
4. **Test-Driven Quality** - No new feature ships without comprehensive tests
5. **Performance Aware** - Profile before optimizing, but design for efficiency

---

## 2. Architectural Decisions

### Decision 1: Incremental Computation Framework

**Decision: Use Salsa 0.24+**

**Rationale:**
- Proven at scale by rust-analyzer (handles 400K+ LOC codebases)
- Demand-driven computation reduces latency for IDE use cases
- Early cutoff optimization prevents cascading recomputation
- Durability system distinguishes stable vs volatile inputs
- Well-documented, actively maintained

**Alternatives Considered:**
| Alternative | Reason Rejected |
|-------------|-----------------|
| Custom caching | Too much work to match Salsa's sophistication |
| No incrementality | Unacceptable LSP latency (100ms+ per keystroke) |
| Salvia (async Salsa) | Less mature, async not required for our use case |

**Integration Plan:**
```rust
// Core database trait hierarchy
#[salsa::db]
pub trait SourceDatabase {
    #[salsa::input]
    fn file_text(&self, file: FileId) -> Arc<String>;

    #[salsa::input]
    fn file_source_root(&self, file: FileId) -> SourceRootId;
}

#[salsa::db]
pub trait SyntaxDatabase: SourceDatabase {
    fn parse(&self, file: FileId) -> Parse<SourceFile>;
    fn syntax_tree(&self, file: FileId) -> Arc<SyntaxNode>;
}

#[salsa::db]
pub trait HirDatabase: SyntaxDatabase {
    fn hir_file(&self, file: FileId) -> Arc<HirFile>;
    fn symbol_table(&self, file: FileId) -> Arc<SymbolTable>;
    fn definitions(&self, file: FileId) -> Arc<Definitions>;
}

#[salsa::db]
pub trait SemanticDatabase: HirDatabase {
    fn type_of(&self, def: DefId) -> Ty;
    fn infer_body(&self, func: DefId) -> Arc<InferenceResult>;
    fn resolve_path(&self, path: &Path, scope: ScopeId) -> Option<DefId>;
}
```

**Durability Configuration:**
```rust
pub fn set_file_text(db: &mut dyn SourceDatabase, file: FileId, text: String) {
    // User files are low durability (change frequently)
    db.set_file_text_with_durability(file, Arc::new(text), Durability::LOW);
}

pub fn set_library_file(db: &mut dyn SourceDatabase, file: FileId, text: String) {
    // Library files are high durability (rarely change)
    db.set_file_text_with_durability(file, Arc::new(text), Durability::HIGH);
}
```

---

### Decision 2: LSP Framework

**Decision: Use tower-lsp**

**Rationale:**
- Async-first design matches modern LSP expectations
- Better documentation than lsp-server
- Active community maintenance (tower-lsp-community fork)
- General-purpose, handles edge cases well
- Tokio integration for concurrent request handling

**Alternatives Considered:**
| Alternative | Reason Rejected |
|-------------|-----------------|
| lsp-server | Minimal docs, designed specifically for rust-analyzer |
| Custom implementation | Unnecessary complexity, protocol is well-defined |

**Architecture:**
```rust
#[tower_lsp::async_trait]
impl LanguageServer for KanagawaLanguageServer {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult>;
    async fn shutdown(&self) -> Result<()>;

    // Document synchronization
    async fn did_open(&self, params: DidOpenTextDocumentParams);
    async fn did_change(&self, params: DidChangeTextDocumentParams);
    async fn did_save(&self, params: DidSaveTextDocumentParams);
    async fn did_close(&self, params: DidCloseTextDocumentParams);

    // Language features
    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>>;
    async fn goto_definition(&self, params: GotoDefinitionParams) -> Result<Option<GotoDefinitionResponse>>;
    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>>;
    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>>;
    async fn formatting(&self, params: DocumentFormattingParams) -> Result<Option<Vec<TextEdit>>>;

    // Diagnostics (push-based)
    // Triggered internally, published via client.publish_diagnostics()
}
```

---

### Decision 3: Formatter Architecture

**Decision: Custom formatter operating on CST (rowan SyntaxNode)**

**Rationale:**
- CST preserves comments and whitespace - essential for formatting
- rowan already provides lossless tree - leverage existing investment
- Formatting invalid code is required for LSP "format on type"
- prettyplease/rustfmt are Rust-specific, don't apply to Kanagawa

**Design Principles:**
1. **Never lose comments** - All comments must appear in output
2. **Deterministic** - Same input always produces same output
3. **Idempotent** - Formatting formatted code produces identical output
4. **Configurable minimally** - Indent width, line width, brace style only
5. **Graceful degradation** - Partial formatting for invalid code

**Algorithm: Wadler-Lindig Pretty Printer**
```rust
pub enum Doc {
    Nil,
    Text(String),
    Line,                    // Line break (becomes space if flattened)
    FlatAlt(Box<Doc>, Box<Doc>), // Choose based on fitting
    Concat(Box<Doc>, Box<Doc>),
    Nest(i32, Box<Doc>),     // Increase indent
    Group(Box<Doc>),         // Try to fit on one line
}

impl Doc {
    pub fn render(&self, width: usize) -> String;
}
```

**Configuration:**
```rust
#[derive(Debug, Clone)]
pub struct FormatConfig {
    /// Spaces per indentation level (default: 4)
    pub indent_width: u32,

    /// Maximum line width before breaking (default: 100)
    pub max_line_width: u32,

    /// Brace style for blocks
    pub brace_style: BraceStyle,

    /// Trailing commas in multi-line constructs
    pub trailing_commas: TrailingCommas,
}

#[derive(Debug, Clone, Copy)]
pub enum BraceStyle {
    /// Opening brace on same line: `fn foo() {`
    SameLine,
    /// Opening brace on next line (Allman style)
    NextLine,
}

#[derive(Debug, Clone, Copy)]
pub enum TrailingCommas {
    /// Never add trailing commas
    Never,
    /// Add trailing commas in multi-line only
    MultiLine,
    /// Always add trailing commas
    Always,
}
```

---

### Decision 4: Error Suggestion Engine

**Decision: Implement Damerau-Levenshtein distance with context-aware filtering**

**Rationale:**
- Edit distance provides "did you mean?" suggestions
- Context filtering prevents suggesting out-of-scope symbols
- Haskell frontend already does this - proven valuable

**Implementation:**
```rust
pub struct SuggestionEngine<'db> {
    db: &'db dyn SemanticDatabase,
}

impl<'db> SuggestionEngine<'db> {
    /// Find similar symbols within max_distance edits
    pub fn suggest_symbol(
        &self,
        name: &str,
        scope: ScopeId,
        max_distance: usize,
    ) -> Vec<Suggestion> {
        let candidates = self.visible_symbols(scope);
        let mut suggestions: Vec<_> = candidates
            .filter_map(|(candidate_name, def_id)| {
                let distance = damerau_levenshtein(name, candidate_name);
                if distance <= max_distance {
                    Some(Suggestion {
                        name: candidate_name.to_string(),
                        distance,
                        def_id,
                        kind: self.db.def_kind(def_id),
                    })
                } else {
                    None
                }
            })
            .collect();

        suggestions.sort_by_key(|s| s.distance);
        suggestions.truncate(3); // Top 3 suggestions
        suggestions
    }
}
```

---

### Decision 5: Parallelism Strategy

**Decision: Rayon for data parallelism, single-threaded Salsa queries**

**Rationale:**
- Salsa handles concurrent reads but serializes writes
- Type checking per-function is embarrassingly parallel
- Code generation per-item is embarrassingly parallel
- rayon is zero-config and well-tested

**Where to Parallelize:**
| Phase | Parallelism | Reason |
|-------|-------------|--------|
| Lexing | Per-file | Independent |
| Parsing | Per-file | Independent |
| AST lowering | Per-file | Independent |
| HIR lowering | Per-file | Independent after imports resolved |
| Type checking | Per-function | Bodies independent after signatures |
| Code generation | Per-item | Independent |
| Validation | Per-file | Independent |

**Implementation Pattern:**
```rust
use rayon::prelude::*;

pub fn type_check_module(db: &dyn SemanticDatabase, module: ModuleId) -> Vec<Diagnostic> {
    let functions = db.module_functions(module);

    functions
        .par_iter() // Parallel iteration
        .flat_map(|&func_id| {
            type_check_function(db, func_id)
        })
        .collect()
}
```

---

### Decision 6: Source Text Storage

**Decision: Start with `Arc<String>`, add rope later if needed**

**Rationale:**
- Most Kanagawa files are small (<50KB)
- `Arc<String>` enables zero-copy sharing across threads
- Rope adds complexity for marginal gain on small files
- Can upgrade to `ropey` if profiling shows need

**File ID System:**
```rust
/// Unique identifier for a source file in the compilation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileId(u32);

/// Source file metadata
pub struct SourceFile {
    pub id: FileId,
    pub path: PathBuf,
    pub text: Arc<String>,
}

/// Line/column index for a file
pub struct LineIndex {
    /// Byte offsets of line starts
    line_starts: Vec<u32>,
}

impl LineIndex {
    pub fn line_col(&self, offset: u32) -> (u32, u32);
    pub fn offset(&self, line: u32, col: u32) -> u32;
}
```

---

### Decision 7: Template Instantiation Strategy

**Decision: Lazy instantiation with memoization via Salsa**

**Rationale:**
- Eager instantiation explodes compile time for heavily templated code
- Salsa memoization prevents re-instantiation
- Matches Haskell's approach with `--template-iterations` limit

**Design:**
```rust
#[salsa::tracked]
pub fn instantiate_template(
    db: &dyn SemanticDatabase,
    template: DefId,
    args: TemplateArgs,
) -> Result<DefId, TemplateError> {
    // Check cache first (Salsa handles this)

    // Depth limit to prevent infinite recursion
    let depth = db.instantiation_depth();
    if depth > MAX_TEMPLATE_DEPTH {
        return Err(TemplateError::RecursionLimit);
    }

    // Substitute template parameters
    let specialized = substitute_params(db, template, &args)?;

    // Type check the instantiation
    let type_errors = type_check_instantiation(db, specialized)?;
    if !type_errors.is_empty() {
        return Err(TemplateError::TypeErrors(type_errors));
    }

    Ok(specialized)
}
```

---

### Decision 8: Diagnostic Rendering

**Decision: Use `ariadne` for rich terminal output**

**Rationale:**
- More modern and actively developed than alternatives
- Superior visual output with better Unicode rendering
- Excellent multi-line span handling
- Fluent builder API with better ergonomics
- Supports inline labels with multiple styles
- Better color theming support

**Alternatives Considered:**
| Alternative | Reason Not Chosen |
|-------------|-------------------|
| codespan-reporting | Older API, less visually appealing output |
| miette | More focused on application errors than compiler diagnostics |
| annotate-snippets | Lower-level, requires more boilerplate |

**Example Output:**
```
Error: duplicate definition of `foo`
   ╭─[src/main.k:10:1]
   │
 5 │ fn foo() { }
   │    ─┬─
   │     ╰── first defined here
   ·
10 │ fn foo() { }
   │    ─┬─
   │     ╰── duplicate definition
   │
   │ Note: consider renaming one of the functions
───╯
```

**Integration:**
```rust
use ariadne::{Color, Label, Report, ReportKind, Source};

pub fn render_diagnostic(
    diag: &SemaDiagnostic,
    source: &str,
    filename: &str,
) -> String {
    let mut report = Report::build(ReportKind::Error, filename, diag.span.start)
        .with_code(diag.code.to_string())
        .with_message(&diag.message)
        .with_label(
            Label::new((filename, diag.span.start..diag.span.end))
                .with_message(&diag.label)
                .with_color(Color::Red),
        );

    for related in &diag.related {
        report = report.with_label(
            Label::new((filename, related.span.start..related.span.end))
                .with_message(&related.message)
                .with_color(Color::Blue),
        );
    }

    for note in &diag.notes {
        report = report.with_note(note);
    }

    let mut output = Vec::new();
    report
        .finish()
        .write((filename, Source::from(source)), &mut output)
        .unwrap();

    String::from_utf8(output).unwrap()
}
```

---

### Decision 9: Template Performance Strategy

**Decision: Aggressive memoization with canonical forms and parallel instantiation**

**Context:** The Haskell frontend suffers from severe performance issues with heavily templated code (10+ minute compile times). This must be solved in the Rust implementation.

**Root Causes in Haskell (Identified):**
1. Repeated instantiation of identical templates
2. Deep AST copying on each substitution
3. No structural sharing between instantiations
4. Sequential processing
5. Exponential constraint generation in type deduction

**Strategies:**

**1. Salsa Memoization with Canonical Arguments**
```rust
/// Template arguments in canonical form for maximum cache hits
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TemplateArgs {
    /// Type arguments normalized to canonical form
    type_args: Arc<[Ty]>,
    /// Value arguments
    value_args: Arc<[ConstValue]>,
}

impl TemplateArgs {
    /// Normalize to canonical form (Vec<i32> == Vec<signed<32>>)
    pub fn canonicalize(types: &[Ty], values: &[ConstValue]) -> Self {
        let canonical_types: Vec<Ty> = types.iter()
            .map(|ty| ty.canonicalize())
            .collect();
        Self {
            type_args: canonical_types.into(),
            value_args: values.to_vec().into(),
        }
    }
}

/// Salsa-tracked instantiation - automatic memoization
#[salsa::tracked]
pub fn instantiate_template(
    db: &dyn SemanticDatabase,
    template: DefId,
    args: TemplateArgs,
) -> Result<DefId, TemplateError> {
    // Salsa handles caching - identical args = instant return
    // ...
}
```

**2. Efficient Substitution with Structural Sharing**
```rust
impl Substitution {
    /// Apply substitution, preserving structure where unchanged
    pub fn apply_ty(&self, ty: &Ty) -> Ty {
        match ty {
            Ty::Param(id) => self.type_map.get(id)
                .cloned()
                .unwrap_or_else(|| ty.clone()),

            Ty::Array { element, dims, attrs } => {
                let new_elem = self.apply_ty(element);
                // Only allocate if something changed
                if std::ptr::eq(element.as_ref(), &new_elem) {
                    ty.clone()  // Cheap Arc clone
                } else {
                    Ty::Array {
                        element: Box::new(new_elem),
                        dims: dims.clone(),
                        attrs: attrs.clone(),
                    }
                }
            }
            _ => ty.clone(),
        }
    }
}
```

**3. Parallel Instantiation**
```rust
use rayon::prelude::*;

pub fn instantiate_batch(
    db: &dyn SemanticDatabase,
    requests: &[(DefId, TemplateArgs)],
    config: &ParallelConfig,
) -> Vec<Result<DefId, TemplateError>> {
    if config.enabled && requests.len() > 1 {
        requests
            .par_iter()
            .map(|(template, args)| db.instantiate_template(*template, args.clone()))
            .collect()
    } else {
        requests
            .iter()
            .map(|(template, args)| db.instantiate_template(*template, args.clone()))
            .collect()
    }
}
```

**4. Depth Limiting with Diagnostic Trace**
```rust
const MAX_TEMPLATE_DEPTH: u32 = 128;

#[derive(Debug, Clone)]
pub struct InstantiationTrace {
    pub entries: Vec<(DefId, TemplateArgs, Span)>,
}

impl InstantiationTrace {
    pub fn format_for_error(&self, db: &dyn SemanticDatabase) -> String {
        let mut s = String::from("instantiation trace:\n");
        for (i, (def, args, span)) in self.entries.iter().enumerate().take(10) {
            let name = db.def_name(*def);
            let args_str = format_template_args(db, args);
            writeln!(s, "  {}. {}<{}> at {}", i + 1, name, args_str, span).unwrap();
        }
        if self.entries.len() > 10 {
            writeln!(s, "  ... ({} more)", self.entries.len() - 10).unwrap();
        }
        s
    }
}
```

**5. Progress Reporting**
```rust
pub trait CompileProgress: Send + Sync {
    fn template_started(&self, name: &str, depth: u32);
    fn template_finished(&self, name: &str, duration: Duration);
    fn templates_queued(&self, count: usize);
}

// CLI progress bar integration
pub struct ProgressBar { /* ... */ }

impl CompileProgress for ProgressBar {
    fn templates_queued(&self, count: usize) {
        self.set_length(count as u64);
        self.set_message("Instantiating templates...");
    }
    // ...
}
```

**Performance Target:** Compile highly-templated code in <30 seconds that takes 10+ minutes in Haskell.

---

### Decision 10: Threading Configuration

**Decision: User-configurable parallelism with sensible defaults**

**Rationale:**
- Users on laptops may want reduced thread count (battery, heat)
- Shared servers benefit from resource limits
- Single-threaded mode aids debugging and reproducibility
- Some CI environments have thread restrictions

**Configuration:**
```rust
/// Parallelism configuration
#[derive(Debug, Clone)]
pub struct ParallelConfig {
    /// Number of threads (0 = auto-detect via num_cpus)
    pub num_threads: usize,
    /// Whether parallelism is enabled at all
    pub enabled: bool,
    /// Stack size per thread (for deep recursion)
    pub stack_size: usize,
}

impl ParallelConfig {
    pub fn from_env_and_args(args: &Args) -> Self {
        // Priority: CLI args > env var > auto-detect
        let num_threads = if args.single_threaded {
            1
        } else {
            args.jobs.unwrap_or_else(|| {
                std::env::var("KANAGAWA_NUM_THREADS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)  // 0 = auto
            })
        };

        Self {
            num_threads,
            enabled: num_threads != 1,
            stack_size: 8 * 1024 * 1024,  // 8MB for deep template instantiation
        }
    }

    pub fn init_thread_pool(&self) -> Result<(), rayon::ThreadPoolBuildError> {
        let mut builder = rayon::ThreadPoolBuilder::new()
            .stack_size(self.stack_size);

        if self.num_threads > 0 {
            builder = builder.num_threads(self.num_threads);
        }

        builder.build_global()
    }
}
```

**CLI Interface:**
```
kanagawa compile [OPTIONS] <FILES>...

Options:
  -j, --jobs <N>       Number of parallel jobs [default: CPU count]
      --single-threaded  Disable parallelism (equivalent to -j1)
```

**Environment Variable:** `KANAGAWA_NUM_THREADS=4`

**Adaptive Parallelism Helper:**
```rust
/// Execute work respecting parallelism config
pub fn parallel_for_each<T, F>(
    config: &ParallelConfig,
    items: impl IntoParallelIterator<Item = T>,
    f: F,
) where
    T: Send,
    F: Fn(T) + Sync + Send,
{
    if config.enabled {
        items.into_par_iter().for_each(f);
    } else {
        items.into_iter().for_each(f);
    }
}
```

---

### Decision 11: Type Inference Architecture

**Decision: Bidirectional type checking with union-find unification**

**Rationale:**
- Bidirectional checking propagates type information both ways, reducing inference load
- Union-find provides near-constant-time unification operations
- Iterative constraint solving avoids stack overflow on complex types
- Matches proven designs from rust-analyzer and other production compilers

**Architecture:**

**1. Bidirectional Type Checking**
```rust
pub struct TypeChecker<'db> {
    db: &'db dyn SemanticDatabase,
    unifier: TypeUnifier,
    errors: Vec<TypeError>,
}

impl<'db> TypeChecker<'db> {
    /// Check expression against known expected type (checking mode)
    pub fn check(&mut self, expr: &HirExpr, expected: &Ty) -> Result<(), TypeError> {
        match (&expr.kind, expected) {
            // Lambda with known parameter types - propagate inward
            (HirExprKind::Lambda { params, body },
             Ty::Function { params: param_tys, return_ty, .. }) => {
                for (param, ty) in params.iter().zip(param_tys) {
                    self.bind_local(param.def_id, ty.clone());
                }
                self.check(body, return_ty)
            }

            // Array literal with known element type
            (HirExprKind::ArrayLiteral(elems), Ty::Array { element, .. }) => {
                for elem in elems {
                    self.check(elem, element)?;
                }
                Ok(())
            }

            // Fall back to inference + unification
            _ => {
                let inferred = self.infer(expr)?;
                self.unify(&inferred, expected)
            }
        }
    }

    /// Infer type of expression (synthesis mode)
    pub fn infer(&mut self, expr: &HirExpr) -> Result<Ty, TypeError> {
        match &expr.kind {
            HirExprKind::IntLiteral { suffix: Some(s), .. } => {
                Ok(suffix_to_type(s))
            }
            HirExprKind::IntLiteral { suffix: None, .. } => {
                // Fresh variable, constrained to numeric
                let var = self.fresh_type_var();
                self.add_constraint(Constraint::Numeric(var.clone()));
                Ok(var)
            }
            HirExprKind::Call { func, args } => {
                let func_ty = self.infer(func)?;
                self.check_call(func_ty, args)
            }
            // ... other cases
        }
    }
}
```

**2. Union-Find with Path Compression**
```rust
pub struct TypeUnifier {
    /// Parent pointers for union-find
    parent: Vec<usize>,
    /// Rank for union by rank optimization
    rank: Vec<usize>,
    /// Resolved types for each variable
    types: Vec<Option<Ty>>,
}

impl TypeUnifier {
    /// Find representative with path compression - O(α(n))
    pub fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    /// Union by rank - keeps tree balanced
    pub fn union(&mut self, x: usize, y: usize) -> Result<(), UnifyError> {
        let px = self.find(x);
        let py = self.find(y);
        if px == py { return Ok(()); }

        // Check for conflicting concrete types
        match (&self.types[px], &self.types[py]) {
            (Some(tx), Some(ty)) if tx != ty => {
                return Err(UnifyError::Conflict(tx.clone(), ty.clone()));
            }
            (Some(_), None) => {
                self.parent[py] = px;
            }
            (None, Some(_)) => {
                self.parent[px] = py;
            }
            _ => {
                // Union by rank
                match self.rank[px].cmp(&self.rank[py]) {
                    Ordering::Less => self.parent[px] = py,
                    Ordering::Greater => self.parent[py] = px,
                    Ordering::Equal => {
                        self.parent[py] = px;
                        self.rank[px] += 1;
                    }
                }
            }
        }
        Ok(())
    }
}
```

**3. Iterative Constraint Solving**
```rust
pub struct ConstraintSolver {
    unifier: TypeUnifier,
    worklist: VecDeque<Constraint>,
    seen: HashSet<u64>,  // Hash of constraints to avoid cycles
}

impl ConstraintSolver {
    pub fn solve(mut self) -> Result<Substitution, TypeError> {
        while let Some(constraint) = self.worklist.pop_front() {
            let hash = constraint.hash_key();
            if self.seen.contains(&hash) {
                continue;
            }
            self.seen.insert(hash);

            match constraint {
                Constraint::Eq(a, b) => {
                    self.unify(&a, &b)?;
                }
                Constraint::Numeric(var) => {
                    self.mark_numeric(var);
                }
            }
        }

        self.finalize()
    }

    /// Default unsolved numeric variables to i32
    fn finalize(mut self) -> Result<Substitution, TypeError> {
        for var in self.unifier.unsolved() {
            if self.is_numeric(var) {
                self.unifier.bind(var, Ty::Signed(32));
            } else {
                return Err(TypeError::AmbiguousType(var));
            }
        }
        Ok(self.unifier.into_substitution())
    }
}
```

**4. Template Argument Deduction**
```rust
pub fn deduce_template_args(
    db: &dyn SemanticDatabase,
    template: DefId,
    call_arg_types: &[Ty],
) -> Result<TemplateArgs, DeductionError> {
    let template_def = db.template_def(template);
    let param_types = db.template_param_types(template);

    let mut bindings: HashMap<DefId, Ty> = HashMap::new();

    // Match argument types against parameter patterns
    for (param_ty, arg_ty) in param_types.iter().zip(call_arg_types) {
        unify_for_deduction(param_ty, arg_ty, &mut bindings)?;
    }

    // Build final arguments, using defaults where not deduced
    let type_args: Vec<Ty> = template_def.type_params
        .iter()
        .map(|param| {
            bindings.get(&param.def_id).cloned()
                .or_else(|| param.default.clone())
                .ok_or_else(|| DeductionError::CouldNotDeduce {
                    param: param.name.clone(),
                    suggestion: suggest_explicit_syntax(template, &bindings),
                })
        })
        .collect::<Result<_, _>>()?;

    Ok(TemplateArgs::canonicalize(&type_args, &[]))
}
```

**Performance Characteristics:**
| Operation | Complexity | Notes |
|-----------|------------|-------|
| Type variable creation | O(1) | Index allocation |
| Find (union-find) | O(α(n)) | Near constant with path compression |
| Unification | O(α(n)) | Per type variable |
| Constraint solving | O(n × α(n)) | n = number of constraints |
| Full function inference | O(n × α(n)) | Linear in expression count |

---

### Decision 12: Error Recovery Strategy

**Decision: Aggressive error recovery at every compilation phase**

**Rationale:** LSP and editor tooling require robust handling of incomplete/invalid code. Users type code incrementally; the compiler must provide useful feedback at every stage.

**Principles:**
1. **Never crash on invalid input** - All malformed code should produce diagnostics, not panics
2. **Partial results are valuable** - Even with errors, provide whatever information is available
3. **Continue past errors** - Don't stop at first error; collect all errors in a phase
4. **Graceful degradation** - Later phases work with whatever earlier phases produced

**Implementation by Phase:**

**Lexer Error Recovery:**
```rust
/// Lexer continues after invalid tokens
pub fn lex_with_recovery(source: &str) -> (Vec<Token>, Vec<LexError>) {
    let mut tokens = Vec::new();
    let mut errors = Vec::new();

    while !self.at_end() {
        match self.next_token() {
            Ok(token) => tokens.push(token),
            Err(e) => {
                errors.push(e);
                self.skip_to_recovery_point(); // Skip to next whitespace/newline
                tokens.push(Token::Error); // Insert error token
            }
        }
    }

    (tokens, errors)
}
```

**Parser Error Recovery:**
```rust
/// Parser recovers at statement/declaration boundaries
impl Parser {
    fn parse_stmt_with_recovery(&mut self) -> Option<Stmt> {
        match self.parse_stmt() {
            Ok(stmt) => Some(stmt),
            Err(e) => {
                self.errors.push(e);
                self.synchronize(); // Skip to next statement boundary
                None
            }
        }
    }

    fn synchronize(&mut self) {
        // Skip tokens until we find a safe recovery point
        while !self.at_end() {
            if self.previous().kind == TokenKind::Semicolon {
                return;
            }
            match self.current().kind {
                TokenKind::Fn | TokenKind::Struct | TokenKind::Class |
                TokenKind::If | TokenKind::For | TokenKind::While |
                TokenKind::Return => return,
                _ => self.advance(),
            }
        }
    }
}
```

**Type Checking Error Recovery:**
```rust
/// Type checker uses error type for failed expressions
impl TypeChecker {
    fn infer_with_recovery(&mut self, expr: &HirExpr) -> Ty {
        match self.infer(expr) {
            Ok(ty) => ty,
            Err(e) => {
                self.errors.push(e);
                Ty::Error // Poison type that unifies with anything
            }
        }
    }
}

/// Error type prevents cascading errors
impl Ty {
    pub fn is_error(&self) -> bool {
        matches!(self, Ty::Error)
    }
}

// Unification with error type always succeeds (prevents cascading)
fn unify(a: &Ty, b: &Ty) -> Result<Ty, UnifyError> {
    if a.is_error() || b.is_error() {
        return Ok(Ty::Error); // Suppress further errors
    }
    // ... normal unification
}
```

**LSP Integration:**
```rust
/// LSP always returns results, even with errors
impl KanagawaLanguageServer {
    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let db = self.db.read();
        let file_id = db.file_id_for_uri(&params.text_document.uri);

        // Even if file has errors, try to provide hover info
        if let Some(symbol) = db.symbol_at_best_effort(file_id, offset) {
            // May have partial type info even with errors
            let type_info = db.type_of_best_effort(symbol.def_id);
            return Ok(Some(make_hover(symbol, type_info)));
        }

        Ok(None)
    }
}
```

**Testing Error Recovery:**
```rust
#[test]
fn test_parser_recovers_from_missing_semicolon() {
    let source = "fn foo() { let x = 1 let y = 2; }";
    //                              ^ missing semicolon

    let (ast, errors) = parse_with_recovery(source);

    // Should still parse the function
    assert_eq!(ast.functions.len(), 1);
    // Should report the error
    assert_eq!(errors.len(), 1);
    assert!(errors[0].message.contains("expected `;`"));
}

#[test]
fn test_type_checker_continues_after_error() {
    let source = r#"
        fn foo() {
            let x: i32 = "not an int";  // Error
            let y: i32 = 42;            // Should still type check
        }
    "#;

    let (_, errors) = type_check_with_recovery(source);

    // Should report the type mismatch
    assert_eq!(errors.len(), 1);
    // y should be correctly typed despite earlier error
}
```

---

### Decision 13: Import Resolution

**Decision: Single-file entry point with recursive import resolution via include directories**

**Context:** The compiler is invoked on a single file. That file may have imports, which recursively resolve to more files.

**Configuration:**
```rust
/// Compiler configuration for import resolution
pub struct ImportConfig {
    /// Directories to search for imports (in order)
    pub include_dirs: Vec<PathBuf>,
    /// Standard library path (searched last)
    pub stdlib_path: Option<PathBuf>,
}
```

**Resolution Algorithm:**
```rust
pub fn resolve_import(
    config: &ImportConfig,
    importing_file: &Path,
    import_path: &str,
) -> Result<PathBuf, ImportError> {
    // 1. Try relative to importing file
    let relative = importing_file.parent().unwrap().join(import_path);
    if relative.exists() {
        return Ok(relative.canonicalize()?);
    }

    // 2. Try each include directory
    for dir in &config.include_dirs {
        let candidate = dir.join(import_path);
        if candidate.exists() {
            return Ok(candidate.canonicalize()?);
        }
    }

    // 3. Try standard library
    if let Some(stdlib) = &config.stdlib_path {
        let candidate = stdlib.join(import_path);
        if candidate.exists() {
            return Ok(candidate.canonicalize()?);
        }
    }

    Err(ImportError::NotFound {
        import: import_path.to_string(),
        searched: config.search_paths(),
    })
}
```

**Cycle Detection:**
```rust
pub struct ImportResolver {
    config: ImportConfig,
    /// Files currently being processed (for cycle detection)
    in_progress: HashSet<PathBuf>,
    /// Already resolved files
    resolved: HashMap<PathBuf, FileId>,
}

impl ImportResolver {
    pub fn resolve_file(&mut self, path: &Path) -> Result<FileId, ImportError> {
        let canonical = path.canonicalize()?;

        // Already resolved?
        if let Some(&file_id) = self.resolved.get(&canonical) {
            return Ok(file_id);
        }

        // Cycle detection
        if self.in_progress.contains(&canonical) {
            return Err(ImportError::Cycle {
                path: canonical,
                chain: self.in_progress.iter().cloned().collect(),
            });
        }

        self.in_progress.insert(canonical.clone());

        // Parse file and resolve its imports
        let file_id = self.process_file(&canonical)?;

        self.in_progress.remove(&canonical);
        self.resolved.insert(canonical, file_id);

        Ok(file_id)
    }
}
```

**CLI Interface:**
```
kanagawa compile [OPTIONS] <FILE>

Options:
  -I, --include <DIR>    Add directory to import search path (can be repeated)
      --stdlib <PATH>    Path to standard library
```

---

## 3. Workstreams Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WORKSTREAMS                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WS1: Core Completion          WS2: Incremental Infrastructure              │
│  ├─ Constexpr evaluation       ├─ Salsa integration                         │
│  ├─ Template instantiation     ├─ Source database                           │
│  ├─ Code generation            ├─ Query definitions                         │
│  └─ Test coverage              └─ Change tracking                           │
│         │                              │                                    │
│         ▼                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │                    WS3: Quality & Polish                          │      │
│  │  ├─ Error suggestions (edit distance)                             │      │
│  │  ├─ Rich diagnostic rendering (ariadne)                           │      │
│  │  ├─ Benchmarks vs Haskell                                         │      │
│  │  └─ Performance optimization                                      │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│         │                              │                                    │
│         ▼                              ▼                                    │
│  WS4: Formatter                WS5: Language Server                         │
│  ├─ Pretty printer engine      ├─ Protocol handling                         │
│  ├─ Style configuration        ├─ Diagnostics publishing                    │
│  ├─ Comment preservation       ├─ Navigation (goto def, refs)               │
│  └─ CLI integration            ├─ Completion                                │
│                                └─ Hover information                         │
│         │                              │                                    │
│         ▼                              ▼                                    │
│  WS6: Documentation Generator                                               │
│  ├─ Doc comment extraction                                                  │
│  ├─ HTML/Markdown output                                                    │
│  └─ Cross-reference linking                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Workstream Dependencies

```
WS1 (Core) ─────────────────────────────────────────────────► WS6 (Docs)
    │                                                              ▲
    │                                                              │
    ▼                                                              │
WS2 (Incremental) ──────────────────────────────────────────►─────┘
    │
    ├─────────────────► WS4 (Formatter)
    │
    └─────────────────► WS5 (LSP) ◄─────── WS4 (Formatter)
                             ▲
                             │
                        WS3 (Quality)
```

**Critical Path:** WS1 → WS2 → WS5 (LSP depends on incremental, which depends on core)

**Parallel Opportunities:**
- WS4 (Formatter) can start immediately (only needs CST)
- WS6 (Docs) can start after WS1 (only needs HIR)
- WS3 (Quality) is continuous, no blocking dependencies

---

## 4. Detailed Technical Specifications

### 4.1 Workstream 1: Core Completion

#### 4.1.1 Constant Expression Evaluation

**Scope:** Evaluate integer arithmetic, boolean logic, and compile-time known expressions.

**Files to Create/Modify:**
- `crates/kanagawa_hir/src/consteval.rs` (new)
- `crates/kanagawa_hir/src/lower.rs` (modify - call consteval)

**Data Types:**
```rust
/// Result of constant evaluation
#[derive(Debug, Clone, PartialEq)]
pub enum ConstValue {
    /// Integer value with known width
    Int { value: i128, width: u32, signed: bool },
    /// Boolean value
    Bool(bool),
    /// String literal
    String(String),
    /// Array of constant values
    Array(Vec<ConstValue>),
    /// Evaluation failed (not a constant)
    NotConst,
    /// Evaluation produced an error
    Error(ConstEvalError),
}

/// Constant evaluation errors
#[derive(Debug, Clone)]
pub enum ConstEvalError {
    DivisionByZero,
    Overflow,
    UndefinedVariable(String),
    NonConstantExpression,
    UnsupportedOperation,
}
```

**Core Implementation:**
```rust
pub struct ConstEvaluator<'db> {
    db: &'db dyn HirDatabase,
    /// Known constant bindings in current scope
    bindings: HashMap<DefId, ConstValue>,
}

impl<'db> ConstEvaluator<'db> {
    pub fn eval_expr(&mut self, expr: &HirExpr) -> ConstValue {
        match &expr.kind {
            HirExprKind::IntLiteral { value, .. } => {
                ConstValue::Int { value: *value as i128, width: 64, signed: true }
            }
            HirExprKind::BoolLiteral(b) => ConstValue::Bool(*b),
            HirExprKind::Binary { op, left, right } => {
                self.eval_binary(*op, left, right)
            }
            HirExprKind::Unary { op, operand } => {
                self.eval_unary(*op, operand)
            }
            HirExprKind::Ident(def_id) => {
                self.bindings.get(def_id).cloned().unwrap_or(ConstValue::NotConst)
            }
            HirExprKind::Conditional { condition, then_expr, else_expr } => {
                match self.eval_expr(condition) {
                    ConstValue::Bool(true) => self.eval_expr(then_expr),
                    ConstValue::Bool(false) => self.eval_expr(else_expr),
                    _ => ConstValue::NotConst,
                }
            }
            _ => ConstValue::NotConst,
        }
    }

    fn eval_binary(&mut self, op: BinOp, left: &HirExpr, right: &HirExpr) -> ConstValue {
        let lhs = self.eval_expr(left);
        let rhs = self.eval_expr(right);

        match (op, lhs, rhs) {
            (BinOp::Add, ConstValue::Int { value: l, .. }, ConstValue::Int { value: r, .. }) => {
                ConstValue::Int { value: l.wrapping_add(r), width: 64, signed: true }
            }
            (BinOp::Sub, ConstValue::Int { value: l, .. }, ConstValue::Int { value: r, .. }) => {
                ConstValue::Int { value: l.wrapping_sub(r), width: 64, signed: true }
            }
            (BinOp::Mul, ConstValue::Int { value: l, .. }, ConstValue::Int { value: r, .. }) => {
                ConstValue::Int { value: l.wrapping_mul(r), width: 64, signed: true }
            }
            (BinOp::Div, ConstValue::Int { value: l, .. }, ConstValue::Int { value: r, .. }) => {
                if r == 0 {
                    ConstValue::Error(ConstEvalError::DivisionByZero)
                } else {
                    ConstValue::Int { value: l / r, width: 64, signed: true }
                }
            }
            // ... more operators
            _ => ConstValue::NotConst,
        }
    }
}
```

**Test Cases:**
```rust
#[test]
fn test_consteval_arithmetic() {
    assert_eq!(eval("1 + 2"), ConstValue::Int { value: 3, width: 64, signed: true });
    assert_eq!(eval("10 / 2"), ConstValue::Int { value: 5, width: 64, signed: true });
    assert_eq!(eval("10 / 0"), ConstValue::Error(ConstEvalError::DivisionByZero));
}

#[test]
fn test_consteval_boolean() {
    assert_eq!(eval("true && false"), ConstValue::Bool(false));
    assert_eq!(eval("1 < 2"), ConstValue::Bool(true));
}

#[test]
fn test_consteval_conditional() {
    assert_eq!(eval("true ? 1 : 2"), ConstValue::Int { value: 1, .. });
    assert_eq!(eval("false ? 1 : 2"), ConstValue::Int { value: 2, .. });
}
```

**Estimated LOC:** 600-800
**Estimated Time:** 1 week

---

#### 4.1.2 Template Instantiation

**Scope:** Instantiate generic templates with concrete type arguments.

**Files to Create:**
- `crates/kanagawa_hir/src/template.rs` (new)
- `crates/kanagawa_hir/src/substitute.rs` (new)

**Data Types:**
```rust
/// Template instantiation request
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TemplateArgs {
    pub type_args: Vec<Ty>,
    pub value_args: Vec<ConstValue>,
}

/// Instantiated template tracking
#[derive(Debug)]
pub struct Instantiation {
    pub original: DefId,
    pub args: TemplateArgs,
    pub result: DefId,
    pub specializations: Vec<DefId>, // Nested instantiations
}

/// Template instantiation context
pub struct TemplateInstantiator<'db> {
    db: &'db dyn SemanticDatabase,
    /// Current instantiation depth (for recursion limit)
    depth: u32,
    /// Cache of instantiations
    cache: HashMap<(DefId, TemplateArgs), DefId>,
    /// Maximum recursion depth
    max_depth: u32,
}
```

**Core Algorithm:**
```rust
impl<'db> TemplateInstantiator<'db> {
    pub fn instantiate(
        &mut self,
        template: DefId,
        args: TemplateArgs,
    ) -> Result<DefId, TemplateError> {
        // Check cache
        if let Some(&cached) = self.cache.get(&(template, args.clone())) {
            return Ok(cached);
        }

        // Check depth
        if self.depth >= self.max_depth {
            return Err(TemplateError::RecursionLimit {
                template: self.db.def_name(template),
                depth: self.depth,
            });
        }

        self.depth += 1;

        // Get template definition
        let template_def = self.db.template_def(template);

        // Validate argument count
        if args.type_args.len() != template_def.type_params.len() {
            return Err(TemplateError::ArgCountMismatch {
                expected: template_def.type_params.len(),
                got: args.type_args.len(),
            });
        }

        // Build substitution map
        let mut subst = Substitution::new();
        for (param, arg) in template_def.type_params.iter().zip(&args.type_args) {
            subst.insert_type(param.def_id, arg.clone());
        }
        for (param, arg) in template_def.value_params.iter().zip(&args.value_args) {
            subst.insert_value(param.def_id, arg.clone());
        }

        // Apply substitution to create specialized definition
        let specialized = self.substitute_template(&template_def, &subst)?;

        // Register instantiation
        let specialized_id = self.db.alloc_def(specialized);
        self.cache.insert((template, args), specialized_id);

        self.depth -= 1;

        Ok(specialized_id)
    }

    fn substitute_template(
        &mut self,
        template: &HirTemplate,
        subst: &Substitution,
    ) -> Result<HirItem, TemplateError> {
        match &template.item {
            HirItem::Function(func) => {
                Ok(HirItem::Function(self.substitute_function(func, subst)?))
            }
            HirItem::Struct(s) => {
                Ok(HirItem::Struct(self.substitute_struct(s, subst)?))
            }
            HirItem::Class(c) => {
                Ok(HirItem::Class(self.substitute_class(c, subst)?))
            }
            _ => Err(TemplateError::UnsupportedTemplateKind),
        }
    }

    fn substitute_type(&self, ty: &Ty, subst: &Substitution) -> Ty {
        match ty {
            Ty::Param(param_id) => {
                subst.get_type(*param_id).cloned().unwrap_or(ty.clone())
            }
            Ty::Array { element, dims, attrs } => {
                Ty::Array {
                    element: Box::new(self.substitute_type(element, subst)),
                    dims: dims.clone(),
                    attrs: attrs.clone(),
                }
            }
            Ty::Function { params, return_ty, attrs, kind } => {
                Ty::Function {
                    params: params.iter().map(|p| self.substitute_type(p, subst)).collect(),
                    return_ty: Box::new(self.substitute_type(return_ty, subst)),
                    attrs: attrs.clone(),
                    kind: *kind,
                }
            }
            // ... other type variants
            _ => ty.clone(),
        }
    }
}
```

**Template Argument Deduction:**
```rust
/// Deduce template arguments from call site
pub fn deduce_template_args(
    db: &dyn SemanticDatabase,
    template: DefId,
    call_args: &[Ty],
) -> Result<TemplateArgs, DeductionError> {
    let template_def = db.template_def(template);
    let func_ty = db.type_of(template);

    let mut deduced = HashMap::new();

    // Match call argument types against parameter types
    let param_types = match &func_ty {
        Ty::Function { params, .. } => params,
        _ => return Err(DeductionError::NotAFunction),
    };

    for (param_ty, arg_ty) in param_types.iter().zip(call_args) {
        unify_for_deduction(param_ty, arg_ty, &mut deduced)?;
    }

    // Check all parameters were deduced
    let type_args: Vec<_> = template_def.type_params
        .iter()
        .map(|p| {
            deduced.get(&p.def_id)
                .cloned()
                .ok_or(DeductionError::CouldNotDeduce(p.name.clone()))
        })
        .collect::<Result<_, _>>()?;

    Ok(TemplateArgs {
        type_args,
        value_args: vec![], // Value args must be explicit
    })
}
```

**Estimated LOC:** 1500-2000
**Estimated Time:** 2-3 weeks

---

#### 4.1.3 Code Generation (ParseTree Emission)

**Scope:** Translate HIR to C++ backend's ParseTree format.

**Files to Create:**
- `crates/kanagawa_codegen/Cargo.toml` (new crate)
- `crates/kanagawa_codegen/src/lib.rs`
- `crates/kanagawa_codegen/src/emit.rs`
- `crates/kanagawa_codegen/src/expr.rs`
- `crates/kanagawa_codegen/src/stmt.rs`
- `crates/kanagawa_codegen/src/ty.rs`
- `crates/kanagawa_codegen/src/decl.rs`

**Architecture:**
```rust
/// Code generator state
pub struct CodeGen<'a> {
    /// CString arena for safe FFI string management
    arena: &'a mut CStringArena,
    /// ParseTree being built
    tree: sys::ParseTree,
    /// Current expression list being built
    current_exprs: Vec<sys::Exp>,
    /// Definition ID to ParseTree handle mapping
    def_handles: HashMap<DefId, sys::Handle>,
}

impl<'a> CodeGen<'a> {
    pub fn new(arena: &'a mut CStringArena) -> Self;

    /// Emit a complete HIR file to ParseTree
    pub fn emit_file(&mut self, file: &HirFile) -> Result<(), CodeGenError> {
        // Emit all items
        for item in &file.items {
            self.emit_item(item)?;
        }
        Ok(())
    }

    /// Emit a single item
    pub fn emit_item(&mut self, item: &HirItem) -> Result<sys::Handle, CodeGenError> {
        match item {
            HirItem::Function(f) => self.emit_function(f),
            HirItem::Struct(s) => self.emit_struct(s),
            HirItem::Enum(e) => self.emit_enum(e),
            HirItem::Class(c) => self.emit_class(c),
            HirItem::Variable(v) => self.emit_variable(v),
            HirItem::Template(t) => {
                // Templates should be instantiated before codegen
                Err(CodeGenError::UninstantiatedTemplate(t.def_id))
            }
            // ... other items
        }
    }

    /// Emit a function definition
    pub fn emit_function(&mut self, func: &HirFunction) -> Result<sys::Handle, CodeGenError> {
        let name = self.arena.intern(&func.name);
        let return_ty = self.emit_type(&func.return_ty)?;

        let params: Vec<_> = func.params
            .iter()
            .map(|p| self.emit_param(p))
            .collect::<Result<_, _>>()?;

        let body = if let Some(block) = &func.body {
            Some(self.emit_block(block)?)
        } else {
            None
        };

        let attrs = self.emit_attrs(&func.attrs)?;

        // Call C FFI to build ParseTree node
        unsafe {
            Ok(sys::make_function(
                name,
                return_ty,
                params.as_ptr(),
                params.len(),
                body.unwrap_or(std::ptr::null()),
                attrs,
            ))
        }
    }

    /// Emit an expression
    pub fn emit_expr(&mut self, expr: &HirExpr) -> Result<sys::Handle, CodeGenError> {
        match &expr.kind {
            HirExprKind::IntLiteral { value, suffix } => {
                let lit = self.arena.intern(&value.to_string());
                unsafe { Ok(sys::make_int_literal(lit, *value as i64)) }
            }
            HirExprKind::BoolLiteral(b) => {
                unsafe { Ok(sys::make_bool_literal(*b)) }
            }
            HirExprKind::Ident(def_id) => {
                let name = self.def_name(*def_id);
                unsafe { Ok(sys::make_identifier(name)) }
            }
            HirExprKind::Binary { op, left, right } => {
                let l = self.emit_expr(left)?;
                let r = self.emit_expr(right)?;
                let op_str = self.binop_to_str(*op);
                unsafe { Ok(sys::make_binary_op(op_str, l, r)) }
            }
            HirExprKind::Call { func, args } => {
                let func_handle = self.emit_expr(func)?;
                let arg_handles: Vec<_> = args
                    .iter()
                    .map(|a| self.emit_expr(a))
                    .collect::<Result<_, _>>()?;
                unsafe {
                    Ok(sys::make_call(
                        func_handle,
                        arg_handles.as_ptr(),
                        arg_handles.len(),
                    ))
                }
            }
            // ... all other expression kinds
        }
    }

    /// Emit a type
    pub fn emit_type(&mut self, ty: &Ty) -> Result<sys::Handle, CodeGenError> {
        match ty {
            Ty::Void => unsafe { Ok(sys::make_void_type()) },
            Ty::Bool => unsafe { Ok(sys::make_bool_type()) },
            Ty::Signed(width) => unsafe { Ok(sys::make_signed_type(*width as i32)) },
            Ty::Unsigned(width) => unsafe { Ok(sys::make_unsigned_type(*width as i32)) },
            Ty::Float => unsafe { Ok(sys::make_float_type()) },
            Ty::Array { element, dims, attrs } => {
                let elem = self.emit_type(element)?;
                let dims: Vec<i64> = dims.iter().map(|&d| d as i64).collect();
                let attrs = self.emit_type_attrs(attrs)?;
                unsafe {
                    Ok(sys::make_array_type(elem, dims.as_ptr(), dims.len(), attrs))
                }
            }
            // ... other types
        }
    }
}
```

**Error Handling:**
```rust
#[derive(Debug, thiserror::Error)]
pub enum CodeGenError {
    #[error("uninstantiated template: {0:?}")]
    UninstantiatedTemplate(DefId),

    #[error("unsupported expression kind for codegen")]
    UnsupportedExpr,

    #[error("unsupported type for codegen: {0:?}")]
    UnsupportedType(Ty),

    #[error("FFI error: {0}")]
    FfiError(String),

    #[error("missing definition: {0:?}")]
    MissingDef(DefId),
}
```

**Integration with Driver:**
```rust
// In kanagawa_driver/src/main.rs
pub fn compile(args: &Args) -> Result<()> {
    // Parse → AST → HIR → TypeCheck → Resolve → Sema
    let db = create_database(&args)?;

    // Code generation
    let mut arena = CStringArena::new();
    let mut codegen = CodeGen::new(&mut arena);

    for file_id in db.all_files() {
        let hir_file = db.hir_file(file_id);
        codegen.emit_file(&hir_file)?;
    }

    // Call backend
    let tree = codegen.finish();
    let options = build_backend_options(&args, &arena)?;

    unsafe {
        let result = sys::compile(tree, options);
        if result != 0 {
            return Err(anyhow!("Backend compilation failed"));
        }
    }

    Ok(())
}
```

**Estimated LOC:** 2000-2500
**Estimated Time:** 2-3 weeks

---

#### 4.1.4 Test Coverage

**Scope:** Add comprehensive tests for untested modules.

**Targets:**
| Module | Current Tests | Target Tests | Focus Areas |
|--------|---------------|--------------|-------------|
| kanagawa_resolve | 0 | 50+ | Import cycles, re-exports, visibility |
| kanagawa_sema | 0 | 80+ | All validation rules, edge cases |
| kanagawa_typeck | 1 | 60+ | Inference rules, error cases |

**Test Strategy:**
```rust
// Property-based testing for type inference
#[cfg(test)]
mod proptest_inference {
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn infer_binary_preserves_width(
            width_a in 1u32..64,
            width_b in 1u32..64,
        ) {
            let a = Ty::Unsigned(width_a);
            let b = Ty::Unsigned(width_b);
            let result = infer_binary_op(BinOp::Add, &a, &b);

            // Addition result should be max(a,b)+1 or capped at 64
            let expected_width = std::cmp::min(std::cmp::max(width_a, width_b) + 1, 64);
            assert_eq!(result, Ty::Unsigned(expected_width));
        }
    }
}

// Snapshot testing for error messages
#[test]
fn test_duplicate_function_error() {
    let source = r#"
        fn foo() {}
        fn foo() {}
    "#;

    let diagnostics = compile_and_get_diagnostics(source);
    insta::assert_snapshot!(format_diagnostics(&diagnostics));
}
```

**Estimated Time:** 1-2 weeks (can be parallelized with other work)

---

### 4.2 Workstream 2: Incremental Infrastructure

#### 4.2.1 Salsa Integration

**Files to Create:**
- `crates/kanagawa_base/Cargo.toml` (new foundation crate)
- `crates/kanagawa_base/src/lib.rs`
- `crates/kanagawa_base/src/db.rs`
- `crates/kanagawa_base/src/file.rs`
- `crates/kanagawa_base/src/change.rs`

**Database Definition:**
```rust
// kanagawa_base/src/db.rs

use salsa::Database;

/// Root database trait - all other databases extend this
#[salsa::db]
pub trait SourceDatabase: Database {
    /// Get the text of a source file
    #[salsa::input]
    fn file_text(&self, file: FileId) -> Arc<String>;

    /// Get the source root containing a file
    #[salsa::input]
    fn file_source_root(&self, file: FileId) -> SourceRootId;

    /// Get all files in a source root
    #[salsa::input]
    fn source_root_files(&self, root: SourceRootId) -> Arc<Vec<FileId>>;
}

/// Parse database - extends source database
#[salsa::db]
pub trait ParseDatabase: SourceDatabase {
    /// Parse a file to CST
    fn parse(&self, file: FileId) -> Parse<SourceFile>;

    /// Get line index for a file
    fn line_index(&self, file: FileId) -> Arc<LineIndex>;
}

/// HIR database - extends parse database
#[salsa::db]
pub trait HirDatabase: ParseDatabase {
    /// Lower a file to HIR
    fn hir_file(&self, file: FileId) -> Arc<HirFile>;

    /// Get symbol table for a file
    fn file_symbols(&self, file: FileId) -> Arc<SymbolTable>;

    /// Get a specific definition
    fn definition(&self, def: DefId) -> Arc<Definition>;
}

/// Semantic database - extends HIR database
#[salsa::db]
pub trait SemanticDatabase: HirDatabase {
    /// Infer types for a function body
    fn infer_body(&self, func: DefId) -> Arc<InferenceResult>;

    /// Get the type of a definition
    fn type_of(&self, def: DefId) -> Ty;

    /// Resolve a path in a scope
    fn resolve_path(&self, file: FileId, path: &ast::Path) -> Option<DefId>;

    /// Get all diagnostics for a file
    fn file_diagnostics(&self, file: FileId) -> Arc<Vec<Diagnostic>>;
}
```

**Query Implementations:**
```rust
// kanagawa_syntax/src/db.rs

fn parse(db: &dyn ParseDatabase, file: FileId) -> Parse<SourceFile> {
    let text = db.file_text(file);
    let lexer = Lexer::new(&text);
    let parser = Parser::new(lexer);
    parser.parse()
}

fn line_index(db: &dyn ParseDatabase, file: FileId) -> Arc<LineIndex> {
    let text = db.file_text(file);
    Arc::new(LineIndex::new(&text))
}

// kanagawa_hir/src/db.rs

fn hir_file(db: &dyn HirDatabase, file: FileId) -> Arc<HirFile> {
    let parse = db.parse(file);
    let ast = lower_to_ast(&parse.syntax());
    Arc::new(lower_to_hir(db, &ast))
}

fn file_symbols(db: &dyn HirDatabase, file: FileId) -> Arc<SymbolTable> {
    let hir = db.hir_file(file);
    Arc::new(collect_symbols(&hir))
}
```

**Change Application:**
```rust
// kanagawa_base/src/change.rs

/// A change to apply to the database
pub struct Change {
    pub file_changes: Vec<(FileId, Option<Arc<String>>)>,
    pub root_changes: Vec<(SourceRootId, Arc<Vec<FileId>>)>,
}

impl Change {
    pub fn apply(self, db: &mut dyn SourceDatabase) {
        for (file, text) in self.file_changes {
            if let Some(text) = text {
                // Update file with low durability (changes frequently)
                db.set_file_text_with_durability(file, text, Durability::LOW);
            }
        }

        for (root, files) in self.root_changes {
            db.set_source_root_files_with_durability(root, files, Durability::HIGH);
        }
    }
}
```

**Estimated LOC:** 800-1000
**Estimated Time:** 1-2 weeks

---

### 4.3 Workstream 4: Formatter

#### 4.3.1 Pretty Printer Engine

**Files to Create:**
- `crates/kanagawa_fmt/Cargo.toml` (new crate)
- `crates/kanagawa_fmt/src/lib.rs`
- `crates/kanagawa_fmt/src/doc.rs`
- `crates/kanagawa_fmt/src/printer.rs`
- `crates/kanagawa_fmt/src/syntax.rs`
- `crates/kanagawa_fmt/src/config.rs`

**Document IR:**
```rust
// kanagawa_fmt/src/doc.rs

/// Intermediate representation for pretty printing
#[derive(Debug, Clone)]
pub enum Doc {
    /// Empty document
    Nil,
    /// Literal text
    Text(String),
    /// Line break (or space when flattened)
    Line,
    /// Hard line break (never flattened)
    HardLine,
    /// Concatenation
    Concat(Vec<Doc>),
    /// Indented block
    Nest(i32, Box<Doc>),
    /// Try to fit on one line
    Group(Box<Doc>),
    /// Alternative for flat vs broken mode
    FlatAlt {
        flat: Box<Doc>,
        broken: Box<Doc>,
    },
    /// Conditional on whether we're at start of line
    IfBreak {
        yes: Box<Doc>,
        no: Box<Doc>,
    },
}

impl Doc {
    /// Convenience constructors
    pub fn text(s: impl Into<String>) -> Self {
        Doc::Text(s.into())
    }

    pub fn concat(docs: impl IntoIterator<Item = Doc>) -> Self {
        Doc::Concat(docs.into_iter().collect())
    }

    pub fn nest(indent: i32, doc: Doc) -> Self {
        Doc::Nest(indent, Box::new(doc))
    }

    pub fn group(doc: Doc) -> Self {
        Doc::Group(Box::new(doc))
    }

    /// Join documents with separator
    pub fn join(sep: Doc, docs: impl IntoIterator<Item = Doc>) -> Self {
        let mut result = Vec::new();
        let docs: Vec<_> = docs.into_iter().collect();
        for (i, doc) in docs.into_iter().enumerate() {
            if i > 0 {
                result.push(sep.clone());
            }
            result.push(doc);
        }
        Doc::Concat(result)
    }

    /// Surround with brackets
    pub fn bracket(open: &str, doc: Doc, close: &str) -> Self {
        Doc::group(Doc::concat([
            Doc::text(open),
            Doc::nest(4, Doc::concat([Doc::Line, doc])),
            Doc::Line,
            Doc::text(close),
        ]))
    }
}
```

**Printer:**
```rust
// kanagawa_fmt/src/printer.rs

pub struct Printer {
    config: FormatConfig,
    output: String,
    position: usize,  // Current column position
    indent: i32,
}

impl Printer {
    pub fn print(&mut self, doc: &Doc) -> String {
        self.print_doc(doc, Mode::Break);
        std::mem::take(&mut self.output)
    }

    fn print_doc(&mut self, doc: &Doc, mode: Mode) {
        match doc {
            Doc::Nil => {}
            Doc::Text(s) => {
                self.output.push_str(s);
                self.position += s.len();
            }
            Doc::Line => {
                match mode {
                    Mode::Flat => {
                        self.output.push(' ');
                        self.position += 1;
                    }
                    Mode::Break => {
                        self.output.push('\n');
                        self.output.push_str(&" ".repeat(self.indent as usize));
                        self.position = self.indent as usize;
                    }
                }
            }
            Doc::HardLine => {
                self.output.push('\n');
                self.output.push_str(&" ".repeat(self.indent as usize));
                self.position = self.indent as usize;
            }
            Doc::Concat(docs) => {
                for d in docs {
                    self.print_doc(d, mode);
                }
            }
            Doc::Nest(i, inner) => {
                self.indent += i;
                self.print_doc(inner, mode);
                self.indent -= i;
            }
            Doc::Group(inner) => {
                // Try to fit on one line
                if self.fits(inner, mode) {
                    self.print_doc(inner, Mode::Flat);
                } else {
                    self.print_doc(inner, Mode::Break);
                }
            }
            Doc::FlatAlt { flat, broken } => {
                match mode {
                    Mode::Flat => self.print_doc(flat, mode),
                    Mode::Break => self.print_doc(broken, mode),
                }
            }
            Doc::IfBreak { yes, no } => {
                match mode {
                    Mode::Break => self.print_doc(yes, mode),
                    Mode::Flat => self.print_doc(no, mode),
                }
            }
        }
    }

    fn fits(&self, doc: &Doc, mode: Mode) -> bool {
        let remaining = self.config.max_line_width as i32 - self.position as i32;
        self.fits_impl(doc, remaining, mode)
    }

    fn fits_impl(&self, doc: &Doc, remaining: i32, mode: Mode) -> bool {
        if remaining < 0 {
            return false;
        }

        match doc {
            Doc::Nil => true,
            Doc::Text(s) => remaining >= s.len() as i32,
            Doc::Line => mode == Mode::Flat,
            Doc::HardLine => false,
            Doc::Concat(docs) => {
                let mut r = remaining;
                for d in docs {
                    if !self.fits_impl(d, r, mode) {
                        return false;
                    }
                    r -= self.width(d);
                }
                true
            }
            Doc::Nest(_, inner) => self.fits_impl(inner, remaining, mode),
            Doc::Group(inner) => self.fits_impl(inner, remaining, Mode::Flat),
            Doc::FlatAlt { flat, .. } => self.fits_impl(flat, remaining, mode),
            Doc::IfBreak { no, .. } => self.fits_impl(no, remaining, mode),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Flat,
    Break,
}
```

**Syntax to Doc Conversion:**
```rust
// kanagawa_fmt/src/syntax.rs

use kanagawa_syntax::{SyntaxKind, SyntaxNode, SyntaxToken};

pub fn format_node(node: &SyntaxNode, config: &FormatConfig) -> Doc {
    match node.kind() {
        SyntaxKind::SourceFile => format_source_file(node, config),
        SyntaxKind::FunctionDecl => format_function(node, config),
        SyntaxKind::StructDecl => format_struct(node, config),
        SyntaxKind::Block => format_block(node, config),
        SyntaxKind::IfStmt => format_if(node, config),
        SyntaxKind::ForStmt => format_for(node, config),
        // ... all other node kinds
        _ => format_default(node, config),
    }
}

fn format_function(node: &SyntaxNode, config: &FormatConfig) -> Doc {
    let mut parts = Vec::new();

    // Leading comments
    for trivia in node.first_token().map(|t| t.leading_trivia()).into_iter().flatten() {
        if trivia.kind() == SyntaxKind::Comment {
            parts.push(Doc::text(trivia.text()));
            parts.push(Doc::HardLine);
        }
    }

    // Attributes
    for attr in node.children().filter(|c| c.kind() == SyntaxKind::Attribute) {
        parts.push(format_attribute(&attr, config));
        parts.push(Doc::Line);
    }

    // fn keyword
    parts.push(Doc::text("fn "));

    // Name
    if let Some(name) = node.child_token(SyntaxKind::Ident) {
        parts.push(Doc::text(name.text()));
    }

    // Parameters
    if let Some(params) = node.child(SyntaxKind::ParamList) {
        parts.push(format_param_list(&params, config));
    }

    // Return type
    if let Some(ret) = node.child(SyntaxKind::ReturnType) {
        parts.push(Doc::text(" -> "));
        parts.push(format_type(&ret, config));
    }

    // Body
    if let Some(body) = node.child(SyntaxKind::Block) {
        parts.push(Doc::text(" "));
        parts.push(format_block(&body, config));
    } else {
        parts.push(Doc::text(";"));
    }

    Doc::concat(parts)
}

fn format_block(node: &SyntaxNode, config: &FormatConfig) -> Doc {
    let stmts: Vec<_> = node.children()
        .filter(|c| c.kind() != SyntaxKind::LBrace && c.kind() != SyntaxKind::RBrace)
        .map(|c| format_node(&c, config))
        .collect();

    if stmts.is_empty() {
        Doc::text("{}")
    } else {
        Doc::concat([
            Doc::text("{"),
            Doc::nest(config.indent_width as i32, Doc::concat([
                Doc::HardLine,
                Doc::join(Doc::HardLine, stmts),
            ])),
            Doc::HardLine,
            Doc::text("}"),
        ])
    }
}
```

**CLI Integration:**
```rust
// kanagawa_fmt/src/lib.rs

/// Format a source string
pub fn format(source: &str, config: &FormatConfig) -> Result<String, FormatError> {
    let parse = kanagawa_syntax::parse(source);

    // Format even with parse errors (best effort)
    let doc = format_node(&parse.syntax(), config);
    let mut printer = Printer::new(config.clone());
    Ok(printer.print(&doc))
}

/// Format a specific range within source
pub fn format_range(
    source: &str,
    range: TextRange,
    config: &FormatConfig,
) -> Result<TextEdit, FormatError> {
    let parse = kanagawa_syntax::parse(source);

    // Find node covering range
    let node = parse.syntax().covering_element(range);

    // Format that subtree
    let doc = format_node(&node.into_node().unwrap(), config);
    let mut printer = Printer::new(config.clone());
    let formatted = printer.print(&doc);

    Ok(TextEdit {
        range,
        new_text: formatted,
    })
}
```

**Estimated LOC:** 1500-2000
**Estimated Time:** 2-3 weeks

---

### 4.4 Workstream 5: Language Server

#### 4.4.1 LSP Implementation

**Files to Create:**
- `crates/kanagawa_lsp/Cargo.toml` (new crate)
- `crates/kanagawa_lsp/src/lib.rs`
- `crates/kanagawa_lsp/src/server.rs`
- `crates/kanagawa_lsp/src/handlers.rs`
- `crates/kanagawa_lsp/src/diagnostics.rs`
- `crates/kanagawa_lsp/src/navigation.rs`
- `crates/kanagawa_lsp/src/completion.rs`
- `crates/kanagawa_lsp/src/hover.rs`

**Server Structure:**
```rust
// kanagawa_lsp/src/server.rs

use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer};

pub struct KanagawaLanguageServer {
    client: Client,
    db: parking_lot::RwLock<Database>,
}

impl KanagawaLanguageServer {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            db: parking_lot::RwLock::new(Database::default()),
        }
    }

    async fn on_change(&self, uri: Url, text: String, version: i32) {
        // Update database
        {
            let mut db = self.db.write();
            let file_id = db.file_id_for_uri(&uri);
            db.set_file_text(file_id, Arc::new(text));
        }

        // Compute and publish diagnostics
        let diagnostics = {
            let db = self.db.read();
            let file_id = db.file_id_for_uri(&uri);
            db.file_diagnostics(file_id)
        };

        let lsp_diagnostics: Vec<_> = diagnostics
            .iter()
            .map(|d| self.to_lsp_diagnostic(d))
            .collect();

        self.client
            .publish_diagnostics(uri, lsp_diagnostics, Some(version))
            .await;
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for KanagawaLanguageServer {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        // Set up workspace
        if let Some(root) = params.root_uri {
            let mut db = self.db.write();
            db.set_workspace_root(root);
        }

        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![".".to_string(), ":".to_string()]),
                    ..Default::default()
                }),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                document_formatting_provider: Some(OneOf::Left(true)),
                rename_provider: Some(OneOf::Left(true)),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        self.on_change(
            params.text_document.uri,
            params.text_document.text,
            params.text_document.version,
        ).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        // We use full sync, so take the whole content
        if let Some(change) = params.content_changes.into_iter().next() {
            self.on_change(
                params.text_document.uri,
                change.text,
                params.text_document.version,
            ).await;
        }
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let db = self.db.read();
        let position = params.text_document_position_params;

        let file_id = db.file_id_for_uri(&position.text_document.uri);
        let offset = db.offset_for_position(file_id, position.position);

        // Find symbol at position
        let symbol = db.symbol_at(file_id, offset);

        Ok(symbol.map(|sym| {
            Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: format!(
                        "```kanagawa\n{}\n```\n\n{}",
                        db.symbol_signature(&sym),
                        db.symbol_docs(&sym).unwrap_or_default(),
                    ),
                }),
                range: None,
            }
        }))
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let db = self.db.read();
        let position = params.text_document_position_params;

        let file_id = db.file_id_for_uri(&position.text_document.uri);
        let offset = db.offset_for_position(file_id, position.position);

        // Find definition
        let def = db.definition_at(file_id, offset)?;

        Ok(def.map(|d| {
            let location = db.def_location(d);
            GotoDefinitionResponse::Scalar(location)
        }))
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let db = self.db.read();
        let position = params.text_document_position;

        let file_id = db.file_id_for_uri(&position.text_document.uri);
        let offset = db.offset_for_position(file_id, position.position);

        let def = db.definition_at(file_id, offset)?;

        Ok(def.map(|d| {
            db.find_references(d)
                .into_iter()
                .map(|r| db.ref_location(r))
                .collect()
        }))
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let db = self.db.read();
        let position = params.text_document_position;

        let file_id = db.file_id_for_uri(&position.text_document.uri);
        let offset = db.offset_for_position(file_id, position.position);

        // Get completions based on context
        let completions = db.completions_at(file_id, offset);

        let items: Vec<_> = completions
            .into_iter()
            .map(|c| CompletionItem {
                label: c.label,
                kind: Some(c.kind),
                detail: c.detail,
                documentation: c.docs.map(|d| {
                    Documentation::MarkupContent(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: d,
                    })
                }),
                insert_text: c.insert_text,
                ..Default::default()
            })
            .collect();

        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn formatting(
        &self,
        params: DocumentFormattingParams,
    ) -> Result<Option<Vec<TextEdit>>> {
        let db = self.db.read();
        let file_id = db.file_id_for_uri(&params.text_document.uri);
        let text = db.file_text(file_id);

        // Format the entire file
        let config = FormatConfig::from_options(&params.options);
        let formatted = kanagawa_fmt::format(&text, &config)
            .map_err(|e| tower_lsp::jsonrpc::Error::internal_error())?;

        // Return single edit replacing entire file
        let line_count = text.lines().count() as u32;
        Ok(Some(vec![TextEdit {
            range: Range {
                start: Position { line: 0, character: 0 },
                end: Position { line: line_count, character: 0 },
            },
            new_text: formatted,
        }]))
    }
}
```

**Main Entry Point:**
```rust
// kanagawa_lsp/src/main.rs

use tower_lsp::{LspService, Server};

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(|client| {
        KanagawaLanguageServer::new(client)
    });

    Server::new(stdin, stdout, socket).serve(service).await;
}
```

**Estimated LOC:** 2000-3000
**Estimated Time:** 3-4 weeks

---

## 5. Implementation Phases

### Phase 1: Foundation (Weeks 1-4)

**Objective:** Establish incremental infrastructure and fix critical gaps

| Week | Tasks | Deliverables |
|------|-------|--------------|
| 1 | Salsa integration, SourceDatabase | `kanagawa_base` crate compiling |
| 2 | Constant expression evaluation | `consteval.rs` with tests |
| 3 | Test coverage for resolve/sema | 100+ new tests passing |
| 4 | ParseDatabase, HirDatabase queries | Full query hierarchy |

**Exit Criteria:**
- [ ] All Salsa databases defined and wired
- [ ] Constexpr evaluates `1 + 2 * 3` correctly
- [ ] Test coverage >80% for resolve and sema
- [ ] Existing 467 test files still pass

### Phase 2: Core Features (Weeks 5-10)

**Objective:** Complete template instantiation and code generation

| Week | Tasks | Deliverables |
|------|-------|--------------|
| 5-6 | Template substitution | Basic template instantiation |
| 7-8 | Template argument deduction | Full template support |
| 9-10 | Code generation (ParseTree) | `kanagawa_codegen` crate |

**Exit Criteria:**
- [ ] Generic `template<T> fn identity(x: T) -> T` compiles
- [ ] Recursive templates with depth limit work
- [ ] Code generation produces valid ParseTree
- [ ] End-to-end compilation of simple programs

### Phase 3: Tooling (Weeks 11-16)

**Objective:** Ship formatter and basic LSP

| Week | Tasks | Deliverables |
|------|-------|--------------|
| 11-12 | Formatter engine | `kanagawa_fmt` crate |
| 13 | Formatter CLI + tests | `kanagawa fmt` command |
| 14-15 | LSP basics | Diagnostics, hover, goto def |
| 16 | LSP completion | Basic completion working |

**Exit Criteria:**
- [ ] Formatter produces idempotent output
- [ ] Format preserves all comments
- [ ] LSP publishes diagnostics on change
- [ ] Go to definition works for all symbols
- [ ] Basic completion for visible symbols

### Phase 4: Polish (Weeks 17-20)

**Objective:** Production-ready quality

| Week | Tasks | Deliverables |
|------|-------|--------------|
| 17 | Error suggestions | "Did you mean?" working |
| 18 | Rich diagnostics | codespan-reporting integration |
| 19 | Benchmarks | Performance comparison vs Haskell |
| 20 | Documentation generator | `kanagawa doc` command |

**Exit Criteria:**
- [ ] Error messages match rustc quality
- [ ] 2x faster than Haskell frontend (or explanation why not)
- [ ] Documentation generator produces HTML
- [ ] All 467 test files compile end-to-end

---

## 6. Integration Points

### 6.1 Crate Dependency Graph (Post-Phase 2)

```
kanagawa_driver
    ├── kanagawa_lsp
    │   ├── kanagawa_fmt
    │   │   └── kanagawa_syntax
    │   ├── kanagawa_base (salsa)
    │   └── tower-lsp
    ├── kanagawa_codegen
    │   ├── kanagawa_hir
    │   └── kanagawa_parsetree
    ├── kanagawa_sema
    ├── kanagawa_resolve
    ├── kanagawa_typeck
    └── kanagawa_hir
        ├── kanagawa_ast
        │   └── kanagawa_syntax
        └── kanagawa_base
```

### 6.2 Database Query Flow

```
User edits file
       │
       ▼
┌─────────────────┐
│ did_change()    │
│ LSP handler     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ set_file_text() │
│ Salsa input     │
└────────┬────────┘
         │
         ▼ (invalidates downstream)
┌─────────────────┐
│ parse()         │◄─── Re-lexes and parses
└────────┬────────┘
         │
         ▼ (only if parse changed)
┌─────────────────┐
│ hir_file()      │◄─── Re-lowers AST→HIR
└────────┬────────┘
         │
         ▼ (only if HIR changed)
┌─────────────────┐
│ infer_body()    │◄─── Re-type-checks affected functions
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ diagnostics()   │◄─── Collects from all phases
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ publish_diags() │
│ LSP response    │
└─────────────────┘
```

### 6.3 Formatter Integration

```
Editor requests format
       │
       ▼
┌─────────────────┐
│ formatting()    │
│ LSP handler     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ kanagawa_fmt::  │
│ format()        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CST from parse()│◄─── Reuses cached parse
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ syntax_to_doc() │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ printer.print() │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ TextEdit        │
│ returned        │
└─────────────────┘
```

---

## 7. Risk Assessment & Mitigation

### High Risk

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Template instantiation complexity | Blocks generic code | High | Start with simple cases, add complexity incrementally |
| ParseTree format mismatch | Backend rejects output | Medium | Test against Haskell output, add integration tests |
| Salsa learning curve | Delays schedule | Medium | Spike early, document patterns |
| Performance regression | Fails goal | Low | Benchmark continuously, profile before optimizing |

### Medium Risk

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| LSP protocol edge cases | IDE bugs | Medium | Use tower-lsp (handles most cases) |
| Formatter comment handling | Lost comments | Medium | Extensive testing with real code |
| Incremental invalidation bugs | Stale results | Medium | Salsa handles this, trust the framework |

### Low Risk

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Documentation generator scope creep | Delays | Low | MVP first, iterate |
| CI/CD setup | Developer friction | Low | GitHub Actions template exists |

---

## 8. Success Criteria

### Milestone 1: Core Complete (End of Phase 2)
- [ ] `cargo test` passes 500+ tests
- [ ] 467 test files compile to ParseTree
- [ ] Template instantiation works for standard library
- [ ] No panics on any valid input

### Milestone 2: Tooling Usable (End of Phase 3)
- [ ] VS Code extension published (internal)
- [ ] `kanagawa fmt` formats all test files idempotently
- [ ] LSP diagnostics appear within 100ms of edit
- [ ] Go to definition works 95%+ of the time

### Milestone 3: Production Ready (End of Phase 4)
- [ ] Error messages include suggestions
- [ ] Benchmark shows 2x improvement (or documented reason)
- [ ] Documentation generated for standard library
- [ ] Zero known P0 bugs

---

## 9. Appendices

### A. Crate Checklist

| Crate | Status | Tests | Docs | Notes |
|-------|--------|-------|------|-------|
| kanagawa_parsetree_sys | Complete | N/A | No | FFI bindings |
| kanagawa_parsetree | Complete | No | Partial | Safe wrapper |
| kanagawa_syntax | Complete | 34 | Yes | Parser |
| kanagawa_ast | Complete | 12 | Yes | AST lowering |
| kanagawa_hir | Partial | 28 | Yes | Needs consteval, templates |
| kanagawa_typeck | Partial | 1 | Partial | Needs inference completion |
| kanagawa_resolve | Partial | 0 | Yes | Needs tests |
| kanagawa_sema | Partial | 0 | Yes | Needs tests |
| kanagawa_driver | Stub | No | No | Needs full pipeline |
| kanagawa_base | New | - | - | Salsa integration |
| kanagawa_codegen | New | - | - | ParseTree emission |
| kanagawa_fmt | New | - | - | Formatter |
| kanagawa_lsp | New | - | - | Language server |
| kanagawa_doc | New | - | - | Documentation generator |

### B. External Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| salsa | 0.24+ | Incremental computation |
| tower-lsp | latest | LSP protocol |
| tokio | 1.x | Async runtime for LSP |
| logos | 0.15 | Lexer generation |
| rowan | 0.16 | Lossless syntax trees |
| ariadne | 0.4+ | Rich diagnostic rendering |
| rayon | 1.x | Parallel iteration |
| parking_lot | 0.12 | Fast locks |
| indicatif | 0.17 | Progress bars for CLI |
| criterion | 0.5 | Benchmarking (dev) |
| insta | 1.x | Snapshot testing (dev) |
| proptest | 1.x | Property-based testing (dev) |

### C. File Structure (Post-Plan)

```
compiler/rs/
├── Cargo.toml (workspace)
├── crates/
│   ├── kanagawa_base/          # Salsa databases, file management
│   ├── kanagawa_syntax/        # Lexer, parser, CST
│   ├── kanagawa_ast/           # AST types, CST→AST lowering
│   ├── kanagawa_hir/           # HIR, symbols, types, consteval, templates
│   ├── kanagawa_typeck/        # Type checking, inference
│   ├── kanagawa_resolve/       # Module resolution
│   ├── kanagawa_sema/          # Semantic validation
│   ├── kanagawa_codegen/       # HIR→ParseTree
│   ├── kanagawa_fmt/           # Formatter
│   ├── kanagawa_lsp/           # Language server
│   ├── kanagawa_doc/           # Documentation generator
│   ├── kanagawa_parsetree/     # C++ backend FFI wrapper
│   ├── kanagawa_parsetree_sys/ # Raw C bindings
│   └── kanagawa_driver/        # CLI entry point
├── audit.md
├── phase2_plan.md
└── README.md
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-12-15 | Claude | Initial comprehensive plan |
| 1.1 | 2025-12-15 | Claude | Added Decisions 9-11 (template perf, threading, type inference), switched to ariadne, added implementation roadmap |

---

## 10. Implementation Roadmap: What to Build Next

This section provides a concrete, prioritized action plan for implementation.

### Immediate Priority: End-to-End Compilation

**Goal:** Get the Rust frontend compiling simple programs to ParseTree before adding advanced features.

**Rationale:** This validates the architecture and provides a working baseline. Templates and incremental computation can be added incrementally.

### Sprint 1: Code Generation Foundation (1-2 weeks)

**Objective:** Emit ParseTree from HIR for non-templated code.

**Tasks:**
1. **Create `kanagawa_codegen` crate**
   ```
   crates/kanagawa_codegen/
   ├── Cargo.toml
   └── src/
       ├── lib.rs       # Public API
       ├── emit.rs      # Main emission logic
       ├── expr.rs      # Expression emission
       ├── stmt.rs      # Statement emission
       ├── ty.rs        # Type emission
       └── decl.rs      # Declaration emission
   ```

2. **Implement basic emission** for:
   - Functions (with parameters and return types)
   - Structs
   - Variables
   - Basic expressions (literals, binops, calls, indexing)
   - Basic statements (if, while, for, return, assignment)

3. **Wire into driver**
   - Parse → AST → HIR → CodeGen → ParseTree → Backend

4. **Validation:** Compile `test/hello.k` end-to-end

**Definition of Done:**
- [ ] `kanagawa compile test/hello.k` produces executable
- [ ] 10+ simple test files compile successfully
- [ ] No panics on valid input

### Sprint 2: Core Type System Completion (1-2 weeks)

**Objective:** Ensure type checking and inference work correctly for non-templated code.

**Tasks:**
1. **Enhance `kanagawa_typeck`**
   - Implement bidirectional type checking
   - Add union-find unification
   - Handle all expression types

2. **Add comprehensive tests**
   - Positive tests: valid code type checks
   - Negative tests: invalid code produces correct errors
   - Edge cases: numeric promotion, array coercion

3. **Integrate with code generation**
   - Type information flows to codegen
   - Width-aware integer operations

**Definition of Done:**
- [ ] 50+ type checking tests passing
- [ ] All basic operators type check correctly
- [ ] Function calls type check with correct argument/return types

### Sprint 3: Constant Expression Evaluation (1 week)

**Objective:** Evaluate compile-time constants for array dimensions and template values.

**Tasks:**
1. **Create `kanagawa_hir/src/consteval.rs`**
   - Integer arithmetic
   - Boolean logic
   - Comparison operators
   - Ternary expressions

2. **Integrate with HIR lowering**
   - Array dimension evaluation
   - Constant propagation

3. **Error handling**
   - Division by zero
   - Overflow detection
   - Non-constant in constant context

**Definition of Done:**
- [ ] `const N = 10 * 10;` evaluates to 100
- [ ] `let arr: i32[N];` works correctly
- [ ] `const X = 1/0;` produces compile error

### Sprint 4: Template Instantiation (2-3 weeks)

**Objective:** Support generic templates with type parameters.

**Tasks:**
1. **Template argument deduction**
   - Match call-site types against template parameters
   - Handle explicit template arguments

2. **Template substitution**
   - Efficient structural sharing
   - Canonical argument forms for caching

3. **Template instantiation**
   - On-demand instantiation
   - Depth limiting with trace
   - Error reporting for failed instantiations

4. **Integration**
   - Wire templates through type checking
   - Wire templates through code generation

**Definition of Done:**
- [ ] `template<T> fn identity(x: T) -> T { x }` works
- [ ] Template argument deduction works for simple cases
- [ ] Recursive templates hit depth limit with good error message
- [ ] Cache hits prevent re-instantiation

### Sprint 5: Salsa Integration (2 weeks)

**Objective:** Add incremental computation for LSP.

**Tasks:**
1. **Create `kanagawa_base` crate**
   - FileId, SourceRootId types
   - Salsa database traits

2. **Define query hierarchy**
   - SourceDatabase (inputs)
   - ParseDatabase (derived)
   - HirDatabase (derived)
   - SemanticDatabase (derived)

3. **Migrate existing crates**
   - Wrap existing functions as Salsa queries
   - Add proper caching boundaries

4. **Change application**
   - File change tracking
   - Durability configuration

**Definition of Done:**
- [ ] Editing file only re-parses that file
- [ ] Type errors update incrementally
- [ ] Second compilation with no changes is instant

### Sprint 6: Formatter (2 weeks)

**Objective:** Format Kanagawa source code.

**Tasks:**
1. **Create `kanagawa_fmt` crate**
   - Wadler-Lindig pretty printer
   - CST to Doc conversion
   - Comment preservation

2. **Configuration**
   - Indent width
   - Line width
   - Brace style

3. **CLI integration**
   - `kanagawa fmt <files>`
   - `--check` mode for CI

**Definition of Done:**
- [ ] Formatting is idempotent
- [ ] All comments preserved
- [ ] Configuration works

### Sprint 7: LSP MVP (2-3 weeks)

**Objective:** Basic language server with diagnostics, go-to-definition, hover for VS Code.

**Note:** VS Code is the exclusive IDE target (team uses VS Code).

**Tasks:**
1. **Create `kanagawa_lsp` crate**
   - tower-lsp integration
   - Document synchronization

2. **Create VS Code extension**
   - Extension scaffold (TypeScript)
   - Language configuration (syntax highlighting via TextMate grammar)
   - LSP client integration

3. **Diagnostics**
   - Publish on file change
   - Syntax errors
   - Type errors
   - Semantic errors

4. **Navigation**
   - Go to definition
   - Find references

5. **Information**
   - Hover (type info, docs)

**Definition of Done:**
- [ ] VS Code extension installable from `.vsix`
- [ ] Syntax highlighting works
- [ ] Errors appear as squiggles on save
- [ ] Go to definition works (F12 / Ctrl+Click)
- [ ] Hover shows type information

### Sprint 8: Quality Polish (Ongoing)

**Objective:** Improve error messages and performance.

**Tasks:**
1. **Error suggestions**
   - "Did you mean?" for typos
   - Suggestions for common mistakes

2. **ariadne integration**
   - Rich error formatting
   - Multi-span errors

3. **Benchmarking**
   - criterion benchmarks
   - Comparison vs Haskell frontend

4. **Performance optimization**
   - Profile hot paths
   - Optimize based on data

---

### Quick Start: First Week Actions

If you want to start implementing immediately, here's day-by-day guidance:

**Day 1-2: Set up kanagawa_codegen**
```bash
cd compiler/rs
mkdir -p crates/kanagawa_codegen/src
# Create Cargo.toml and initial lib.rs
# Implement skeleton emit functions
```

**Day 3-4: Implement expression emission**
- Literals (int, bool, string, char)
- Binary operations
- Unary operations
- Identifiers
- Function calls

**Day 5: Implement statement emission**
- Return statements
- Variable declarations
- Assignment
- If statements
- While loops

**Day 6-7: Integration and testing**
- Wire codegen into driver
- Test with simple programs
- Fix issues found

---

### Resolved Design Questions

These questions have been discussed and resolved:

1. **Error Recovery Strategy** → **Decision 12**
   - Aggressive recovery at every phase (lexer, parser, type checker)
   - Partial results always available for LSP
   - `Ty::Error` poison type prevents cascading errors

2. **Migration Path** → **Deferred**
   - Both frontends coexist as separate executables during transition
   - Comparison testing to be investigated later

3. **Build System Integration** → **Deferred**
   - Dynamic library will be provided for linking
   - Full integration deferred

4. **Standard Library** → **Resolved**
   - Passed via CLI flag (`--stdlib <PATH>`)
   - Distributed as `*.k` files alongside compiler
   - Searched last in import resolution

5. **Multi-file Compilation** → **Decision 13**
   - Single-file entry point
   - Recursive import resolution via include directories (`-I`)
   - No manifest file; imports resolve relative to file, then include dirs, then stdlib
   - Cycle detection built-in

6. **IDE Support Priority** → **Resolved**
   - **VS Code is the exclusive target** (team uses VS Code)
   - Other editors (vim, helix, etc.) get LSP support for free

---

*End of Phase 2 Plan*
