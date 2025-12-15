# Integration Test Report

## Overall Summary

| Stage | Passed | Failed | Rate |
|-------|--------|--------|------|
| CST Parse | 464 | 4 | 99.1% |
| AST Lower | 438 | 26 | 94.4% |
| HIR Lower | 438 | 0 | 100.0% |
| **Full Pipeline** | **438** | **30** | **93.6%** |

## Results by Directory

| Directory | Total | CST | AST | HIR |
|-----------|-------|-----|-----|-----|
| library/base | 1 | 1 | 1 | 1 |
| library/base.k | 1 | 1 | 1 | 1 |
| library/codec | 1 | 1 | 1 | 1 |
| library/compiler | 5 | 5 | 5 | 5 |
| library/control | 6 | 6 | 6 | 6 |
| library/data | 40 | 40 | 40 | 40 |
| library/debug | 2 | 2 | 2 | 2 |
| library/device | 21 | 21 | 21 | 21 |
| library/intel | 4 | 4 | 4 | 4 |
| library/mini-base.k | 1 | 1 | 1 | 1 |
| library/numeric | 21 | 21 | 21 | 21 |
| library/processor | 6 | 6 | 6 | 6 |
| library/sync | 4 | 4 | 4 | 4 |
| library/test | 4 | 4 | 4 | 4 |
| library/type | 5 | 5 | 5 | 5 |
| library/xilinx | 2 | 2 | 2 | 2 |
| test/interface | 17 | 17 | 17 | 17 |
| test/library | 55 | 55 | 55 | 55 |
| test/logic | 104 | 104 | 100 | 100 |
| test/syntax | 168 | 164 | 142 | 142 |

## CST Parse Failures (4 files)

- `test/syntax/imports/a1/a21.k`: 3 diagnostic(s): [Diagnostic { severity: Error, message: "Expected module name segment", span: Span { start: 97, end: 98 } }, Diagnostic { severity: Error, message: "Expected ',' or '}' in module export list", span: Span { start: 99, end: 99 } }, Diagnostic { severity: Error, message: "Expected RBrace", span: Span { start: 99, end: 99 } }]
- `test/syntax/imports/binary.k`: Failed to read file: stream did not contain valid UTF-8
- `test/syntax/imports.k`: 1 diagnostic(s): [Diagnostic { severity: Error, message: "Expected module name segment", span: Span { start: 12032, end: 12033 } }]
- `test/syntax/options.k`: 1 diagnostic(s): [Diagnostic { severity: Error, message: "Expected module name segment", span: Span { start: 753, end: 753 } }]

## AST Lowering Failures (26 files)

- `test/logic/test_cases_14.k`: MissingChild("binary expression operands")
- `test/logic/test_cases_16.k`: MissingChild("for body")
- `test/logic/test_cases_21.k`: MissingChild("call callee")
- `test/logic/test_cases_26.k`: MissingChild("call callee")
- `test/syntax/atomic.k`: MissingChild("assignment expression operands")
- `test/syntax/auto-placeholder.k`: MissingChild("assignment lhs")
- `test/syntax/basics.k`: MissingChild("assignment lhs")
- `test/syntax/callbacks.k`: MissingChild("annotated statement body")
- `test/syntax/closures.k`: MissingChild("assignment lhs")
- `test/syntax/constexpr.k`: MissingChild("call callee")
- `test/syntax/dependent-template.k`: MissingChild("function name")
- `test/syntax/designated-initializer.k`: MissingChild("assignment expression operands")
- `test/syntax/enum.k`: MissingChild("assignment lhs")
- `test/syntax/function-attributes.k`: MissingChild("annotated statement body")
- `test/syntax/function-type.k`: MissingChild("function name")
- `test/syntax/higher-order-functions.k`: MissingChild("function name")
- `test/syntax/local-functions.k`: MissingChild("annotated statement body")
- `test/syntax/statement.k`: MissingChild("assignment lhs")
- `test/syntax/static-if.k`: MissingChild("function name")
- `test/syntax/string.k`: MissingChild("function name")
- ... and 6 more

