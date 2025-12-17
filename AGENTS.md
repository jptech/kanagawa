# Kanagawa agent cheat sheet (LLM navigation)

This is a **small, high-signal** guide for quickly navigating the Kanagawa repo as an automated agent.
For the full architecture write-up, see `about_repo.md`.

## 0) What you’re looking at

Kanagawa compiles `.k` (or `.pd`) source to **SystemVerilog**.
The repo is split into:

- **Front-end (Haskell):** parse + desugar + type inference/checks, then build a C++-owned ParseTree through FFI.
- **Back-end (C++):** ParseTree semantics + type checking + lowering to internal IR + scheduling/placement + CIRCT/MLIR → SystemVerilog.
- **Library (`library/`)**: standard library in Kanagawa.
- **Runtime RTL (`runtime/rtl/`)**: SystemVerilog building blocks instantiated by generated designs.

## 1) Fast “where do I start?”

If you need end-to-end compilation tracing, read in this order:

1. Haskell driver: `compiler/hs/app/Main.hs`
2. Frontend pipeline composition: `compiler/hs/lib/Language/Kanagawa/Frontend.hs`
3. ParseTree construction (AST → ParseTree): `compiler/hs/app/ParseTree.hs`
4. FFI declarations (what Haskell can call): `compiler/hs/app/ParseTree/FFI.hs`
5. ParseTree contract (C ABI): `compiler/cpp/parse_tree.h`
6. Backend driver exported as C API: `compiler/cpp/kanagawa.cpp`
7. Backend orchestrator/state: `compiler/cpp/compiler.h` / `compiler/cpp/compiler.cpp`
8. Internal IR model: `compiler/cpp/ir.h` / `compiler/cpp/ir.cpp`
9. SV backend: `compiler/cpp/verilog.h` / `compiler/cpp/verilog.cpp`

If you’re mapping language constructs to hardware, keep these open too:

- `doc/mapping-to-hardware.md`
- `doc/programming-guide.md`

## 2) The compilation pipeline (checkpoints)

A practical “checkpoint map” for debugging:

### Front-end (Haskell)

- **Parse + module/import resolution**: `Language.Kanagawa.Parser.*`
- **Frontend passes** (validation/desugar/template instantiation/type inference): `Language.Kanagawa.Frontend`
- **If it fails here**: you’ll usually see a structured error with source spans; fix the program or the frontend rule.

### Boundary (Haskell → C++)

- The Haskell side builds a ParseTree by calling C constructors declared in `compiler/cpp/parse_tree.h`.
- Source locations are pushed into C++ nodes (look for `SetLocation*` usage in `compiler/hs/app/ParseTree.hs`).

### Back-end (C++)

The exported entrypoint is `Codegen(...)` in `compiler/cpp/kanagawa.cpp`. The high-level flow:

- `compiler.SetRoot(root, ...)`
- Whole-program steps: type checks, declaration reorder, device config extraction, etc.
- Per compiled module: reset per-module state, enumerate function instances, generate internal IR, then emit SV via CIRCT.

If you need to find “what happens next”, start at `Codegen(...)` and follow the calls on `compiler`.

## 3) Invariants / contracts (things agents should not violate)

These are “don’t break the world” rules when editing:

### ParseTree is the cross-language ABI

- The **C ABI** in `compiler/cpp/parse_tree.h` is the contract.
- If you add/rename:
  - constructors,
  - enums,
  - option fields,
  - node attribute setters,
    you must update **both** sides (C++ implementation + Haskell FFI bindings and any mirrored enums).

### Source locations matter

- Backend error reporting and debug outputs depend on locations being set correctly.
- If you add new node kinds in the Haskell ParseTree builder, make sure locations are propagated.

### Backend owns ParseTree node lifetimes

- Haskell should treat ParseTree pointers as opaque handles.
- The backend intentionally separates “permanent” vs “temporary” node storage (cleared per compiled module).

### Function-instance enumeration affects naming + correctness

- Inline functions, methods, and call sites can produce multiple instances.
- If you change instance identity rules, you can break:
  - scheduling assumptions,
  - static local renaming,
  - generated symbol stability.

## 4) Common failure modes (and where to look)

### A) Haskell compile fails (Cabal / GHC)

- Start with: `compiler/kanagawa.cabal`
- FFI/type mismatches usually show up in: `compiler/hs/app/ParseTree/FFI.hs` or `compiler/hs/app/Options/FFI.hsc`

### B) Haskell runs, but crashes during codegen

Typical causes:

- Missing ParseTree fields (null-ish nodes) due to an unhandled AST case in `compiler/hs/app/ParseTree.hs`.
- Inconsistent node typing between Haskell and C++.

Debug path:

- Find the ParseTree constructor being called in Haskell.
- Locate the corresponding implementation/visitor logic in `compiler/cpp/parse_tree.cpp`.
- Add/confirm location/type setting so backend diagnostics point at the right place.

### C) Backend asserts / type-check errors

- The giant “truth” for ParseTree semantics is `compiler/cpp/parse_tree.cpp`.
- If errors mention types/shapes/widths, also inspect `compiler/cpp/ir.cpp` and `compiler/cpp/lower.cpp`.

### D) SV output wrong or CIRCT errors

- CIRCT lowering/emission is in `compiler/cpp/verilog.cpp`.
- Dialect loading / helpers: `compiler/cpp/circt_util.*`.

If you see “dialect/op not registered” style issues:

- Check dialect loading in compiler init (MLIR context setup).
- Verify CIRCT submodule/build wiring under `thirdparty/` and CMake.

### E) Tests fail only with Verilator

- Some test suites are gated on Verilator availability (see `test/` + `BUILDING.md`).
- Narrow down by running a specific CTest regex (e.g. `ctest -R '^runtime\\.'`).

## 5) High-signal repo searches (fast navigation)

When you don’t know where a behavior is implemented:

- Search for the exported C API function names: `InitCompiler`, `Codegen`
- Search for “phase boundaries”: `TypeCheck`, `GenerateIR`, `CompileVerilog`, `EnumerateFunctionInstances`
- Search for the ParseTree constructor name used by Haskell (e.g., `ParseBinaryOp`) in `compiler/cpp/parse_tree.*`

## 6) Minimal build/test commands (from repo root)

Exact flags vary by platform; see `BUILDING.md` for authoritative guidance. Typical patterns:

- Configure + build (Ninja):
  - `cmake -S . -B build -G Ninja`
  - `cmake --build build -j 10`
- Run tests:
  - `ctest --test-dir build -j <N>`
  - `ctest --test-dir build -R '^syntax\\.'`

## 7) When you change language features (edit checklist)

If you add/change a language feature, the smallest complete “touch set” is usually:

- Haskell parser/AST and frontend passes (`compiler/hs/lib/Language/Kanagawa/*`)
- Haskell ParseTree builder (`compiler/hs/app/ParseTree.hs`)
- C ABI additions (`compiler/cpp/parse_tree.h`)
- C++ semantics/typechecking/lowering (`compiler/cpp/parse_tree.cpp`, often `compiler/cpp/ir.cpp` too)
- SV backend changes if new ops are needed (`compiler/cpp/verilog.cpp`)
- Add or update tests under `test/` if a suite exists for that behavior
