Here’s a “handoff prompt” you can paste to a fresh coding agent. It’s written to be self-sufficient: it points them to the repo’s navigation docs, sets constraints, and gives concrete first actions + success criteria.

---

You are a coding agent working in the Kanagawa repo at kanagawa on macOS.

Goal

- Continue the Rust frontend rewrite. The C++ backend stays unchanged.
- The integration seam is the ParseTree C ABI in parse_tree.h.
- The Rust frontend currently focuses on a lossless lexer + recovery-first CST (rowan), plus unit tests and a syntax harness.

Hard constraints

- Preserve token/trivia losslessly; prefer “structure without diagnostics” over strict validation.
- Do not break `cargo test -p kanagawa_syntax`.
- Keep performance stable; avoid parser approaches that make syntax harness tests hang/slow dramatically.
- After finishing any meaningful chunk, append a note to progress.md.
- Don’t do unrelated refactors; keep changes surgical.

Repo navigation (read these first)

- AGENTS.md (repo architecture + “where to start” map)
- AGENTS.md (Rust-side rules)
- grammar.md and grammar-status.md at repo root (canonical syntax + current Rust coverage)
- Rust CST crate:
  - parse.rs
  - syntax.rs
  - tests in tests

Current state (important)

- Rust has a recovery-first lexer/parser and builds a structured CST for many constructs:
  - Structured types: `Type*` nodes (const/typename/decltype, array dims, function types, template args, etc.)
  - Structured expressions: Pratt parser producing `UnaryExpr`, `BinaryExpr`, `AssignExpr`, `TernaryExpr`, `CallExpr`, `MemberExpr`, `SubscriptExpr`, literals, identifiers.
  - Structured strings (including interpolation) and initializer lists.
  - Structured statements for key headers (`if/switch/do-while/for/static for/unrolled_for`) using `ParenExpr` containing `Expr` and sometimes `Type`.
- `decltype(...)` type now contains a structured `ParenExpr` and nested `Expr`.
- `using Name = Type;` now parses RHS as a structured `Type` subtree (enables `[[memory]] T[N]` in type position).
- Syntax harness:
  - parse_syntax_harness.rs parses many `test/syntax/*.k` `expected:0` blocks in a curated smoke set.
  - There is also an ignored exhaustive test to parse the entire syntax harness corpus (`cargo test ... -- --ignored`).

What “done” means for your next chunk

- Add value toward getting from CST → typed AST → ParseTree emission (via C ABI) while keeping the CST/harness green.
- For any new language surface you touch: add at least one targeted unit test asserting CST shape (node kinds and nesting), plus keep harness parsing diagnostic-free for `expected:0` blocks.

First actions (do these in order)

1. Run tests to establish baseline:
   - `cd compiler/rs && cargo test -p kanagawa_syntax`
2. Skim grammar-status.md and reconcile with reality:
   - Find any remaining “Partial/Missing” rows; confirm whether they’re truly missing or just outdated docs.
3. Identify the next highest-leverage milestone:
   Option A (recommended): Start a minimal AST layer + CST→AST lowering for a small subset (e.g., module/import + top-level decl list + function signatures + simple blocks).
   Option B: Start ParseTree emission for the same subset using `kanagawa_parsetree_sys` / `kanagawa_parsetree`.
   Option C: Expand CST structure only if needed by A/B (don’t gold-plate CST further).
4. Implement the smallest vertical slice end-to-end:
   - Parse CST (already exists)
   - Lower CST → AST (new)
   - Emit ParseTree nodes for that AST subset (new)
   - Add tests: unit tests for AST lowering + (if feasible) a smoke test that builds ParseTree without crashing.

Where ParseTree/backend integration lives

- ParseTree ABI contract: parse_tree.h
- Backend entrypoints: kanagawa.cpp (not to be changed unless absolutely necessary)
- Rust bindings/crates (already scaffolded): under rs (look for `kanagawa_parsetree_sys`, `kanagawa_parsetree`, and the driver binary).

Testing requirements

- Keep `cargo test -p kanagawa_syntax` green.
- If you add ParseTree emission, add focused tests in Rust for construction correctness (at least “doesn’t crash” + basic invariants).

Progress reporting

- After each milestone-sized change, append a short entry to progress.md:
  - what changed
  - files touched
  - tests run + results
  - any new known gaps / next steps

Deliverable for your first PR-sized chunk

- A minimal CST→AST representation + lowering for one coherent slice (module/import + one decl kind), OR ParseTree emission for that slice, with tests and progress notes.

If you’re unsure what to do next

- Prefer building the vertical slice toward ParseTree emission over adding more CST nodes. The point of CST completeness is to unblock AST and backend integration.
