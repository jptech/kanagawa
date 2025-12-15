# Rust frontend (compiler/rs)

This folder is the in-progress Rust replacement frontend.

## InitCompiler smoke test

The current Rust driver (`kanagawa-rs`) can perform a minimal `InitCompiler` call into the C++ backend.

### 1) Build the backend shared library

Kanagawa’s documented build support is Linux/WSL (see the repo root `BUILDING.md`). On macOS, you’ll likely need to build in a Linux environment (WSL2, VM, container) and use the resulting shared library from there.

Follow `BUILDING.md` to configure and build the compiler.

### 2) Locate the backend shared library

After building, locate the produced shared library in your build output directory. For example:

- `find <build_dir> -name '*.so' -o -name '*.dylib' | grep -i kanagawa`

You need the path to the backend library that exports the C ABI symbols like `InitCompiler`.

In this workspace, the backend dylib was found at:

- `kanagawa-build/dist/bin/libkanagawa-backend.dylib`

### 3) Run the Rust smoke test

From `compiler/rs/`:

- With an environment variable:

  - `KANAGAWA_BACKEND_LIB=/abs/path/to/libkanagawa-backend.dylib cargo run -p kanagawa_driver -- <file.k>`

- Or with an explicit flag:
  - `cargo run -p kanagawa_driver -- --backend-lib /abs/path/to/libkanagawa-backend.dylib <file.k>`

Example (matching this repo’s layout):

- `KANAGAWA_BACKEND_LIB=$PWD/../kanagawa-build/dist/bin/libkanagawa-backend.dylib cargo run -p kanagawa_driver -- ../../test/syntax/basics.k`

Optional:

- `--target-device <name>` sets the backend device name (defaults to `mock`).

If `InitCompiler` succeeds, the driver prints `InitCompiler ok`.

## Codegen smoke test (expected failure today)

There is also a `--smoke-codegen` mode that calls backend `Codegen(...)` with an _empty_ ParseTree root.
This validates symbol loading and call wiring, but it is expected to fail during device config extraction
until we emit a real program ParseTree and ensure the required device configuration modules are reachable.

Example:

- `KANAGAWA_BACKEND_LIB=$PWD/../kanagawa-build/dist/bin/libkanagawa-backend.dylib cargo run -p kanagawa_driver -- --smoke-codegen ../../test/syntax/basics.k`
