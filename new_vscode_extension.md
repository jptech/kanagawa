# Kanagawa VS Code Extension (LSP-Lite) Reference Guide

*Last updated: November 20, 2025*

This document captures the current state of the Kanagawa VS Code “LSP-lite” extension, outlines why it exists, describes the internal architecture and feature set, and notes areas targeted for future development. It is intended as a living reference for contributors who are evolving the extension alongside the Kanagawa toolchain.

---

## 1. Purpose & Philosophy

Kanagawa’s VS Code integration provides a fast, self-contained authoring experience without relying on heavyweight external language servers. The extension:

- Embeds a WebAssembly version of the Tree-sitter grammar to deliver incremental parsing, syntax diagnostics, semantic tokens, and structured symbol data.
- Implements lightweight LSP-like capabilities (hover, go to definition, completion, document symbols, folding, diagnostics) using TypeScript services running in-process.
- Favors responsiveness and resilience over perfect semantic understanding, opting for heuristic type inference backed by the indexed symbol graph.

The goal is a highly responsive development aide that scales with the Kanagawa language’s evolving syntax and semantics while remaining easy to maintain and extend.

---

## 2. Repository Layout

```
tools/editors/vscode-new/
├── dist/                     # Compiled extension output (JS bundles + WASM parser)
├── grammar/                  # Tree-sitter grammar source used to build the WASM parser
├── queries/                  # Tree-sitter highlight and symbol queries
├── src/
│   ├── extension.ts          # Extension activation entry point
│   ├── service/
│   │   ├── treeSitter.ts     # Parser initialization and tree caching
│   │   ├── indexer.ts        # Symbol extraction, doc indexing, type inference, caches
│   │   └── query.ts          # Query loading utility
│   └── providers/            # Hover, definition, completion, diagnostics, etc.
└── new_vscode_extension.md   # (This guide)
```

---

## 3. Activation & Runtime Flow

1. **Activation** – Triggered when a document with `languageId === "kanagawa"` is opened.
2. **Tree-sitter bootstrap** – `TreeSitterService` loads `tree-sitter-kanagawa.wasm`, initializes `web-tree-sitter`, and maintains parse trees per document.
3. **Indexing** – `WorkspaceIndexer` scans `.k` files (active plus workspace), running the `definitions.scm` query to harvest symbols, docs, and scope information. The index persists in-memory and updates per save/change.
4. **Providers** – VS Code registration hooks wire our services into hover, definition, completion, semantic tokens, document symbols, folding, diagnostics, etc.
5. **Caching** – Type inference results, member lists, and document-level context (module + imports) are cached to speed repeated operations.

---

## 4. Tree-sitter Integration

- Grammar lives in `grammar/grammar.js` (parses modern Kanagawa constructs including templated types, doc comments, member expressions, etc.).
- Queries:
  - `highlights.scm` – semantic token matching
  - `definitions.scm` – symbol extraction for indexing
  - `outline.scm` – document symbols / outline view
- WASM build pipeline uses `tree-sitter generate` + emscripten container (see `GRAMMAR_STATUS.md`). Generated WASM is shipped in `dist/` and loaded via VS Code’s file API.

---

## 5. Service Layer

### 5.1 `TreeSitterService`
- Parses open documents, stores trees keyed by URI, and re-parses after text changes.
- Currently performs full reparse on every change for correctness (incremental edits can be added later).

### 5.2 `WorkspaceIndexer`
- Runs the definitions query to collect declarations (modules, classes, struct/union, functions, members, variables, constants, aliases).
- Captures doc comments (both `//|` pre-doc and `//<` post-doc) and stores them with the target symbol.
- Generates scope paths (module → class → function → etc.) for symbol disambiguation.
- Tracks document imports to boost resolution across modules.
- Provides APIs:
  - `scanWorkspace`, `indexFile`, `updateFile`
  - `getSymbols`, `resolveSymbols` (scope-aware scoring)
  - `findNearestLocalSymbol`
  - `inferTypeFromExpression` with caching (recognizes identifiers, member chains)
  - `getMembersForType` and caches members by normalized type name
  - `collectVisibleLocals` for completion contexts
  - `resolveMemberSymbol` for member-specific hover/definition lookups
- Maintains caches: type inference per document, member results per type, document context (module path + imports).

---

## 6. Feature Providers

### 6.1 Hover (`providers/hover.ts`)
- Uses AST position to locate identifier, scope path, and doc text.
- Prioritizes:
  1. Local declaration (nearest variable/parameter)
  2. Member match based on receiver type (e.g., `_data.read()` → `pipelined_memory::read`)
  3. Global matches scored by scope similarity/import context.
- Presents signature, doc comment, scope info, and file origin in Markdown.

### 6.2 Definition (`providers/definition.ts`)
- Follows the same prioritization as hover.
- Returns VS Code `Location` objects for the most relevant symbol(s).
- Supports member resolution, local variables, and global definitions.

### 6.3 Completion (`providers/completion.ts`)
- Currently supports:
  - **Dot completions:** inference → `getMembersForType` → snippet-ready method entries & fields.
  - **Static (`Type::`) completions:** same mechanism using normalized type names.
  - **Word context completions:** locals (prefix-filtered), keywords, global symbols.
- Utilizes snippet insert text for methods, commit characters, and sorted `sortText` (locals first, keywords second, globals last).
- Future expansions planned (see roadmap).

### 6.4 Diagnostics (`providers/diagnostics.ts`)
- Traverses parse tree for `ERROR` or missing nodes and surfaces them as syntax diagnostics.

### 6.5 Semantic Tokens (`providers/semanticTokens.ts`)
- Executes `highlights.scm` to tag tokens with VS Code semantic token types and modifiers.

### 6.6 Document Symbols & Folding
- `documentSymbol.ts` – Outline view via query results.
- `folding.ts` – Basic block folding (currently limited; can be extended to doc comments, modules, etc.).

### 6.7 Completion Suggestions for Keywords & Snippets
- Keyword list provides quick access to language constructs.
- Snippet-based method completions accelerate chaining (`object.method($0)`).

---

## 7. Type Inference & Symbol Ranking

- **Local priority:** `findNearestLocalSymbol` walks up the AST to find the closest variable declaration or parameter preceding the cursor.
- **Caching:** Results keyed by document URI + AST node ID avoid redundant inference.
- **Member inference:** Recursively resolves `object.member` to fetch the member’s type hint (useful in chains).
- **Scope scoring:** `resolveSymbols` uses scope path similarity (prefix + suffix matches), module/import hints, and member context to rank results. Same-file matches get additional weight.
- **Context hints:** Completion, hover, and definition providers pass hints (method vs free function, receiver type) to bias resolution in favor of the intended symbol.

---

## 8. Diagnostics & Logging

- Diagnostics pipeline is limited to syntax errors from Tree-sitter currently. Type or semantic diagnostics are out-of-scope for the LSP-lite iteration.
- Logging statements (using `console.log`) exist for debugging but are minimal; additional logging can be toggled if we add verbose modes.

---

## 9. Build & Test Procedures

- **Build:** `npm run compile` compiles the TypeScript sources (tsconfig targets `out/`).
- **Test:** `npm test` runs compile + lint + `out/test/runTest.js` (currently a placeholder). Real integration tests can be added using `@vscode/test-electron` once we have scenarios scripted.
- **Lint:** ESLint runs via `npm run lint`. Note: there are outstanding lint warnings (unused parameters, explicit `any`, non-null assertions) intentionally deferred until feature work stabilizes.
- **Grammar build:** See `GRAMMAR_STATUS.md` for the tree-sitter generation & WASM build steps.

---

## 10. Performance Considerations

- **Caching** ensures repeated operations (hovering over the same expression, repeated completions) reuse results.
- **Member cache** is invalidated on file re-index to keep results fresh.
- **Workspace indexing** runs asynchronously in chunks to avoid blocking the UI thread.
- Currently we reparse documents fully on each change; incremental edits may be reintroduceable once change ranges are tracked carefully.

---

## 11. Limitations & Known Issues

- Type inference is heuristic; it does not execute full Kanagawa semantic passes. Complex generics, advanced template constructs, or overload resolution by signature are not yet handled.
- Diagnostics limited to syntax errors—no type or semantic warnings.
- ESLint warnings remain for legacy `any` usage and non-null assertions.
- `completion.ts` does not yet offer global symbol completions with namespace qualifiers, auto-import suggestions, or snippet libraries beyond simple method parentheses.
- Static analysis (e.g., inheritance, interface methods) is not considered; we rely on scope names only.
- Document symbol tree is flat (no hierarchical view for nested scopes yet).

---

## 12. Future Work Roadmap

1. **Completion Enhancements**
   - Incremental type inference improvements (function return types, template argument propagation, alias resolution).
   - Auto-import suggestions when completion picks a symbol from another module.
   - Consider cached type evaluation for `auto` variables + constant expressions.
   - Add `Type::staticMember` completions that respect static vs instance semantics.

2. **Testing Infrastructure**
   - Add integration tests for completion, hover, and definition flows using VS Code’s test runner.
   - Snapshot tests verifying symbol indexes for key library files.

3. **Incremental Parsing**
   - Re-enable Tree-sitter incremental edits by wiring `edit` calls with VS Code change ranges.
   - Profile memory usage to ensure tree churn remains manageable.

4. **Lint Cleanup & Code Quality**
   - Eliminate `any`, unused parameters, and non-null assertions once feature velocity stabilizes.
   - Adopt stricter linting for new files.

5. **Semantic Diagnostics (Longer Term)**
   - Integrate with the Kanagawa CLI or compiler JSON outputs for deeper diagnostics when a background build is available.

6. **User Experience**
   - Command palette actions (e.g., “Re-index workspace”).
   - Status bar indicator for index progress.
   - Telemetry/Logging toggles for debugging resolution decisions.

---

## 13. Getting Started (Developer Quick Steps)

1. Build grammar (if changed): follow `GRAMMAR_STATUS.md` instructions to regenerate `tree-sitter-kanagawa.wasm`.
2. Install dependencies: `npm install` within `tools/editors/vscode-new`.
3. Build the extension: `npm run compile`.
4. Run lint/tests: `npm test` (currently compiles, lints, and prints placeholder message).
5. Launch VS Code with the extension in development mode (use `F5` in VS Code or `code --extensionDevelopmentPath=...`).
6. Debug output: watch the “Kanagawa Parse Tree” channel or VS Code debug console for logs.

---

## 14. Contributing Guidelines

- Run `npm test` before submitting changes (compilation + lint).
- Keep documentation updated (`new_vscode_extension.md`, `GRAMMAR_STATUS.md`).
- Prefer incremental merges (feature flag or incremental capability) to maintain developer productivity.
- Coordinate grammar changes with the Haskell parser where applicable.
- Communicate major feature additions (e.g., new completion capabilities) in release notes and this document’s changelog.

---

## 15. Change Log (Recent Highlights)

| Date (2025) | Update |
|-------------|--------|
| Nov 20 | Member-aware hover/definition resolution (`resolveMemberSymbol`). |
| Nov 20 | Contextual completions (dot + `Type::`, locals, prefix filtering, caching). |
| Nov 20 | Type inference caching, member chain resolution, doc-string anchoring for templates. |
| Nov 19 | Bug fixes for Ada-style grammar conflicts; doc comment association improvements. |

- Add new entries as major features land.

---

## 16. Contact

For questions, reach out to the Kanagawa tools team or open an issue in the `dev/pmitchell/alt_vscode_ext` branch. Please keep this document updated as functionality evolves.

---

*Thank you for contributing to the Kanagawa extension. This guide should empower you to add features with confidence and understand the system’s moving parts. Happy hacking!*