# Kanagawa AI Tools for GitHub Copilot

This document describes the VS Code Language Model Tools integration that enables GitHub Copilot agents to query Kanagawa code context: symbols, types, imports, module APIs, and navigation.

## Overview

The Kanagawa VS Code extension exposes its semantic index to GitHub Copilot via **VS Code Language Model Tools** (`vscode.lm.registerTool`). These tools are designed to help agents work effectively in Kanagawa codebases that are not in model training data.

Core capabilities:
- Name-based discovery: look up/search symbols
- Cursor-grounded navigation: resolve symbol/definition/references at a position
- Type understanding: get members, infer expression types
- Project discovery: list modules, get module APIs (exports), list document symbols

## I/O Conventions

### Paths

- Tool outputs use workspace-relative paths when possible (with `/` separators), and fall back to absolute paths for external/stdlib files.
- Tool inputs accept either absolute paths or workspace-relative paths.

### Positions

- All tool inputs that include a position use **1-indexed** `line` and `character`.

### Locations

Tool results use a structured location format:

```json
{
  "uri": "file:///...",
  "path": "src/main.k",
  "range": {
    "start": { "line": 10, "character": 1 },
    "end": { "line": 10, "character": 5 }
  }
}
```

For high-volume list outputs (e.g., `kanagawa_search_symbols` and `kanagawa_get_document_symbols`), ranges are returned in a token-efficient tuple form:

```json
"range": [64, 20, 64, 33]
```

This means `[startLine, startCharacter, endLine, endCharacter]` (all 1-indexed).

## Tools

### Symbol and type tools

1. `kanagawa_lookup_symbol` — look up a symbol by name
2. `kanagawa_search_symbols` — search symbols by prefix/substring (token-efficient, grouped by file)
3. `kanagawa_get_symbol_details` — fetch rich details for a symbol by `qualifiedName`
4. `kanagawa_get_type_members` — list members of a type (templated types supported)
5. `kanagawa_infer_type` — infer the type of an expression at a position

### Imports, modules, and structure

6. `kanagawa_get_imports` — list imports for a file (and whether they resolve)
7. `kanagawa_get_module_exports` — list exports from a file (module-level / top-level)
8. `kanagawa_list_modules` — list module paths discovered in indexed files
9. `kanagawa_get_module_api` — list exported symbols for a module (supports transitive re-exports)
10. `kanagawa_get_document_symbols` — token-efficient symbol listing for a file

### Cursor-grounded navigation

11. `kanagawa_resolve_symbol_at_position` — resolve symbol under cursor (primary + alternatives + confidence)
12. `kanagawa_get_definition_locations` — definition locations for symbol under cursor
13. `kanagawa_find_references` — reference locations for symbol under cursor

## Activation

Tools are registered when the extension activates.

Tool visibility is **not gated by language** (the extension contributes these tools with `when: "true"`), so they can appear available even when a non-Kanagawa file is active.

## Error Handling

All tools return structured error responses:

```json
{
  "error": "Symbol not found: UnknownType",
  "code": "SYMBOL_NOT_FOUND"
}
```

Error codes:
- `SYMBOL_NOT_FOUND` — no matching symbols
- `FILE_NOT_FOUND` — file isn't indexed / doesn't exist
- `INDEX_NOT_READY` — index is still building
- `PARSE_ERROR` — failed to parse
- `INVALID_POSITION` — position outside bounds
- `INVALID_INPUT` — missing/invalid inputs
- `CANCELLED` — request cancelled
- `INTERNAL_ERROR` — unexpected runtime error

## Testing

Unit tests validate the pure tool logic against a mock indexer implementation.

## Files

| File | Purpose |
|------|---------|
| `src/copilot/types.ts` | Canonical tool input/output types (VS Code–agnostic) |
| `src/copilot/toolLogic.ts` | Pure tool logic (unit-tested) |
| `src/copilot/tools.ts` | VS Code tool wrappers + path rewriting |
| `src/copilot/index.ts` | Tool registration |
| `src/service/IWorkspaceIndexer.ts` | Indexer interface for testability |
| `test/mocks/indexer.ts` | Mock indexer for unit tests |
| `test/unit/copilotTools.test.ts` | Tool logic unit tests |
