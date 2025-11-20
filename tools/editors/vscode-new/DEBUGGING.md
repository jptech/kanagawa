# Debugging the Kanagawa VS Code Extension

## Quick Diagnostics

### 1. Check Extension Activation

Open the Output panel (View → Output) and select "Kanagawa Parse Tree" or look at the developer console (Help → Toggle Developer Tools).

Expected messages:
```
Kanagawa "LSP-Lite" is activating...
Kanagawa: Indexed X symbols from Y files.
```

### 2. Verify WASM Loading

If you see errors about loading WASM or parser initialization:

```typescript
// Check in browser console (Help → Toggle Developer Tools)
// Should NOT see: "Failed to load WASM" or similar
```

**Fix**: Ensure `dist/tree-sitter-kanagawa.wasm` exists and is in the extension package.

### 3. Test Parse Tree Command

1. Open any `.k` file
2. Run command: `Kanagawa: Debug Parse Tree` (Ctrl+Shift+P)
3. Check the output channel

Expected: S-expression syntax tree
```
(source_file
  (module_decl
    name: (module_name ...)
    ...
```

If empty or error → WASM/parser issue

### 4. Check Query Loading

Add logging to `src/service/query.ts`:

```typescript
async loadQuery(name: string): Promise<string> {
    console.log(`Loading query: ${name}`);
    // ... existing code ...
    console.log(`Query ${name} loaded, length: ${content.length}`);
}
```

Expected console output when opening a file:
```
Loading query: highlights
Query highlights loaded, length: 5234
Loading query: definitions  
Query definitions loaded, length: 1856
```

### 5. Verify Semantic Tokens

If syntax highlighting seems off:

1. Check if semantic tokens provider is registered
2. Verify TOKEN_TYPES array matches your highlight query captures
3. Use command palette: "Developer: Inspect Editor Tokens and Scopes"

### 6. Test Go-to-Definition

1. Create a simple test file:
```kanagawa
module test { MyClass }

class MyClass {
    int x;
};

inline void test() {
    MyClass obj; // Ctrl+Click on MyClass
}
```

2. Ctrl+Click or F12 on `MyClass` in the function
3. Should jump to class definition

**If not working**:
- Check indexer is scanning: Look for "Indexed X symbols" message
- Check symbol is in index: Add logging to `indexer.getSymbols()`
- Verify definition query matches: `npx tree-sitter query queries/definitions.scm test.k`

### 7. Test Hover

1. Hover over a symbol (e.g., function name, class name)
2. Should see popup with definition and docs

**If not working**:
- Same debugging as go-to-definition
- Check doc comments are being extracted (look for `//|` or `//<`)
- Add logging to `hover.ts` provider

## Common Issues

### Issue: "No symbols found" / Go-to-Definition doesn't work

**Symptoms**: Hover shows nothing, go-to-definition doesn't jump

**Diagnosis**:
```typescript
// Add to indexer.ts scanWorkspace()
console.log('Symbol index:', Array.from(this.symbolIndex.keys()));
```

**Possible Causes**:
1. Query not loaded → Check query.ts logs
2. Query doesn't match grammar → Test with `npx tree-sitter query`
3. Files not scanned → Check file glob pattern `**/*.k`
4. Node names changed in grammar → Update queries

**Fix**: 
- Ensure queries use correct node names from current grammar
- Rebuild WASM after grammar changes
- Reload VS Code window (Ctrl+R)

### Issue: Syntax highlighting is wrong/missing

**Symptoms**: Keywords not colored, types look like variables

**Diagnosis**:
```typescript
// Add to semanticTokens.ts
console.log('Semantic token captures:', captures.map(c => c.name));
```

**Possible Causes**:
1. Highlights query doesn't match grammar nodes
2. TOKEN_TYPES array doesn't include needed types
3. Capture name mapping missing in switch statement

**Fix**:
- Update `highlights.scm` with correct node names
- Add missing token types to TOKEN_TYPES array
- Add mapping cases in provideDocumentSemanticTokens

### Issue: Files not parsing / lots of ERROR nodes

**Symptoms**: Parse tree command shows many ERROR nodes

**Diagnosis**:
```bash
# Test grammar directly
cd grammar
npx tree-sitter parse ../test-files/problematic.k

# Look for ERROR nodes
```

**Possible Causes**:
1. Grammar doesn't handle syntax construct
2. Recent grammar change introduced regression
3. File uses unsupported feature (e.g., `assert` with space)

**Fix**:
- Check GRAMMAR_STATUS.md for known limitations
- Test with simpler code to isolate issue
- File GitHub issue with minimal reproduction case

### Issue: Extension doesn't activate

**Symptoms**: No output, no features work

**Diagnosis**:
- Check "Extensions" view → Kanagawa extension shows errors
- Check Developer Tools console for errors
- Look at extension host log

**Possible Causes**:
1. WASM file missing from package
2. Activation event not firing (no `.k` files open)
3. TypeScript compilation error
4. Dependency issue

**Fix**:
```bash
# Rebuild everything
npm run compile
cd grammar
npx tree-sitter generate
# ... rebuild WASM ...
# Reload VS Code window
```

## Performance Debugging

### Slow Workspace Indexing

If indexing takes > 5 seconds:

```typescript
// Add timing to indexer.ts
const start = Date.now();
await this.indexFile(uri);
console.log(`Indexed ${uri.path} in ${Date.now() - start}ms`);
```

**Optimization**:
- Increase chunk size (currently 10)
- Filter out test files if not needed
- Consider lazy indexing (on-demand)

### Slow Semantic Token Updates

If typing feels laggy:

```typescript
// Add timing to semanticTokens.ts
const start = performance.now();
const tokens = this.buildTokens(captures);
console.log(`Built tokens in ${performance.now() - start}ms`);
```

**Optimization**:
- Tree-sitter should be fast (< 10ms for typical files)
- If slow, check query complexity
- Consider caching token results

## Testing Workflow

### End-to-End Test

1. Create `test.k`:
```kanagawa
//| A simple test class
class TestClass {
    int value;
};

inline void test_func() {
    TestClass obj;
    obj.value = 42;
}
```

2. Verify features:
   - ✅ Syntax highlighting: `class`, `int`, `inline` should be colored
   - ✅ Outline: Should show `TestClass` and `test_func` in outline view
   - ✅ Hover over `TestClass`: Should show "A simple test class"
   - ✅ Go-to-def on `TestClass` in function: Should jump to line 2
   - ✅ Document symbols: Breadcrumb should show structure

### Regression Testing

After grammar changes:

```bash
# Test suite of library files
cd grammar
for file in ../../../library/{base.k,data/fifo.k,control/loop.k}; do
    echo "Testing $file"
    npx tree-sitter parse "$file" 2>&1 | grep -c ERROR
done
```

Should see low/zero error counts for core library files.

## Useful Commands

```bash
# Regenerate everything
cd tools/editors/vscode-new/grammar
npx tree-sitter generate
docker run --rm -v "$($PWD.Path):/src" -w /src emscripten/emsdk emcc -o tree-sitter-kanagawa.wasm src/parser.c -Isrc -s WASM=1 -s SIDE_MODULE=1 -O3
mv tree-sitter-kanagawa.wasm ../dist/
cd ..
npm run compile

# Package extension for distribution
npx vsce package

# Test query interactively
npx tree-sitter query queries/highlights.scm test.k
```

## Getting Help

If issues persist:

1. Check GRAMMAR_STATUS.md for known limitations
2. Review TS_Extension.md for architecture
3. Look at git history for recent changes
4. File issue with:
   - Minimal `.k` code that reproduces issue
   - Parse tree output (`npx tree-sitter parse`)
   - Expected vs actual behavior
