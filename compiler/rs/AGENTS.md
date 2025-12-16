This is the Rust implementation of the Kanagawa frontend.

## Key Documents

- **`phase2_plan.md`** - Comprehensive plan for completing the Rust frontend including:

  - 13 architectural decisions (Salsa, ariadne, tower-lsp, template performance, etc.)
  - 8 implementation sprints with clear objectives and definitions of done
  - Technical specifications for code generation, type inference, LSP, formatter
  - Threading configuration and error recovery strategies

- **`audit.md`** - Comparison of Rust vs Haskell frontend progress and gaps
- **`progress.md`** - Running log of work completed (update after every task)

## Current Status

The frontend has working:

- Lexer and parser (rowan-based CST)
- AST lowering (CST → AST)
- HIR lowering (AST → HIR)
- Type checking foundation
- Semantic validation (kanagawa_sema)

## Build/Run

See `compiler/rs/README.md` for build instructions.

## Guidelines

- Always update `progress.md` after completing work
- Write tests for all new functionality
- Follow the sprint plan in `phase2_plan.md`
- Code generation emits to C++ backend via `kanagawa_parsetree_sys` FFI

## Key Instructions

We want to completely implement all of the type system (inference, bi-directional deduction, checking), CST -> AST -> HIR parsing pipeline, error diagnostics, mulit-module resolution, device configuration, const expression evlauation, template instaniation, emission to codegen. Think hard about each detail and the overall architecture.

This generally corresponds to sprint 1, sprint 2, sprint 3, and sprint 4 in the phase2_plan.md document. Update progress after completion of each task. Ensure clean code with comprehensive testing. Work to integrate all items end to end. Work to achieve feature parity with the Haskell frontend plus our value-adds of performance, better tooling, and updated architecture in Rust.

Helpful notes:
`cmake --build /Users/parker/experiments/kanagawa/kanagawa-build -j 10` to rebuild the C++ dylib
Dylib is in `/Users/parker/experiments/kanagawa/kanagawa-build/dist/bin/libkanagawa-backend.dylib`
Stdlib is in `/Users/parker/experiments/kanagawa/library`
Our updated phase 2 plan is in `/Users/parker/experiments/kanagawa/compiler/rs/phase2_plan.md`

Compilation in `compiler/rs`: `KANAGAWA_BACKEND_LIB=/Users/parker/experiments/kanagawa/kanagawa-build/dist/bin/libkanagawa-backend.dylib cargo build`
Running the tests or binaries may require setting a LIB path at runtime as well.
