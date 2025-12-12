# Change Log

All notable changes to the Kanagawa Language Support extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-12-11

### Added
- GitHub Copilot / VS Code Language Model Tools integration to expose the semantic index to AI agents.
- New tool `kanagawa_get_symbol_details` to fetch full symbol details by `qualifiedName` after discovery.
- New tool `kanagawa_get_document_symbols` (token-efficient document symbol listing; top-level by default).
- Optional `kanagawa.config.local.json` project config overlay (merged on top of `kanagawa.config.json`).

### Changed
- Tool visibility is not gated by active language (`when: "true"`).
- `kanagawa_search_symbols` now returns token-efficient grouped results by file.
- High-volume list ranges use tuple encoding `[startLine,startChar,endLine,endChar]` (1-indexed).
- Tool outputs are emitted as minified JSON to reduce token usage.
- Project config loading now supports two files: `kanagawa.config.json` (shared) and `kanagawa.config.local.json` (local overlay). Arrays are combined; `stdlibPath` uses local-over-shared precedence (VS Code settings still override both).
- Improved symbol resolution and scope-aware prioritization (locals > members > same-module > imports > global).
- Better enum support, including improved handling of qualified enum members (e.g., `EnumType::Value`) in hover/definition scenarios.
- Hover information formatting improvements for readability (more consistent signatures and documentation presentation).
- Stability and robustness improvements across parsing/indexing/provider operations.

### Fixed
- Numerous bugfixes across resolution, indexing, and provider edge cases.

### Removed
- Tool `kanagawa_get_document_outline` (replaced by `kanagawa_get_document_symbols`).

### Testing
- Updated and expanded unit tests for the new tool contracts and outputs.
- Expanded unit test coverage across providers, resolution, and utility logic.

## [0.1.0] - 2024-12-01

### Added

#### Core Language Features
- **Go to Definition** (F12) — Navigate to symbol definitions across the workspace
- **Find All References** (Shift+F12) — Find all usages of a symbol
- **Hover Information** — Type signatures, documentation, and module paths
- **Auto-Completion** — Context-aware suggestions for symbols, keywords, and members
- **Signature Help** — Parameter hints for function calls and template arguments
- **Document Symbols** (Ctrl+Shift+O) — Navigate symbols in the current file
- **Workspace Symbols** (Ctrl+T) — Search all symbols in the project
- **Call Hierarchy** — View incoming and outgoing call relationships
- **Semantic Highlighting** — Rich syntax coloring based on symbol types

#### Inlay Hints
- Type hints for `auto` variable declarations
- Parameter name hints at function call sites
- Template parameter name hints at instantiation sites

#### Template Support
- Full template instantiation and type resolution
- Template parameter inference
- Nested template support

#### Module System
- Import path resolution with configurable search paths
- Module dependency graph visualization
- Interactive dependency explorer

#### Configuration
- Project-level `kanagawa.config.json` support with "Open Project Configuration" command
- VS Code settings integration with smart merging
- Developer mode toggle to hide/show advanced commands
- Glob-based file exclusion patterns
- Configurable inlay hints and outline filtering

#### Performance
- Cooperative scheduling for UI responsiveness
- LRU caching for member resolution
- Incremental document updates
- Configurable debounce and chunk sizes
- Performance logging and diagnostics

#### Developer Tools
- Parse tree debugging
- Index statistics
- Performance profiling commands
- Extension health diagnostics

### Technical
- LSP-Lite architecture with Tree-sitter parsing
- 1172 unit tests with comprehensive coverage
- Timeout and circuit breaker patterns for robustness
- Support for `.k` and `.pd` file extensions

### Removed
- Rename Symbol functionality — removed to simplify the release (may be added in a future version)

---

## Upcoming

### Planned Features
- Code formatting
- Semantic error diagnostics
- Code actions and quick fixes
- Snippet support
- Folding ranges

