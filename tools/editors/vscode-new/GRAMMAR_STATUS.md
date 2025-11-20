# Kanagawa Tree-Sitter Grammar Status

## Summary

The Tree-Sitter grammar for Kanagawa has been comprehensively rewritten to align with the Haskell reference implementation in `compiler/hs/lib/Language/Kanagawa/Parser.hs`. The grammar now successfully parses the majority of the standard library files.

## Test Results

Based on testing with library files:
- **25+ files** parse with **0 errors** including:
  - `base.k` ✅
  - `data/fifo.k` ✅
  - `data/memory.k` ✅
  - `data/counter.k` ✅
  - `control/wait.k` ✅
  - All device configuration files ✅

- Files with minor issues (< 5 errors): `control/loop.k`, `control/async.k`
- Files with moderate issues: `data/bits.k`, `data/array.k`

**Overall Coverage**: ~50% of library files parse perfectly, ~80% parse with minor issues.

## Major Grammar Features Implemented

### ✅ Complete

1. **Module System**
   - Module declarations with exports
   - Import statements
   - Module name paths

2. **Type System**
   - Primitive types (`int`, `uint`, `bool`, `float32`, `void`, `string`)
   - Sized integer types (`int<N>`, `uint<N>`)
   - Type specifiers and qualified types
   - Const types
   - Array types (including multi-dimensional: `int[3][2]`) ✅ **Fixed**
   - Function types with optional parameter names: `(T) -> void`
   - Attributed types

3. **Templates**
   - Template parameters (typename, auto, type, template-template)
   - Template arguments (with restricted expressions to avoid `<`/`>` ambiguity)
   - Template classes, structs, unions, functions

4. **Classes, Structs, Unions**
   - Definitions with member declarations
   - Template versions
   - Access modifiers (public, private)
   - Member functions and variables

5. **Functions**
   - Function definitions with modifiers (inline, noinline, static, extern)
   - Template functions
   - Function types
   - Optional cast type parameters: `static_cast(value)` ✅

6. **Statements**
   - Expression statements
   - If/else, switch/case
   - For loops (including `unrolled_for`)
   - While, do-while
   - Atomic do-while (special Kanagawa construct)
   - Atomic, reorder, barrier
   - Return, break, continue

7. **Expressions**
   - 18 levels of operator precedence (matching C++)
   - Binary operators: `*`, `/`, `%`, `+`, `-`, `<<`, `>>`, `<`, `>`, `<=`, `>=`, `==`, `!=`, `&`, `^`, `|`, `&&`, `^^`, `||`
   - Unary operators: `-`, `!`, `~`
   - Call expressions
   - Member access (`.`, `->`)
   - Subscript `[...]`
   - Cast expressions (all 4 types)
   - Built-in functions: `mux`, `concat`, `fan_out`, `lutmul`
   - Lambda expressions

8. **Literals**
   - Integer literals (decimal, hex, binary) with optional type suffixes
   - Floating point literals
   - Boolean literals (`true`, `false`)
   - String literals with **interpolation**: `"value: {x}`, `"hex: {y:x}"`, etc.

9. **Comments**
   - Line comments (`//`)
   - Block comments (`/* */`)
   - Doc comments: `//|` (pre-doc) and `//<` (post-doc)

10. **Attributes**
    - General attributes: `[[attribute_name]]`
    - Memory attributes: `[[ecc]]`, `[[no_ecc]]`

11. **Static Constructs**
    - Static assert: `static assert(expr);`
    - Static if: `static if (cond) { ... }`
    - Static for: `static for (var : range) { ... }`

## Known Limitations

### 1. `assert` Function Calls ⚠️

**Issue**: The standalone `assert(expr)` function call doesn't parse correctly when there's whitespace between `assert` and `(`.

**Root Cause**: Tree-sitter treats `'assert'` in the `static assert` grammar rule as a keyword token, which prevents it from being used as a regular identifier.

**Workaround Attempted**: 
- Using `token(seq('static', /\s+/, 'assert'))` to make it a single token
- Adding `'assert'` to identifier alternatives
- Using dynamic precedence

**Status**: This primarily affects test files. The main library files that use `assert` can be parsed by:
- Using `assert(expr)` without space (works fine)
- Or accepting the parse error (doesn't break other features)

**Impact**: Affects ~10-15% of files in `test/library/`

### 2. Template Instantiation Array Types ⚠️ **CRITICAL**

**Issue**: Variable declarations with template instantiation array types parse incorrectly inside function bodies.

**Example**:
```kanagawa
void foo() {
    optional<T>[N] x;  // ❌ Parses as subscript expression, not variable declaration
    int[N] y;          // ✅ Works correctly (primitive type)
}
```

**Root Cause**: Tree-sitter's GLR parser sees `optional<T>[N]` and commits to parsing it as:
1. `template_instantiation` (expression) followed by
2. `subscript_expression` with index `[N]`

Before it considers the alternative:
1. `array_type` where base is `type_specifier` (`optional<T>`)

Even with:
- `prec.dynamic(100)` on `variable_decl`
- `prec.dynamic(20)` on `type_specifier`  
- `prec.dynamic(-10)` on `subscript_expression`
- `[$.variable_decl, $.primary_expression]` conflict declaration
- Explicit `seq($.variable_decl, ';')` in statement choices

The parser still prefers the subscript interpretation.

**Why Primitive Types Work**: `int` is not an expression, so `int[N]` can only be a type. But `optional` is a valid identifier that can appear in expressions.

**Impact**: Affects ~20% of standard library files including:
- `library/data/array.k` (multiple instances)
- `library/codec/crc.k`
- `library/control/async.k`
- `library/control/loop.k`

**Workaround**: Add a space before the bracket:
```kanagawa
optional<T> [N] x;  // ✅ Parses correctly with space
```

**Long-term Fix**: Requires either:
- External scanner for lookahead
- Grammar restructure to unify types/expressions
- Wait for Tree-sitter improvements

**Status**: **BLOCKING** for correct parsing of significant portions of standard library. This is a known limitation that will require substantial work to resolve properly.

### 3. Complex Generic/Template Edge Cases

Some heavily templated code with nested template arguments may have minor parsing issues due to the `<`/`>` ambiguity inherent in C++-style template syntax.

**Mitigation**: Template parameter default values use `_template_arg_expression` which excludes comparison operators.

### 3. Designated Initializers

While basic initializers work, complex designated initializers may have edge cases.

## Grammar Architecture

### Conflict Resolution

The grammar declares **30 conflicts** for inherent ambiguities in C-like syntax:
- Type vs expression contexts
- Template arguments vs comparisons  
- Modified types vs statements
- Attributed types vs call expressions
- Static modifiers vs static assert

### Precedence Levels

**18 precedence levels** for expressions, matching C++ semantics:
1. Reserved (special constructs)
2-4. Logical operations (`||`, `^^`, `&&`)
5-8. Bitwise operations (`|`, `^`, `&`)
9. Equality (`==`, `!=`)
10. Relational (`<`, `>`, `<=`, `>=`)
11. Shift (`<<`, `>>`)
12. Additive (`+`, `-`)
13. Multiplicative (`*`, `/`, `%`)
14-15. Casts and sizeof operations
16. Unary (`-`, `!`, `~`)
17. Member access
18. Primary expressions (highest)

## Extension Integration Status

### ✅ Working
- WASM parser loads correctly
- Syntax tree generation
- Parse tree debugging command

### ⚠️ Needs Verification
- Hover provider (implemented, needs testing)
- Go-to-definition (implemented, needs testing)
- Document symbols/outline (implemented, needs testing)
- Semantic tokens (implemented, needs testing)
- Workspace indexer (implemented, needs testing)

### 📝 Implementation Notes

**Queries Updated**:
1. `highlights.scm` - 200+ lines, complete token coverage
2. `definitions.scm` - 55+ lines, all symbol types
3. `outline.scm` - 40+ lines, document structure

**TypeScript Providers**:
- All providers updated to use new grammar node names
- SemanticTokensProvider has 21 token types
- Indexer handles template definitions correctly

## Next Steps

### High Priority
1. ✅ Fix multi-dimensional arrays - **COMPLETED**
2. 🔄 Test and verify extension features (hover, go-to-def) - **IN PROGRESS**
3. 🔄 Ensure queries are properly loaded and cached

### Medium Priority
4. ⏳ Resolve `assert` keyword conflict (may require external scanner)
5. ⏳ Add more comprehensive tests for complex templates
6. ⏳ Profile and optimize workspace indexing performance

### Low Priority
7. ⏳ Add folding ranges for comments
8. ⏳ Implement snippet suggestions
9. ⏳ Add signature help for function calls

## Build Instructions

```powershell
# Navigate to grammar directory
cd tools/editors/vscode-new/grammar

# Generate parser from grammar
npx tree-sitter generate

# Build WASM using Docker (required due to emscripten complexity)
docker run --rm -v "$($PWD.Path):/src" -w /src emscripten/emsdk emcc -o tree-sitter-kanagawa.wasm src/parser.c -Isrc -s WASM=1 -s SIDE_MODULE=1 -s EXPORTED_FUNCTIONS="['_tree_sitter_kanagawa']" -O3

# Move WASM to dist
Move-Item -Force tree-sitter-kanagawa.wasm ../dist/

# Build extension (in vscode-new directory)
cd ..
npm run compile
```

## Testing

```powershell
# Test grammar on specific file
npx tree-sitter parse path/to/file.k

# Test query on file
npx tree-sitter query queries/definitions.scm path/to/file.k

# Count errors in file
(npx tree-sitter parse path/to/file.k 2>&1) -match 'ERROR' | Measure-Object | Select-Object -ExpandProperty Count
```

## References

- **Grammar Source**: `tools/editors/vscode-new/grammar/grammar.js`
- **Haskell Parser**: `compiler/hs/lib/Language/Kanagawa/Parser.hs`
- **Language Spec**: `overview.md`
- **Test Corpus**: `library/**/*.k`
