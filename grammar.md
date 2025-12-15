# Kanagawa grammar & syntax (repo-derived)

This document describes Kanagawa’s grammar **as implemented in this repository**, primarily from the Haskell front-end parser:

- `compiler/hs/lib/Language/Kanagawa/Parser.hs`
- `compiler/hs/lib/Language/Kanagawa/Parser/Lexer.hs`
- `compiler/hs/lib/Language/Kanagawa/Parser/Syntax.hs`

It also cross-checks the “approximately correct” Tree-sitter grammar used by the VS Code extension:

- `tools/editors/vscode-new/grammar/grammar.js`

…and uses the standard library and tests as real-world syntax examples:

- `library/**/*.k`, `test/**/*.k`

Because the Tree-sitter grammar is explicitly described as “approximate”, **when there’s a discrepancy, this doc treats the Haskell parser as the source of truth**.

---

## 0) How Kanagawa grammar differs from C/C++ (common pitfalls)

This section is intentionally explicit: many Kanagawa constructs _look_ C/C++-like, but the **accepted syntax** (and often the intent) differs.

### 0.1 Files are modules, not headers/translation units

- Kanagawa has a first-class `module` declaration with an export list, plus `import ... as ...`.
- Module names are dot-separated (and may include `-` inside segments). This is not C++ `namespace` syntax.
- There are two special modules: `.cmdargs` and `.options`.

### 0.2 Attributes are widely used and syntactically significant

- Kanagawa uses `[[...]]` heavily to express scheduling/latency/concurrency and memory intent.
- Attributes can appear in places that would be unusual in C++:
  - before a **function declaration/definition** (e.g. `[[async]]`)
  - before a **call expression** (e.g. `[[call_rate(1)]] foo(...)`)
  - before a **statement** (e.g. `[[schedule(x)]] return ...;`)
  - inside a **type** (e.g. `[[memory, quad_port]] T[N]`)
    In C++, attributes exist, but they are not used this pervasively and are often ignorable; in Kanagawa they are part of the language’s core surface syntax.

### 0.3 Types are width-explicit and support type-level computation

- Integers are explicit-width: `uint32`, `int7`, etc.
- Width may be computed: `uint<clog2(N)+1>`.
- `float32` is the built-in float type surfaced in the parser.
- `string` is a built-in type.
- `decltype(expr)` is a first-class type form and is commonly used in `static if`.

### 0.4 Function types use `(...) -> T` and can appear directly in parameter lists

- Kanagawa has a function-type grammar: `(T1, T2) -> R`.
- You can write parameters that are _function-typed_ using that arrow form (e.g. `(() -> T fn)`), rather than C++’s function-pointer declarator syntax.

### 0.5 Templates look C++-like, but template-argument expressions are restricted

- Templates exist and resemble C++ (`template <typename T, auto N> ...`).
- To avoid ambiguity with `<` / `>` tokens, the compiler uses a restricted “template expression” mode for expressions inside `...< ... >`.
  Practical consequence: comparisons and shifts often need parentheses inside template arguments.

### 0.6 Control flow is a subset of C/C++ and includes Kanagawa-specific statements

- There is **no** C-style `for(init; cond; inc)` loop form in the compiler parser.
- Loop forms supported by the compiler parser are:
  - range-for: `for (const T i : limit) stmt`
  - do-while: `do stmt while (cond);`
  - compile-time: `static for (...) ...`
- There is **no** standalone `while (cond) stmt;` form.
- `atomic`, `reorder`, and `barrier` are statement forms (not C/C++ keywords with similar meanings).
- `++`/`--` exist as statement sugar (desugared to an assignment); they are not general-purpose expression operators in the compiler’s grammar.

### 0.7 Expressions include hardware-centric built-ins

- Built-in expression forms include `mux(...)`, `fan_out<...>(...)`, `lutmul(...)`, `concat(...)`, and `cast<...>(...)`.
- There is also a logical-xor operator `^^` (not a C/C++ operator).
- Strings support interpolation (`"{x}"`, `"{x=}\n"`), which is not a C/C++ feature.

---

## 1) Lexical structure

### 1.1 Whitespace

- Whitespace is generally insignificant and is skipped between tokens.
- Newlines are not statement terminators; `;` is.

### 1.2 Comments

Supported comment forms:

- Line comment: `// ...`
- Nested block comments: `/* ... /* ... */ ... */`
- Documentation comments (used by Sandcastle when enabled):
  - `//| ...` (doc “pre”)
  - `//< ...` (doc “post”)

### 1.3 Identifiers

Identifier (name) rules:

- Must start with `[A-Za-z_]`.
- Remaining characters: `[A-Za-z0-9_]`.
- Identifiers may **not** be reserved keywords.

Module-name segments are slightly different (used in `module`/`import`):

- Dot-separated segments.
- Each segment starts with `[A-Za-z_]`.
- Remaining characters can include `-` as well as alphanumerics and `_`.

Qualified names use `::`:

- Example: `device_schema::schema_version`

### 1.4 Keywords

The lexer’s reserved keyword list includes (non-exhaustive but representative):

- Declarations/types: `module`, `import`, `as`, `class`, `struct`, `union`, `enum`, `using`, `template`, `typename`, `extern`, `export`
- Built-in types: `void`, `bool`, `string`, `float32`, `auto`
- Statements: `if`, `else`, `switch`, `case`, `default`, `break`, `return`, `do`, `while`, `for`, `static`, `reorder`, `barrier`, `atomic`
- Built-ins: `cast`, `bitsizeof`, `bytesizeof`, `bitoffsetof`, `byteoffsetof`, `clog2`, `concat`, `fan_out`, `mux`, `lutmul`
- Literals: `true`, `false`
- Modifiers: `inline`, `noinline`

### 1.5 Operators and punctuation

Common operators:

- Arithmetic: `+ - * / %`
- Shifts: `<< >>`
- Bitwise: `& | ^ ~`
- Logical: `&& || !` and logical-xor `^^`
- Comparison: `== != < <= > >=`
- Ternary: `? :`
- Assignment: `=`, plus compound forms like `+=`, `<<=`, `&&=`
- Member/qualification: `.`, `::`

Punctuation:

- Grouping: `()`, `{}`, `[]`, `<>` (templates)
- Separators: `,`, `:`, `;`

### 1.6 Literals

#### Integers

Integer literals support bases and `_` separators:

- Decimal: `123`, `1_000_000`
- Hex: `0xDEAD_BEEF`
- Binary: `0b1010_0110`
- Octal: `0o755`

Optional **explicit width/signedness suffix**:

- `123i32`, `0xffu16`

Notes:

- `_` is allowed as a digit separator _inside_ the digits (e.g. `0xDEAD_BEEF`).
- The compiler-side lexer expects the `iN`/`uN` suffix to come immediately after the digits.

#### Floats

Float literals (Haskell parser uses Megaparsec’s float lexer):

- `1.0`, `3.14`, `1e-3`

#### Booleans

- `true`, `false`

#### Strings + interpolation

Strings are double-quoted and support interpolation segments:

- `"plain"`
- `"{x}"`
- `"{foo=}\n"` (print variable name + value)

Inside an interpolation `{ ... }` the Haskell parser supports:

- An expression
- Optional `=` (recorded as a flag, commonly used for `name=value` printing)
- Optional `, <expr>` (an additional expression argument)
- Optional format `:b|o|d|x|X` with optional precision digits (e.g. `:x8`)

See `library/debug/print.k` for examples.

---

## 2) Module system

### 2.1 Module declaration

A file can either be:

- A `module` declaration, or
- A sequence of top-level declarations (optionally preceded by `import`s)

Module declaration syntax:

```kanagawa
module my.module.name {
  exported_symbol,
  module other.module,
  module a.module \ b.module
}

// declarations…
```

Notes:

- Two special module names exist: `.cmdargs` and `.options`.
- Exports can include plain identifiers, re-exported modules (`module X`), and “module differences” (`module A \ B`).

C/C++ difference notes:

- This is not C++ `namespace` syntax and does not use `#include`.
- `module` exports are explicit and live in the module header block.

### 2.2 Imports

```kanagawa
import some.module
import some.other.module as alias
```

Imports are processed before parsing declarations, and the parser updates the symbol table based on imported modules.

---

## 3) Attributes (`[[...]]`)

Kanagawa uses C++-style attribute blocks. In the Haskell parser, attribute _sequences_ are parsed with **double brackets** and can be chained:

- `[[a, b]]`
- `[[a]][[b]]`
- `[[a]][[b, c]]`

Attributes are context-dependent: different constructs accept different attribute names.

### 3.1 Function and function-type attributes

Common function attributes used in the repo:

- `[[async]]`
- `[[pipelined]]`
- `[[unordered]]`
- `[[no_backpressure]]`
- `[[latency(N)]]`, `[[max_threads(N)]]`, `[[thread_rate(N)]]`
- `[[reset]]`, `[[pure]]`

Example:

```kanagawa
[[pipelined, async]] void loop(auto tid) { /* ... */ }
```

### 3.2 Call-site attributes

Call-site attributes are written immediately before a call:

- `[[call_rate(N)]]`
- `[[fifo_depth(N)]]`
- `[[transaction_size(N)]]`

Example shape:

```kanagawa
[[call_rate(1), fifo_depth(8)]] foo(x, y);
```

### 3.3 Statement attributes

Statements can be annotated; the Haskell parser recognizes `schedule(...)`:

```kanagawa
[[schedule(pipeline_cycles)]]
return foo;
```

### 3.4 Loop attributes

Loop attributes (seen in the parser and library) include:

- `[[unordered]]`
- `[[reorder_by_looping]]`
- `[[fifo_depth(N)]]`

These may appear before `for (...)` and `do ... while (...)` forms.

### 3.5 Memory/array attributes

Array types may be prefixed by memory attributes (example from the repo):

```kanagawa
using memory_quad_port = [[memory, quad_port]] T[N];
```

Recognized flags include `initialize`, `memory`, `non_replicated`, `quad_port`, and ECC configuration.

---

## 4) Types

### 4.1 Primitive/built-in types

- `void`
- `bool`
- `string`
- `float32`
- `auto`

### 4.2 Integer types

Kanagawa uses explicit-width integer types.

Fixed-width:

- `int32`, `int1`, `uint64`, …

C/C++ difference notes:

- Unlike C/C++, `int`/`uint` are not “machine-width”; width is explicit (`uint32`) or computed (`uint<...>`).
- The compiler grammar does not include C/C++ pointer declarators (`*`) or reference declarators (`&`) as part of the type syntax.

Parameterized width (width is an expression in angle brackets):

- `int<bitsizeof(T)>`
- `uint<clog2(N)+1>`

### 4.3 Const types

```kanagawa
const uint32
const MyType
```

### 4.4 Array types

```kanagawa
T[N]
T[M][N]
[[memory]] T[N]
```

The size expressions are general expressions.

### 4.5 Function types

Function types use an arrow:

```kanagawa
() -> T
(uint32 x, bool y) -> void
```

Function-type parameters may include an optional parameter name.

Function types can also carry function-type attributes (e.g. async/latency) in front of the type.

Example from the repo:

```kanagawa
template <typename T>
inline auto wait(() -> T fn) { /* ... */ }
```

### 4.6 Named and qualified type specifiers

Named types refer to previously declared types or imported types:

- `optional<T>`
- `P::pair<bool, T>`

Qualification uses `::`, and dependent template disambiguation can use the `template` keyword:

- `Foo::template Bar<T>`

### 4.7 `typename` and `decltype`

- `typename Some::DependentType`
- `decltype(expr)`

`decltype` is used both for type-level computations and in `static if` conditions, e.g.:

```kanagawa
static if (decltype(x) == string) { /* ... */ }
```

### 4.8 Types as expressions (type-level values)

The expression grammar accepts types as primary terms so that they can be used in type-level computations (e.g. comparisons inside `static if`, template arguments). A _bare_ type as a full expression statement is rejected, but a type may appear as a subexpression:

- Allowed: `decltype(x) == string`
- Not meaningful as a value statement: `string;`

---

## 5) Top-level and member declarations

### 5.1 Variable declarations

General shape:

```kanagawa
<type> name;
<type> name = <expr>;
```

Where `<type>` can be any type form above.

Scope-specific forms used by the parser:

- Global variable declarations
- Local variable declarations
- `static` local variables

Example:

```kanagawa
static uint32 counter = 0;
```

### 5.2 Type alias declarations

```kanagawa
using Name = Type;
```

Templates are allowed:

```kanagawa
template <typename T>
using Opt = optional<T>;
```

### 5.3 Enum declarations

Enums specify an explicit underlying type:

```kanagawa
enum Backend : uint2 {
  A = 0,
  B = 1,
};
```

Enum constants may omit explicit values.

### 5.4 Struct and union declarations

Structs/unions contain member variable declarations:

```kanagawa
struct optional {
  bool is_valid;
  T value;
}
```

Templates are supported (see `library/data/optional.k`).

### 5.5 Class declarations

Classes contain member declarations:

- Access labels: `private:` and `public:`
- Member variables
- Member functions
- Nested type declarations (struct/union/enum/class, aliases, templates)
- `default = <expr>;` initialization blocks

Example pattern (simplified):

```kanagawa
class Foo {
public:
  uint32 x;
  inline void f() { return; }
}
```

### 5.6 Function declarations/definitions

Function definition shape:

```kanagawa
[[attrs]] inline <return_type> name(<params>) { <body> }
```

Parameters:

```kanagawa
(<type> a, <type> b)
(<type> a = <default_expr>)
```

Member functions inside classes may be declared without a body in some cases (the parser distinguishes full definitions vs declarations).

### 5.7 Templates

Template declarations wrap other declarations:

```kanagawa
template <typename T, auto N>
struct array { /* ... */ }

template <typename T>
inline T id(T x) { return x; }
```

Template parameters supported by the Haskell parser include:

- Type parameters: `typename T` (optional default `= Type`)
- Non-type parameters: `<type> N` (optional default `= <expr>`)
- Template-template parameters: `template <...> typename TT` (optional default)

### 5.8 `export` and `extern`

The Haskell parser supports attribute-qualified export/extern type declarations:

```kanagawa
[[name("_test_runner_main")]]
export SomeType;

[[name("foo")]]
extern SomeExternType;
```

In practice, extern/export usage is tied to the backend’s notion of exported Verilog-visible types and external entities.

---

## 6) Statements

Statements appear in blocks `{ ... }`. The parser allows a mixture of statements and declarations inside blocks.

### 6.1 Empty and expression statements

- Empty: `;`
- Expression statement: `<expr>;`

### 6.2 `return`

- `return;`
- `return <expr>;`

### 6.3 `barrier`

```kanagawa
barrier;
```

### 6.4 `atomic` and `reorder`

These are statement prefixes:

```kanagawa
atomic { /* ... */ }
reorder do { /* ... */ } while (cond);
```

### 6.5 `if` / `else`

```kanagawa
if (cond) stmt
else stmt
```

### 6.6 `switch`

The Haskell parser’s `switch` form is:

```kanagawa
switch (expr) {
  case 0:
    /* statements/declarations */
    break;
  default:
    /* statements/declarations */
    break;
}
```

Notable: the parser expects `break;` in each case/default block.

C/C++ difference notes:

- The compiler parser’s `switch` form is closer to a structured `case ... break;` block; it expects `break;` terminators.

### 6.7 Loops

#### Range-for

```kanagawa
[[loop_attrs]]
for (const <type> i : limit_expr) stmt
```

Example from the repo:

```kanagawa
static for (const auto i : N) barrier;
```

#### Do-while

```kanagawa
[[loop_attrs]]
do stmt while (cond);
```

Example pattern from `library/control/wait.k`:

```kanagawa
atomic do {} while (!fn())
```

C/C++ difference notes:

- There is no C-style `for(init; cond; inc)`.
- There is no standalone `while (cond) stmt;` in the compiler grammar; looping uses `do ... while` (plus range-for and `static for`).

### 6.8 Compile-time control flow

#### Static assert

Two spellings are accepted:

```kanagawa
static assert(expr);
static_assert(expr);
```

A large number of examples exist in the library (e.g. `library/base/system.k`).

#### Static if

```kanagawa
static if (cond) <stmt-or-decl>
else <stmt-or-decl>
```

The branches may be blocks or single statements, and the parser permits declarations in those positions.

#### Static for

```kanagawa
static for (const <type> i : limit_expr) <stmt-or-decl>
```

---

## 7) Expressions

### 7.1 Primary expressions

- Identifiers and qualified identifiers: `x`, `ns::x`, `T::template f<int>`
- Literals: integers, floats, bools, strings, interpolated strings
- Parenthesized: `(expr)`
- Initializer lists:
  - Positional: `{a, b, c}`
  - Designated: `{.field = value, .other = expr}`
- Type literals (see “Types as expressions”): `uint32`, `decltype(x)`

### 7.2 Member access and indexing

- Member access: `expr.member`
- Array/index access: `expr[index]`

These can chain: `x.a[cast<uint3>(i)].b`.

### 7.3 Calls

Function calls:

```kanagawa
foo(a, b)
ns::foo(a)
```

Call-site attribute blocks can precede the call.

Method calls are written with `.` as usual (`obj.method(args)`), but the parser resolves method names based on the receiver’s type.

### 7.4 Built-in expression forms

These parse as special AST nodes:

- `cast<Type>(expr)`
- `mux(sel, a, b, ...)` (ternary `?:` desugars to a mux)
- `concat(a, b, ...)`
- `fan_out<N>(expr)`
- `lutmul(a, b)`
- `static(expr)`
- `bitoffsetof(Type, member)`
- `byteoffsetof(Type, member)`

### 7.5 Operator precedence and associativity

From the Haskell `makeExprParser` table (highest to lowest):

1. Unary prefix:
   - `-x`
   - `!x`, `~x`
   - `bitsizeof x`, `bytesizeof x`, `clog2 x`
2. Multiplicative: `* / %`
3. Additive: `+ -`
4. Shifts: `<< >>`
5. Relational: `< >` (and also `<= >=`)
6. Equality: `== !=`
7. Bitwise AND: `&`
8. Bitwise XOR: `^`
9. Bitwise OR: `|`
10. Logical AND: `&&`
11. Logical XOR: `^^`
12. Logical OR: `||`
13. Ternary: `cond ? a : b` (desugars to a mux)

Associativity notes:

- Most binary operators are left-associative.
- Comparisons (`<`, `>`, `<=`, `>=`, `==`, `!=`) are non-associative.
- Ternary is right-associative.

### 7.6 Assignment and update statements

Assignments appear as statements and support compound operators:

- `=`
- `+= -= *= /= %= <<= >>= &= |= ^= &&= ||= ^^=`

Increment/decrement exist in the Haskell parser as **statement sugar** and are desugared to `x = x ± 1`:

- `x++`, `++x`, `x--`, `--x` (as standalone statements)

### 7.7 Template argument expressions (disambiguation rule)

Kanagawa uses `<...>` for template arguments, which conflicts with `<`/`>` comparison operators.

To avoid ambiguity, the parser uses a restricted “template expression” mode for expressions that appear inside `int<...>`, `uint<...>`, and template argument lists. In that mode, top-level `<`, `>`, `<<`, `>>` operators are disallowed unless parenthesized.

Practical rule:

- Prefer parentheses around comparisons in template arguments.

---

## 8) Notes on Tree-sitter vs compiler parser

The VS Code Tree-sitter grammar is useful for editor features, but it is not authoritative.
Examples of potential mismatch areas to watch for:

- Some constructs exist only for editor parsing convenience.
- Some forms in the Tree-sitter grammar may accept syntax that the Haskell parser doesn’t (or vice versa).

If you’re unsure whether a construct is truly supported by the compiler, validate it against `compiler/hs/lib/Language/Kanagawa/Parser.hs` and a real `.k` file in `library/` or `test/`.
