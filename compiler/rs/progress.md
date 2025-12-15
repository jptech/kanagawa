# Rust frontend progress journal

This file is a running log of work done under `compiler/rs/` so that development can resume quickly with full context.

---

## 2025-12-14

### Status

- Created `compiler/rs` Cargo workspace and initial crates.
- Implemented `kanagawa_parsetree_sys` (bindgen over `compiler/cpp/parse_tree.h`).
- Added minimal wrapper crate `kanagawa_parsetree` (CString arena + a few helpers).
- Added `kanagawa_driver` binary (`kanagawa-rs`) that prints a scaffold version string.

Next up:

- `cargo check` now succeeds for the Rust workspace.
- Decide how to link against the built backend shared library for `InitCompiler`/`Codegen` calls.

New next steps:

- Implement more complete `Options` defaults (parity with Haskell) beyond the minimum required to satisfy backend validation.
- Build the backend shared library and run `kanagawa-rs --backend-lib ... <file.k>` as an end-to-end smoke test.

### Notes / decisions captured

- We keep the C++ backend unchanged; Rust frontend will emit ParseTree via the existing C ABI.
- Initial focus is Milestone 0: build wiring + basic crates.
- Bindgen is configured to allowlist ParseTree constructors + key types and constants; expand allowlist if compilation needs additional ABI symbols.
- Expectation: bindgen requires libclang; if unavailable, we can commit pre-generated bindings as a stopgap (but prefer generating).

### Issues encountered

- `cargo check` initially failed because `kanagawa_parsetree_sys/build.rs` used the wrong relative header path (`../../../../cpp/...`). Fixed to `../../../../compiler/cpp/...`.
- `cargo check` then failed because `compiler/cpp/options.h` uses `size_t` without an include that defines it under bindgen. Mitigation: make bindgen force-include `stddef.h` via clang args in `kanagawa_parsetree_sys/build.rs` (no backend changes).

### Open items

- Decide whether to wire Rust build into top-level CMake immediately or keep it standalone until the Rust driver can successfully call `InitCompiler`.
- Confirm `parse_tree.h` include dependencies are bindgen-friendly on macOS.
- Add `kanagawa_parsetree` safe wrappers for `Options` filling and for location scoping (RAII guard).

### Completed

- Workspace builds: `cargo check` passes.

### 2025-12-14 (later)

#### Implemented

- Added `kanagawa_parsetree::BackendOptions` that constructs `sys::Options` with enough defaults for `InitCompiler` to pass backend checks in `SetupCodeGenConfig` (notably: `_logicRegisterRatio`, `_resetCycles`, `_resetFanOutCycles`, `_maxSelectInputs`, `_maxThreadsDefault`, `_maxThreadsLimit`, clock gating disabled).
- Updated `kanagawa-rs` driver to dynamically load the backend library (via `KANAGAWA_BACKEND_LIB` or `--backend-lib`) and call `InitCompiler` as a smoke test.

#### Notes

- Backend `InitCompiler` fails early unless at least one input file is provided in `_fileNames`.
- We are using dynamic loading temporarily because this repo does not currently contain built backend artifacts under a predictable path.

#### Docs

- Added `compiler/rs/README.md` with instructions for building/finding the backend shared library and running the Rust `InitCompiler` smoke test.

#### Smoke test

- Verified `InitCompiler` succeeds when loading `kanagawa-build/dist/bin/libkanagawa-backend.dylib` and passing `test/syntax/basics.k`.

#### Codegen wiring

- Added a `--smoke-codegen` path that loads `Codegen` + `ParseBaseList` from the backend dylib and calls `Codegen` with an empty root.
- Expected current result: backend fails in device config extraction with: "Device definition schema types are missing".

---

## 2025-12-14 (parser pipeline start)

### Implemented

- Added `compiler/rs/crates/kanagawa_syntax`:
	- `logos` lexer: `lex(text) -> (Vec<LexedToken>, Vec<Diagnostic>)`.
	- Minimal CST builder using `rowan`: `parse_file(text) -> Parse`.
	- Seed `SyntaxKind` for trivia/comments, identifiers, basic literals, punctuation/operators, and a starter keyword set.
- Added driver modes:
	- `--lex <file>` runs the Rust lexer and prints token/diagnostic counts.
	- `--parse <file>` builds a green tree and prints diagnostic counts.

### Current gaps (expected)

- Lexer is intentionally incomplete; running on `test/syntax/basics.k` currently reports unknown characters for operators we have not added yet (e.g. bitwise ops like `& | ^ ~`, plus additional punctuation).
- CST builder is currently a “lossless wrapper” over the token stream (File node containing tokens + ErrorNode wrappers). Grammar productions come next.

### Status

Next up: expand token coverage (operators/keywords) to match `grammar.md`, then implement the first real grammar production (module/import + declaration list) on top of the CST.
