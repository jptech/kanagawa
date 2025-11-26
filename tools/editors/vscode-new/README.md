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

### Code Intelligence
- **Hover Information** — See type signatures, documentation, and module paths
- **Signature Help** — Parameter hints while typing function calls and template arguments
- **Auto-Completion** — Context-aware suggestions for symbols, keywords, and members
- **Inlay Hints** — Inline type annotations for `auto` variables and parameter names

### Code Quality
- **Semantic Highlighting** — Rich, accurate syntax coloring based on symbol types
- **Template Instantiation** — Full type resolution through generic types

## Getting Started

### Installation

1. Install the extension from the VS Code marketplace (or build from source)
2. Open a folder containing `.k` files
3. The extension activates automatically and indexes all Kanagawa files

### First-Time Setup

On first activation, the extension scans your workspace for `.k` files. Progress appears in the status bar. For large projects (1000+ files), initial indexing may take a few seconds.

## Configuration

### Project Configuration (`kanagawa.config.json`)

Create a `kanagawa.config.json` file in your workspace root to configure project-specific settings:

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
| `importPaths` | `string[]` | Additional directories to search for imported modules. Relative paths are resolved against the workspace root. |
| `stdlibPath` | `string` | Override for the standard library location. |
| `exclude` | `string[]` | Glob patterns for files/folders to exclude from indexing. |

### VS Code Settings

Settings under `kanagawa.*` in your VS Code `settings.json`:

#### Import Paths
```json
{
    "kanagawa.compiler.importPaths": [
        "/path/to/external/library"
    ],
    "kanagawa.compiler.stdlibPath": "/path/to/stdlib"
}
```
User settings take precedence over workspace `kanagawa.config.json` values.

#### Exclude Patterns
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

#### Inlay Hints
```json
{
    "kanagawa.inlayHints.typeHints.enabled": true,
    "kanagawa.inlayHints.parameterNames.enabled": true,
    "kanagawa.inlayHints.templateParameterNames.enabled": true
}
```

#### Outline Filtering
Filter the document outline to show only specific symbol types:
```json
{
    "kanagawa.outline.categoryFilter": ["class", "function", "module"],
    "kanagawa.outline.modulePrefix": "data."
}
```

#### Performance
```json
{
    "kanagawa.typePeek.enabled": false
}
```

## Commands

Access via Command Palette (Ctrl+Shift+P):

| Command | Description |
|---------|-------------|
| `Kanagawa: Rebuild Index` | Force a complete workspace rescan |
| `Kanagawa: Clear Index` | Clear the symbol index |
| `Kanagawa: Show Index Stats` | Display indexing statistics |
| `Kanagawa: Select Outline Categories` | Choose which symbol types appear in outline |
| `Kanagawa: Set Outline Module Prefix` | Filter outline to a module namespace |
| `Kanagawa: Show Module Dependencies` | View import graph for current file |
| `Kanagawa: Toggle Performance Logging` | Enable timing diagnostics |
| `Kanagawa: Show Performance Summary` | Display performance statistics |

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

### Extension Not Activating

1. Ensure you have a `.k` file in your workspace
2. Check the Output panel (View → Output → "Kanagawa Parse Tree")
3. Look for "Kanagawa LSP-Lite is activating..." message

### Symbols Not Found

1. Run `Kanagawa: Rebuild Index` to force a rescan
2. Verify `kanagawa.config.json` import paths are correct
3. Check `Kanagawa: Show Index Stats` to see indexed file count

### Slow Performance

1. Enable performance logging: `Kanagawa: Toggle Performance Logging`
2. Check for operations exceeding 100ms in the Kanagawa Performance output
3. Consider narrowing import paths to reduce indexed file count

### Go to Definition Not Working

1. Ensure the target file is within the workspace or import paths
2. For member expressions (`obj.method`), verify the receiver's type is inferrable
3. Check hover on the symbol—if type shows "unknown", type inference may need the definition indexed

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

## Contributing

See [ARCHITECTURE_LESSONS.md](ARCHITECTURE_LESSONS.md) for development patterns and anti-patterns discovered during development.

See [DEBUGGING.md](DEBUGGING.md) for extension debugging techniques.

## License

See [LICENSE](LICENSE) file.
