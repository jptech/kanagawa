# Kanagawa Language Support for VS Code

A lightweight, fast language extension for the Kanagawa hardware description language. Provides IDE features through "LSP-Lite" architecture—all features run in-process using Tree-sitter parsing, with no external language server required.

## Features

### Navigation & Discovery
- **Go to Definition** (F12) — Jump to function, class, module, or variable definitions
- **Find References** (Shift+F12) — Find all usages of a symbol across the workspace
- **Call Hierarchy** — View incoming/outgoing call relationships
- **Document Outline** — Navigate symbols in the current file (Ctrl+Shift+O)
- **Workspace Symbols** — Search all symbols across the project (Ctrl+T)
- **Rename Symbol** (F2) — Safely rename symbols across files
- **Dependency Graph** — Visualize module import relationships

### Code Intelligence
- **Hover Information** — See type signatures, documentation, and module paths
- **Signature Help** — Parameter hints while typing function calls and template arguments
- **Auto-Completion** — Context-aware suggestions for symbols, keywords, and members
- **Inlay Hints** — Inline type annotations for `auto` variables and parameter names

### Code Quality
- **Semantic Highlighting** — Rich, accurate syntax coloring based on symbol types
- **Template Instantiation** — Full type resolution through generic types
- **Diagnostics** — Extension health monitoring and troubleshooting tools

## Getting Started

### Installation

1. Install the extension from the VS Code marketplace (or build from source)
2. Open a folder containing `.k` or `.pd` files
3. The extension activates automatically and indexes all Kanagawa files

### Supported File Extensions

| Extension | Description |
|-----------|-------------|
| `.k` | Kanagawa source files |
| `.pd` | Kanagawa definition files |

### First-Time Setup

On first activation, the extension scans your workspace for Kanagawa files. Progress appears in the status bar. For large projects (1000+ files), initial indexing may take a few seconds.

## Configuration

Configuration comes from two sources: a project-level `kanagawa.config.json` file and VS Code settings. The two sources are merged according to specific rules for each setting.

### Configuration Merging Rules

| Setting | Merge Behavior |
|---------|----------------|
| `importPaths` | **Combined** — Paths from both sources are merged and deduplicated. Project config paths are added first, then VS Code settings. |
| `stdlibPath` | **Override** — VS Code settings take precedence. If set in VS Code, the project config value is ignored. |
| `exclude` | **Combined** — Patterns from both sources are merged and deduplicated. |

This means:
- ✅ You can define shared import paths in `kanagawa.config.json` and add personal paths in VS Code settings
- ✅ Team members can check `kanagawa.config.json` into source control for consistent project configuration
- ✅ Individual developers can override `stdlibPath` in their VS Code settings without modifying project files

### Project Configuration (`kanagawa.config.json`)

Create a `kanagawa.config.json` file in your workspace root for project-specific settings that should be shared with your team:

```json
{
    "importPaths": [
        "../shared-lib",
        "vendor/third-party"
    ],
    "stdlibPath": ".kanagawa/stdlib",
    "exclude": [
        "**/generated/**",
        "**/*.gen.k"
    ]
}
```

| Property | Type | Description |
|----------|------|-------------|
| `importPaths` | `string[]` | Directories to search for imported modules. Relative paths are resolved against the workspace root. Combined with VS Code settings. |
| `stdlibPath` | `string` | Standard library location. Overridden by VS Code settings if set there. |
| `exclude` | `string[]` | Glob patterns for files/folders to exclude from indexing. Combined with VS Code settings. |

> **Tip**: Check `kanagawa.config.json` into source control so all team members use consistent import paths.

### VS Code Settings

Settings under `kanagawa.*` in your VS Code `settings.json`. These can be set at User level (global) or Workspace level.

#### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `kanagawa.compiler.importPaths` | `string[]` | `[]` | Additional search paths for Kanagawa imports. **Combined** with `kanagawa.config.json` paths. |
| `kanagawa.compiler.stdlibPath` | `string` | `""` | Standard library location. **Overrides** `kanagawa.config.json` if set. |
| `kanagawa.index.exclude` | `string[]` | `[]` | Glob patterns to exclude from indexing. **Combined** with `kanagawa.config.json` patterns. |
| `kanagawa.inlayHints.typeHints.enabled` | `boolean` | `true` | Show inferred type hints for `auto` variable declarations. |
| `kanagawa.inlayHints.parameterNames.enabled` | `boolean` | `true` | Show parameter name hints at function call sites. |
| `kanagawa.inlayHints.templateParameterNames.enabled` | `boolean` | `true` | Show template parameter name hints at instantiation sites. |
| `kanagawa.signatureHelp.templateParameters.enabled` | `boolean` | `true` | Show template parameter signature help when typing `<`. |
| `kanagawa.outline.categoryFilter` | `string[]` | `[]` | Symbol categories to show in outline. Empty = all. Options: `module`, `class`, `struct`, `union`, `enum`, `function`, `method`, `variable`, `member`, `constant`, `alias`, `other`. |
| `kanagawa.outline.modulePrefix` | `string` | `""` | Only show symbols whose module path starts with this prefix. |
| `kanagawa.typePeek.enabled` | `boolean` | `false` | Show 'type: ...' CodeLens above `auto` declarations. Disabled by default since inlay hints provide inline type info. |

#### Examples

**Adding personal import paths** (combined with project config):
```json
{
    "kanagawa.compiler.importPaths": [
        "/home/me/my-kanagawa-libs"
    ]
}
```

**Overriding stdlib location** (ignores project config):
```json
{
    "kanagawa.compiler.stdlibPath": "/opt/kanagawa/stdlib"
}
```

**Exclude Patterns**
```json
{
    "kanagawa.index.exclude": [
        "**/generated/**",
        "**/*.gen.k",
        "test_vectors/**"
    ]
}
```
Glob patterns support `**` (any path depth), `*` (any characters), and `?` (single character).

**Inlay Hints**
```json
{
    "kanagawa.inlayHints.typeHints.enabled": true,
    "kanagawa.inlayHints.parameterNames.enabled": true,
    "kanagawa.inlayHints.templateParameterNames.enabled": true
}
```

**Outline Filtering**
```json
{
    "kanagawa.outline.categoryFilter": ["class", "function", "module"],
    "kanagawa.outline.modulePrefix": "data."
}
```

## Commands

Access via Command Palette (Ctrl+Shift+P):

### Index Management
| Command | Description |
|---------|-------------|
| `Kanagawa: Rebuild Index` | Force a complete workspace rescan (cancellable) |
| `Kanagawa: Clear Index` | Clear the symbol index |
| `Kanagawa: Show Index Stats` | Display indexing statistics |
| `Kanagawa: Toggle Index Verbose Logging` | Enable detailed indexing output |

### Outline & Navigation
| Command | Description |
|---------|-------------|
| `Kanagawa: Select Outline Categories` | Choose which symbol types appear in outline |
| `Kanagawa: Set Outline Module Prefix` | Filter outline to a module namespace |
| `Kanagawa: Clear Outline Module Prefix` | Remove outline module filter |

### Dependency Graph
| Command | Description |
|---------|-------------|
| `Kanagawa: Show Module Dependencies` | View import graph for current file |
| `Kanagawa: Show Full Dependency Graph` | View complete workspace dependency graph |
| `Kanagawa: Browse Module Dependencies` | Interactive module dependency explorer |

### Performance & Diagnostics
| Command | Description |
|---------|-------------|
| `Kanagawa: Show Diagnostics` | Display extension health status and configuration |
| `Kanagawa: Restart Extension` | Reinitialize Tree-sitter and rebuild index |
| `Kanagawa: Toggle Performance Logging` | Enable timing diagnostics |
| `Kanagawa: Show Performance Summary` | Display performance statistics |
| `Kanagawa: Clear Performance Stats` | Reset performance counters |
| `Kanagawa: Set Slow Operation Threshold` | Configure performance warning threshold |

### Developer Tools
| Command | Description |
|---------|-------------|
| `Kanagawa: Debug Parse Tree` | Show parse tree for current file |
| `Kanagawa: Show Inferred Type` | Display inferred type for a symbol |

## Large Project Tips

### Optimizing Indexing Performance

1. **Use exclude patterns**: Add `exclude` patterns to `kanagawa.config.json` to skip generated files, test vectors, or other non-source directories.

2. **Exclude build directories**: The extension automatically skips `build/`, `dist/`, `out/`, and `node_modules/`. Use custom patterns for additional exclusions.

3. **Use `kanagawa.config.json`**: Specify only the import paths you need rather than broad parent directories.

3. **Monitor with performance logging**: Use `Kanagawa: Toggle Performance Logging` to identify slow operations.

### Multi-Module Projects

For projects with multiple independent modules:

```json
{
    "importPaths": [
        "modules/core/src",
        "modules/io/src",
        "modules/dsp/src"
    ]
}
```

### Sharing Configuration

Check `kanagawa.config.json` into source control so all team members use consistent import paths.

## Troubleshooting

### Quick Recovery Steps

If the extension isn't working correctly, try these steps in order:

1. **Run diagnostics**: `Kanagawa: Show Diagnostics` — Shows extension health and configuration
2. **Rebuild index**: `Kanagawa: Rebuild Index` — Re-scans all workspace files
3. **Restart extension**: `Kanagawa: Restart Extension` — Reinitializes Tree-sitter and index
4. **Reload window**: `Developer: Reload Window` — Full VS Code reload

### Extension Not Activating

1. Ensure you have a `.k` or `.pd` file in your workspace
2. Check the Output panel (View → Output → "Kanagawa Index")
3. Look for "Kanagawa LSP-Lite is activating..." message
4. Run `Kanagawa: Show Diagnostics` to check initialization status

### Symbols Not Found

1. Run `Kanagawa: Rebuild Index` to force a rescan
2. Verify `kanagawa.config.json` import paths are correct
3. Check `Kanagawa: Show Index Stats` to see indexed file count
4. Ensure the file is within workspace or configured import paths

### Slow Performance

1. Enable performance logging: `Kanagawa: Toggle Performance Logging`
2. Check for operations exceeding threshold in "Kanagawa Performance" output
3. Adjust threshold with `Kanagawa: Set Slow Operation Threshold`
4. Consider narrowing import paths to reduce indexed file count

### Go to Definition Not Working

1. Ensure the target file is within the workspace or import paths
2. For member expressions (`obj.method`), verify the receiver's type is inferrable
3. Check hover on the symbol—if type shows "unknown", type inference may need the definition indexed
4. Run `Kanagawa: Show Diagnostics` to verify Tree-sitter is initialized

### Tree-sitter Not Initialized

If diagnostics shows "Tree-sitter: NOT INITIALIZED":

1. Try `Kanagawa: Restart Extension`
2. Check Output panel for WASM loading errors
3. Ensure the extension installed completely (check for `tree-sitter-kanagawa.wasm` in extension folder)
4. As a last resort, reinstall the extension

## Known Limitations

- **No semantic error checking**: The extension provides syntax highlighting and navigation but does not perform type checking or semantic validation
- **No code formatting**: Auto-formatting is not yet implemented
- **Hardcoded exclusions**: Build directories (`build/`, `dist/`, `out/`) are always excluded from indexing

## Technical Details

### Architecture

The extension uses an "LSP-Lite" architecture:
- **Tree-sitter parsing**: Fast, incremental parsing with error recovery
- **In-memory indexing**: Symbol index rebuilt on startup (typically <1 second for ~1000 files)
- **Query-based extraction**: Tree-sitter queries for semantic token classification

### Indexed Directory Exclusions

The following directories are automatically skipped during indexing:
- `.git`, `.hg`, `.svn`
- `node_modules`
- `build`, `dist`, `out`

## License

See LICENSE file.
