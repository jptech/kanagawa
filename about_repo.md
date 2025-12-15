# Kanagawa repository architecture (language + compiler)

This document is a repo-oriented “how it works” guide for Kanagawa: what lives where, how the compiler is structured, and how a Kanagawa program becomes SystemVerilog.

It is written to help both humans and automated agents quickly orient in the codebase.

## 1. What Kanagawa is (as represented in this repo)

Kanagawa is an imperative, strongly-typed, C++-like language for hardware design with an explicit concurrency model (“Wavefront Threading”). The repo contains:

- A **Haskell front-end** that parses Kanagawa source (`.k`), builds a typed AST, and runs “frontend” transformation/validation passes.
- A **C++ back-end** (a shared library) that receives a language-neutral **ParseTree** representation via an FFI boundary and performs:
  - type checking and whole-program checks that depend on back-end knowledge,
  - lowering to an internal IR shaped around **functions → basic blocks → operations**,
  - scheduling/optimization/placement heuristics,
  - CIRCT/MLIR construction and **SystemVerilog codegen**, plus reports.
- A **standard library** written in Kanagawa (`library/`) and a **SystemVerilog runtime RTL** layer (`runtime/rtl/`) used by generated designs.
- Tooling (docs generators, doc checkers, editor integrations) and tests.

Canonical language docs are in:

- [doc/programming-guide.md](doc/programming-guide.md) — language syntax and user model.
- [doc/mapping-to-hardware.md](doc/mapping-to-hardware.md) — how constructs map to pipelines/FIFOs, etc.
- [doc/effective-kanagawa.md](doc/effective-kanagawa.md) — guidelines + compiler settings tradeoffs.

## 2. Top-level repo map

High-level directories that matter when “reading the compiler”:

- `compiler/`
  - `compiler/hs/` — Haskell front-end (parser, passes, type inference, CLI)
  - `compiler/cpp/` — C++ back-end (ParseTree implementation, lowering, IR, scheduling, codegen)
  - `compiler/kanagawa.cabal` — front-end build + links to the back-end shared library
- `library/` — standard library and reusable IP written in Kanagawa (`.k` files)
- `runtime/rtl/` — SystemVerilog runtime building blocks (FIFOs, semaphores, reset logic, etc.)
- `test/` — CTest-driven suites across syntax/frontend, compiler behavior, library, runtime RTL, etc.
- `thirdparty/` — submodules/dependencies (notably CIRCT)
- `tools/`
  - `tools/sandcastle/` — documentation generator for annotated Kanagawa source
  - `tools/chkdoc/` — documentation validation tooling
  - `tools/editors/` — editor tooling (including a “LSP-lite” VS Code extension)

Build glue:

- `CMakeLists.txt` — orchestrates `thirdparty/`, `compiler/`, `test/`, `tools/`
- `build/cmake/*.cmake` — dependency discovery, release helpers, and test helpers

## 3. How to build and run tests (repo-level)

The authoritative build instructions are in [BUILDING.md](BUILDING.md). The key points:

- Main build system is **CMake** (recommended generator: Ninja).
- The Haskell front-end is built using **cabal**, but invoked through CMake.
- The C++ back-end is built as a shared library that the Haskell executable links against.
- Tests are driven via **ctest** with name-prefix conventions (e.g. `^syntax\.`).

The root build (`CMakeLists.txt`) defines a “heavy job pool” concept to limit memory-hungry parallel work (Kanagawa compilation + Verilator compilation).

## 4. Compiler architecture at a glance

The compiler is logically split into:

1. **Front-end (Haskell):** parse + desugar + template instantiation + type inference/type-checking.

2. **Boundary representation (“ParseTree”):** a C API defined in `compiler/cpp/parse_tree.h` used by the front-end to build a C++-owned parse tree. This is the stable-ish contract between the two languages.

3. **Back-end / middle-end (C++):** type checking (again, with back-end semantics), whole-program checks, lowering to IR, optimization, scheduling, placement, then codegen via CIRCT/MLIR to SystemVerilog.

A simplified pipeline looks like:

```
.k source files
  │
  ▼
Haskell parser (megaparsec) → AST + symbol tables
  │
  ▼
Frontend passes (desugar/validate/templates/type inference)
  │
  ▼
Haskell→C FFI: build ParseTree nodes + locations/types
  │
  ▼
C++ compiler: SetRoot + TypeCheck + whole-program transforms
  │
  ▼
Function instance enumeration
  │
  ▼
Lowering to IR (Program/Function/BasicBlock/Operation)
  │
  ▼
Optimization + scheduling + placement heuristics
  │
  ▼
CIRCT/MLIR module construction → SV emission
  │
  ▼
Artifacts: .sv/.mlir/.json reports + debug symbols
```

## 5. Front-end (Haskell) implementation

### 5.1 Entry point and modes

The Haskell executable entry is [compiler/hs/app/Main.hs](compiler/hs/app/Main.hs).

Modes include:

- “pretty” (pretty-print parsed source)
- “compile” (the actual compiler driver)

The compile mode:

- parses the requested files (and imports),
- merges them into a single AST sequence,
- runs a configurable number of frontend passes,
- reports warnings/errors,
- then calls `compile` from the `ParseTree` module (which bridges into C++).

The CLI surface is defined in [compiler/hs/app/Options/CmdArgs.hs](compiler/hs/app/Options/CmdArgs.hs) and mirrors the C++ `Options` struct.

### 5.2 Parsing and source positions

The parser is built on **Megaparsec**. The central parsing entrypoints live under:

- `compiler/hs/lib/Language/Kanagawa/Parser.*`

Notable characteristics visible in [compiler/hs/lib/Language/Kanagawa/Parser.hs](compiler/hs/lib/Language/Kanagawa/Parser.hs):

- AST nodes are annotated with source spans (`Src offset begin end ...`).
- There is a module system (`module` declarations, `import` statements).
- Documentation comments (`//|` and `//<`) can be parsed when `--parse-docs` is enabled (used by Sandcastle).

### 5.3 Frontend passes

The core “frontend pipeline” is defined in [compiler/hs/lib/Language/Kanagawa/Frontend.hs](compiler/hs/lib/Language/Kanagawa/Frontend.hs).

It composes passes such as:

- syntax/structure validation (`validateProgram`, `validateExtern`, etc.)
- desugaring steps (e.g., interpolated strings pre/post handling)
- template instantiation and template argument deduction
- type inference (`inferType`)
- checks like “free functions must be inline”

Because Kanagawa is a hardware-oriented language with special constraints (e.g., global state restrictions), some correctness checks live in these passes. For example, [compiler/hs/lib/Language/Kanagawa/TypeCheck.hs](compiler/hs/lib/Language/Kanagawa/TypeCheck.hs) contains checks like rejecting global mutable variables.

### 5.4 Frontend-to-backend bridge (“ParseTree” in Haskell)

The bridge layer is [compiler/hs/app/ParseTree.hs](compiler/hs/app/ParseTree.hs).

Its job is to traverse the typed Haskell AST and build a C++ parse tree by calling C functions declared in `parse_tree.h` via FFI.

Key details:

- The traversal uses `cataM` (a catamorphism) over the typed AST.
- Each node’s source span is converted into a `Location` struct and sent to the back-end using `SetLocation2`.
- For integer/enum expressions, the bridge may explicitly call `SetNodeType` so the back-end sees an exact leaf type (e.g., `int32`, `uint7`) rather than re-inferring.

The low-level FFI bindings are in [compiler/hs/app/ParseTree/FFI.hs](compiler/hs/app/ParseTree/FFI.hs).

Options marshaling for the back-end is handled by [compiler/hs/app/Options/FFI.hsc](compiler/hs/app/Options/FFI.hsc), which fills the C `Options` struct used by `InitCompiler`.

## 6. ParseTree: the stable-ish interface between Haskell and C++

The ParseTree interface is declared in [compiler/cpp/parse_tree.h](compiler/cpp/parse_tree.h). It defines:

- `ParseTreeNodePtr` — an opaque pointer type (C-facing) to C++ node objects.
- `Location` — file/line/column span + file index.
- Enums for operator kinds, attributes, function modifiers, memory kinds, etc.
- A large set of constructors like `ParseBinaryOp`, `ParseFunction`, `ParseClass`, `ParseEnum`, etc.
- The two “entrypoints” the front-end actually calls:
  - `InitCompiler(const Options*)`
  - `Codegen(target, outputBase, res, dgml, dgmlDetailed, root)`

In practice:

- The Haskell side constructs a full ParseTree rooted at a `Seq` of top-level declarations.
- The root pointer is passed into `Codegen`.

The implementation of most ParseTree semantics and the back-end type checking/lowering lives in the enormous [compiler/cpp/parse_tree.cpp](compiler/cpp/parse_tree.cpp).

## 7. Back-end (C++) compiler implementation

### 7.1 Shared library and driver entrypoint

The C++ back-end is built as the shared library `kanagawa-backend` (CMake target `kanagawa_lib`). Its C API is exported from `parse_tree.h` / `kanagawa.cpp`.

The main compilation driver is [compiler/cpp/kanagawa.cpp](compiler/cpp/kanagawa.cpp), implementing `Codegen(...)`.

The driver performs a predictable “compiler pipeline”:

- optional debug attach gate (`PD_WAIT_FOR_DEBUG`)
- determine which outputs are requested (SV backend, DGML, resource report)
- `compiler.SetRoot(root, compileToVerilog)`
- whole-program steps:
  - `FindModifiedParameters()`
  - `TypeCheck()`
  - `CheckTypeNames()`
  - `ReorderDeclarations()`
  - `ExtractDeviceConfig()` and `DeviceCapabilityCheck()`
  - `RenameStaticLocals()`
  - `EnumerateCompiledModules()`
  - `MarkPermanentNodes()` to split node lifetime between “global” and per-module
- per compiled module:
  - `Reset(module)`
  - `ExternalizeClasses()`
  - `RegisterObjects(module)`
  - `EnumerateFunctionInstances(module)`
  - `GenerateIR(module)`
  - `CompileVerilog(...)` and/or report generation

### 7.2 Compiler state and infrastructure

The primary C++ orchestrator is `Compiler` in:

- [compiler/cpp/compiler.h](compiler/cpp/compiler.h)
- [compiler/cpp/compiler.cpp](compiler/cpp/compiler.cpp)

Notable design choices:

- There is a global singleton pointer `g_compiler`.
- All CIRCT/MLIR objects for an invocation share one `mlir::MLIRContext` (`LoadDialects()` is called during `Init()`).
- Intrinsics are registered in `RegisterIntrinsics()` (examples: `assert`, `__print`, `__cycles`).
- The compiler maintains explicit ownership/cleanup lists for ParseTree nodes, split into:
  - “permanent” (across compiled modules)
  - “temporary” (cleared per module)

### 7.3 Configuration: options + device config

The C-facing codegen configuration lives in:

- [compiler/cpp/options.h](compiler/cpp/options.h) — `Options`, `CodeGenOptions`, `PlacementOptions`, etc.
- [compiler/cpp/config.h](compiler/cpp/config.h) / [compiler/cpp/config.cpp](compiler/cpp/config.cpp) — derived configuration (`CodeGenConfig`) and target device properties (`CodeGenDeviceConfig`).

Important details:

- `SetupCodeGenConfig(const Options&)` copies CLI-provided config into global state.
- Some features are intentionally rejected at runtime (currently) to match downstream limitations; for example [compiler/cpp/config.cpp](compiler/cpp/config.cpp) enforces that certain CIRCT-dependent features are disabled (clock gating and stallable pipelines).
- Device properties are extracted from a “special Kanagawa module” during compilation (`ExtractDeviceConfig()`), then stored as `CodeGenDeviceConfig` for later heuristics (memory inference, FIFO sizing, etc.).

### 7.4 Function instance enumeration

Kanagawa distinguishes between inline functions, member functions, and object-specific method instances. The back-end computes a set of concrete “function instances” before lowering.

The logic is described in:

- [compiler/cpp/enumerate_function_instances.h](compiler/cpp/enumerate_function_instances.h)

The comment at the top summarizes the model:

- flat non-inline functions → 1 instance
- non-inline methods → 1 instance per object
- inline functions → 1 instance per call site

This enumeration step feeds later stages that need precise instance identities for scheduling, stack depth, static locals, and naming.

### 7.5 IR: Program / Function / BasicBlock / Operation

The back-end’s internal IR is defined primarily in:

- [compiler/cpp/ir.h](compiler/cpp/ir.h)
- [compiler/cpp/ir.cpp](compiler/cpp/ir.cpp)

The IR is designed for hardware lowering:

- A `Program` contains functions, global registers, FIFO records, type export info, etc.
- A `Function` contains multiple `BasicBlock`s.
- A `BasicBlock` is the unit that maps naturally to a **pipeline** in the generated hardware.
- `Operation`s represent IR instructions; they work over registers, literals, and structured operands.

This aligns with the language→hardware description in [doc/mapping-to-hardware.md](doc/mapping-to-hardware.md): basic blocks map to pipelines and branches map to FIFOs.

Control/data-flow infrastructure includes:

- [compiler/cpp/control_flow_graph.h](compiler/cpp/control_flow_graph.h) — a CFG layer with both pre- and post-pipeline variants (important because pipeline-register insertion changes how locals are renamed across edges).
- [compiler/cpp/data_flow_work_list.h](compiler/cpp/data_flow_work_list.h) — generic forward/backward dataflow framework.

### 7.6 Lowering (ParseTree → IR)

Lowering is performed by the back-end after type checking. It produces `Program` IR and includes many hardware-specific transformations.

A lot of this logic is distributed between:

- [compiler/cpp/parse_tree.cpp](compiler/cpp/parse_tree.cpp) — ParseTree node semantics, name handling, some typing rules, and early normalization.
- [compiler/cpp/ir.cpp](compiler/cpp/ir.cpp) — emission of IR ops from typed ParseTree nodes and helper logic.
- [compiler/cpp/lower.cpp](compiler/cpp/lower.cpp) — additional lowering/cleanup steps (example: width equalization for compares to avoid downstream lint warnings).

### 7.7 Optimization and scheduling

Optimization functions are declared in [compiler/cpp/optimize.h](compiler/cpp/optimize.h) and implemented in `optimize.cpp`/`optimize_lut.cpp`.

The optimizer is organized into phases (see `OptimizationPhase` in `optimize.h`) such as LUT packing and synthesis-oriented transforms. Many transforms run “to convergence”.

Scheduling is implemented in [compiler/cpp/schedule.cpp](compiler/cpp/schedule.cpp). It includes an internal constraint scheduler that assigns operations to pipeline stages subject to constraints, with special logic for atomic blocks and multiple scheduling passes.

### 7.8 Placement heuristics

The compiler includes simulated placement to make connectivity/cost decisions, exposed as `Placement` in:

- [compiler/cpp/place.h](compiler/cpp/place.h)

It models a graph of nodes and edges and uses force-directed placement plus a route-sorting stage (2‑opt heuristic). This is used to guide decisions like cross-region FIFO insertion or ordering of connected components.

### 7.9 Code generation: CIRCT/MLIR + SystemVerilog

The SV back-end is driven via CIRCT/MLIR:

- [compiler/cpp/circt_util.h](compiler/cpp/circt_util.h) defines helpers to load dialects and create modules/design ops.
- [compiler/cpp/verilog.h](compiler/cpp/verilog.h) declares the top-level `CompileVerilog(...)` entry.
- [compiler/cpp/verilog.cpp](compiler/cpp/verilog.cpp) builds CIRCT operations using dialects like `circt::hw`, `circt::kanagawa`, `circt::pipeline`, `circt::sv`, `circt::seq`, and emits SV.

The `Codegen` driver emits multiple artifact types for each compiled module:

- `*.sv` + `*_types.sv` — main RTL and SV package/types
- `*.mlir` — CIRCT/MLIR dump (when enabled / for debug)
- `*RtlMap.json` — mapping metadata
- `*Symbols.csv` and `*DebugSymbols.csv` — symbol/debug maps
- `*.tcl`, `*HwConfig.mk` — integration helper outputs
- optional reports (resource usage, path length, clock gating report)

There is also explicit IR serialization:

- [compiler/cpp/serialize_ir.h](compiler/cpp/serialize_ir.h) / `serialize_ir.cpp` — serialize the internal IR to JSON.

## 8. Runtime RTL (`runtime/rtl/`)

Generated designs rely on a set of SystemVerilog modules in `runtime/rtl/`, including (non-exhaustive):

- FIFO implementations: `two_register_fifo.sv`, `register_fifo*.sv`, `fixed_delay_fifo.sv`, `cross_region_fifo.sv`, `internal_buffer_fifo.sv`
- Control blocks: `semaphore.sv`, `reset_control.sv`, `loop_generator.sv`
- Debug/inspection helpers: `fifo_debug.sv`, `cycle_counter.sv`
- Memory helpers: `sync_ram*.sv`, `logic_ram.sv`, `memory_bypass.sv`, `mem_init_ctrl.sv`

These modules are intended to be platform-neutral building blocks that the compiler can instantiate when lowering language constructs (e.g., basic-block edges, pipelined loops, call-site context saving).

## 9. Standard library (`library/`)

The Kanagawa standard library is itself Kanagawa source. The top-level `library/` folders group modules by domain:

- `numeric/` — numeric utilities and operators
- `sync/` — concurrency/synchronization helpers (e.g., atomic patterns referenced in docs)
- `processor/` — larger IP (e.g., RISC‑V cores)
- `device/`, `intel/`, `xilinx/` — device/platform-specific modules and configuration
- `control/`, `data/`, `codec/`, etc.

The base library entrypoints in this repo include:

- `library/base.k`
- `library/mini-base.k`

The compiler by default imports a base library unless `--no-implicit-base` is set.

## 10. Tooling

### 10.1 Sandcastle documentation generator

Sandcastle is a separate tool for generating docs from annotated Kanagawa source:

- Design/markup guide: [doc/sandcastle.md](doc/sandcastle.md)
- Implementation: `tools/sandcastle/`

Kanagawa source annotations like `//|` and `//<` are parsed by the compiler front-end when `--parse-docs` is used.

### 10.2 chkdoc

`tools/chkdoc/` contains a doc validation tool used by tests/CI.

### 10.3 Editor integrations

`tools/editors/` contains editor tooling. The repo also includes an extensive guide for a VS Code “LSP-lite” extension in:

- [tools/editors/vscode-new/TS_Extension.md](tools/editors/vscode-new/TS_Extension.md)

That extension is separate from the compiler; it uses a Tree-sitter grammar + indexing heuristics rather than invoking the full Kanagawa compiler.

## 11. Tests

Tests are organized under `test/` and wired via CMake/CTest.

At the top level, [test/CMakeLists.txt](test/CMakeLists.txt) adds suites:

- `syntax/` — front-end parser/syntax validation tests
- `compiler/` — compiler behavior tests
- `interface/`, `library/`, `logic/`, `runtime/rtl/` — enabled when Verilator is available

[BUILDING.md](BUILDING.md) documents the test naming conventions and convenience targets.

## 12. “Where do I start reading?” (suggested navigation)

If you want to understand end-to-end compilation:

1. Front-end driver: [compiler/hs/app/Main.hs](compiler/hs/app/Main.hs)
2. Front-end pipeline: [compiler/hs/lib/Language/Kanagawa/Frontend.hs](compiler/hs/lib/Language/Kanagawa/Frontend.hs)
3. FFI bridge: [compiler/hs/app/ParseTree.hs](compiler/hs/app/ParseTree.hs)
4. ParseTree API contract: [compiler/cpp/parse_tree.h](compiler/cpp/parse_tree.h)
5. Back-end driver: [compiler/cpp/kanagawa.cpp](compiler/cpp/kanagawa.cpp)
6. Back-end orchestration: [compiler/cpp/compiler.h](compiler/cpp/compiler.h)
7. IR definitions: [compiler/cpp/ir.h](compiler/cpp/ir.h)
8. Codegen backend: [compiler/cpp/verilog.cpp](compiler/cpp/verilog.cpp)

If you want to map language constructs to hardware, read [doc/mapping-to-hardware.md](doc/mapping-to-hardware.md) alongside the IR and Verilog backend.

## 13. Extending the system (practical contributor notes)

Because the compiler is split across Haskell and C++, adding a new language feature often requires touching multiple layers:

- **Parser/AST (Haskell):** update `Language.Kanagawa.Parser.*` and AST types in `Language.Kanagawa.Parser.Syntax`.
- **Frontend passes:** update `Language.Kanagawa.Frontend` and related desugaring/type inference so the typed AST is well-formed.
- **ParseTree contract:** if the feature needs a new node kind or attribute, update `compiler/cpp/parse_tree.h` (and keep any mirrored enums in Haskell’s `ParseTree/Types.hsc` in sync).
- **FFI lowering (Haskell):** update [compiler/hs/app/ParseTree.hs](compiler/hs/app/ParseTree.hs) to call the correct ParseTree constructors.
- **Back-end semantics:** update [compiler/cpp/parse_tree.cpp](compiler/cpp/parse_tree.cpp) to type-check and interpret the new node.
- **IR/codegen:** update `ir.cpp` / `lower.cpp` / `verilog.cpp` if the feature introduces new lowering patterns or runtime RTL needs.

For target-device changes (new FPGA family, memory shapes, etc.), expect to interact with:

- `ExtractDeviceConfig()` (back-end)
- `CodeGenDeviceConfig` (`compiler/cpp/config.h`)
- `library/device/`, `library/intel/`, `library/xilinx/` (source-level device descriptions)

---

If you want, I can also generate a smaller “agent cheat sheet” version of this doc (entrypoints + invariants + common failure modes) optimized for LLM-based code navigation.
