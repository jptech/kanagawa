/**
 * Grammar and Parsing Tests for Kanagawa Tree-sitter Grammar
 */

import * as assert from 'assert';
import {
    initParser,
    parseCode,
    assertParsesCleanly,
    hasParseErrors,
    findNodeByType,
    findAllNodesByType,
} from './helpers';

describe('Kanagawa Grammar', function() {
    // Increase timeout for parser initialization
    this.timeout(30000);

    before(async () => {
        await initParser();
    });

    describe('Variable Declarations', () => {
        it('should parse simple variable declaration', () => {
            const tree = assertParsesCleanly('uint32 count = 0;');
            const varDecl = findNodeByType(tree.rootNode, 'variable_decl');
            assert.ok(varDecl, 'Should find variable_decl node');
            assert.strictEqual(varDecl.childForFieldName('name')?.text, 'count');
        });

        it('should parse auto variable', () => {
            const tree = assertParsesCleanly('auto x = 42;');
            const varDecl = findNodeByType(tree.rootNode, 'variable_decl');
            assert.ok(varDecl, 'Should find variable_decl node');
        });

        it('should parse templated array type in function body', () => {
            // This was a previously known issue - now resolved
            const tree = assertParsesCleanly('void foo() { optional<T>[N] x; }');
            const arrayType = findNodeByType(tree.rootNode, 'array_type');
            assert.ok(arrayType, 'Should parse as array_type, not subscript_expression');
        });

        it('should parse nested template array type', () => {
            const tree = assertParsesCleanly('FIFO<uint<32>>[8] fifo;');
            const arrayType = findNodeByType(tree.rootNode, 'array_type');
            assert.ok(arrayType, 'Should find array_type node');
        });

        it('should parse multi-dimensional array', () => {
            const tree = assertParsesCleanly('int[3][2] matrix;');
            const arrayType = findNodeByType(tree.rootNode, 'array_type');
            assert.ok(arrayType, 'Should find array_type node');
        });

        it('should parse const variable', () => {
            const tree = assertParsesCleanly('const uint32 MAX = 100;');
            const modifiedType = findNodeByType(tree.rootNode, 'modified_type');
            assert.ok(modifiedType, 'Should find modified_type (const) node');
        });

        it('should parse static variable', () => {
            const tree = assertParsesCleanly('static uint32 counter = 0;');
            const varDecl = findNodeByType(tree.rootNode, 'variable_decl');
            assert.ok(varDecl, 'Should find variable_decl node');
            const modifiers = varDecl?.childForFieldName('modifiers');
            assert.ok(modifiers, 'Should have modifiers field');
        });
    });

    describe('Cast Expressions', () => {
        it('should parse cast<Type>(value)', () => {
            const tree = assertParsesCleanly('auto x = cast<float>(y);');
            const castOp = findNodeByType(tree.rootNode, 'cast_operator');
            assert.ok(castOp, 'Should find cast_operator node');
        });

        it('should parse static_cast<Type>(value)', () => {
            const tree = assertParsesCleanly('auto v = static_cast<uint32>(val);');
            const castOp = findNodeByType(tree.rootNode, 'cast_operator');
            assert.ok(castOp, 'Should find cast_operator node');
        });

        it('should parse reinterpret_cast<Type>(value)', () => {
            const tree = assertParsesCleanly('auto b = reinterpret_cast<uint64>(ptr);');
            const castOp = findNodeByType(tree.rootNode, 'cast_operator');
            assert.ok(castOp, 'Should find cast_operator node');
        });

        it('should parse checked_cast<Type>(value)', () => {
            const tree = assertParsesCleanly('auto n = checked_cast<uint8>(wide);');
            const castOp = findNodeByType(tree.rootNode, 'cast_operator');
            assert.ok(castOp, 'Should find cast_operator node');
        });

        it('should parse cast without type argument', () => {
            const tree = assertParsesCleanly('auto r = cast(value);');
            const castOp = findNodeByType(tree.rootNode, 'cast_operator');
            assert.ok(castOp, 'Should find cast_operator node');
        });
    });

    describe('Member Expressions', () => {
        it('should parse simple method call', () => {
            const tree = assertParsesCleanly('auto result = obj.compute();');
            const memberExpr = findNodeByType(tree.rootNode, 'member_expression');
            assert.ok(memberExpr, 'Should find member_expression node');
        });

        it('should parse chained method calls', () => {
            const tree = assertParsesCleanly('auto val = a.b().c();');
            const memberExprs = findAllNodesByType(tree.rootNode, 'member_expression');
            assert.ok(memberExprs.length >= 2, 'Should find multiple member_expression nodes');
        });

        it('should parse method call with arguments', () => {
            const tree = assertParsesCleanly('auto sum = list.reduce(0, add);');
            const callExpr = findNodeByType(tree.rootNode, 'call_expression');
            const argList = findNodeByType(callExpr!, 'argument_list');
            assert.ok(argList, 'Should find argument_list in call_expression');
        });

        it('should parse member field access', () => {
            const tree = assertParsesCleanly('auto len = buffer.length;');
            const memberExpr = findNodeByType(tree.rootNode, 'member_expression');
            assert.ok(memberExpr, 'Should find member_expression node');
        });

        it('should parse templated method call', () => {
            const tree = assertParsesCleanly('auto item = container.get<uint32>(index);');
            const memberExpr = findNodeByType(tree.rootNode, 'member_expression');
            assert.ok(memberExpr, 'Should find member_expression node');
        });
    });

    describe('Function Definitions', () => {
        it('should parse simple function', () => {
            const tree = assertParsesCleanly('void foo() {}');
            const funcDef = findNodeByType(tree.rootNode, 'function_definition');
            assert.ok(funcDef, 'Should find function_definition node');
            assert.strictEqual(funcDef.childForFieldName('name')?.text, 'foo');
        });

        it('should parse function with return type', () => {
            const tree = assertParsesCleanly('uint32 compute() { return 42; }');
            const funcDef = findNodeByType(tree.rootNode, 'function_definition');
            assert.ok(funcDef, 'Should find function_definition node');
            const returnStmt = findNodeByType(tree.rootNode, 'return_statement');
            assert.ok(returnStmt, 'Should find return_statement');
        });

        it('should parse function with parameters', () => {
            const tree = assertParsesCleanly('uint32 add(uint32 a, uint32 b) { return a + b; }');
            const params = findNodeByType(tree.rootNode, 'parameter_list');
            const paramNodes = findAllNodesByType(params!, 'parameter');
            assert.strictEqual(paramNodes.length, 2, 'Should have 2 parameters');
        });

        it('should parse template function', () => {
            const tree = assertParsesCleanly('template <typename T>\nT identity(T x) { return x; }');
            const funcTemplate = findNodeByType(tree.rootNode, 'function_template');
            assert.ok(funcTemplate, 'Should find function_template node');
        });

        it('should parse inline function', () => {
            const tree = assertParsesCleanly('inline void helper() {}');
            const funcDef = findNodeByType(tree.rootNode, 'function_definition');
            assert.ok(funcDef?.childForFieldName('modifiers'), 'Should have modifiers');
        });

        it('should parse function with attributes', () => {
            const tree = assertParsesCleanly('[[pipelined]] void process() {}');
            const attrs = findNodeByType(tree.rootNode, 'attributes');
            assert.ok(attrs, 'Should find attributes node');
        });
    });

    describe('Classes and Structs', () => {
        it('should parse simple class', () => {
            const tree = assertParsesCleanly('class Foo {}');
            const classDecl = findNodeByType(tree.rootNode, 'class_decl');
            assert.ok(classDecl, 'Should find class_decl node');
        });

        it('should parse class with members', () => {
            const source = `class Counter {
public:
    uint32 value;
    void increment() {}
}`;
            const tree = assertParsesCleanly(source);
            const classDecl = findNodeByType(tree.rootNode, 'class_decl');
            assert.ok(classDecl, 'Should find class_decl node');
        });

        it('should parse template class', () => {
            const source = `template <typename T, auto N>
class Buffer {
    T[N] data;
}`;
            const tree = assertParsesCleanly(source);
            const classTemplate = findNodeByType(tree.rootNode, 'class_template');
            assert.ok(classTemplate, 'Should find class_template node');
        });

        it('should parse struct', () => {
            const source = `struct Point {
    int32 x;
    int32 y;
}`;
            const tree = assertParsesCleanly(source);
            const structDecl = findNodeByType(tree.rootNode, 'struct_decl');
            assert.ok(structDecl, 'Should find struct_decl node');
        });

        it('should parse enum', () => {
            const source = `enum Color : uint8 {
    Red = 0,
    Green = 1,
    Blue = 2
}`;
            const tree = assertParsesCleanly(source);
            const enumDecl = findNodeByType(tree.rootNode, 'enum_decl');
            assert.ok(enumDecl, 'Should find enum_decl node');
        });
    });

    describe('Modules', () => {
        it('should parse import statement', () => {
            const tree = assertParsesCleanly('import data.memory');
            const importDecl = findNodeByType(tree.rootNode, 'import_decl');
            assert.ok(importDecl, 'Should find import_decl node');
        });

        it('should parse import with alias', () => {
            const tree = assertParsesCleanly('import data.fifo as fifo');
            const importDecl = findNodeByType(tree.rootNode, 'import_decl');
            assert.ok(importDecl?.childForFieldName('alias'), 'Should have alias field');
        });

        it('should parse module declaration', () => {
            const tree = assertParsesCleanly('module data.fifo');
            const moduleDecl = findNodeByType(tree.rootNode, 'module_decl');
            assert.ok(moduleDecl, 'Should find module_decl node');
        });
    });

    describe('Control Flow', () => {
        it('should parse if statement', () => {
            const tree = assertParsesCleanly('void f() { if (x > 0) { return; } }');
            const ifStmt = findNodeByType(tree.rootNode, 'if_statement');
            assert.ok(ifStmt, 'Should find if_statement node');
        });

        it('should parse if-else statement', () => {
            const tree = assertParsesCleanly('void f() { if (x > 0) { y = 1; } else { y = 0; } }');
            const ifStmt = findNodeByType(tree.rootNode, 'if_statement');
            assert.ok(ifStmt, 'Should find if_statement node');
        });

        it('should parse switch statement', () => {
            const source = `void f() {
    switch (x) {
        case 0: break;
        default: break;
    }
}`;
            const tree = assertParsesCleanly(source);
            const switchStmt = findNodeByType(tree.rootNode, 'switch_statement');
            assert.ok(switchStmt, 'Should find switch_statement node');
        });

        it('should parse for loop', () => {
            const tree = assertParsesCleanly('void f() { for (const uint32 i : 10) { } }');
            const forStmt = findNodeByType(tree.rootNode, 'range_for_statement');
            assert.ok(forStmt, 'Should find range_for_statement node');
        });

        it('should parse do-while loop', () => {
            const tree = assertParsesCleanly('void f() { do { x++; } while (x < 10); }');
            const doWhile = findNodeByType(tree.rootNode, 'do_while_statement');
            assert.ok(doWhile, 'Should find do_while_statement node');
        });

        it('should parse atomic statement', () => {
            const tree = assertParsesCleanly('void f() { atomic { x++; } }');
            const atomic = findNodeByType(tree.rootNode, 'atomic_statement');
            assert.ok(atomic, 'Should find atomic_statement node');
        });

        it('should parse barrier statement', () => {
            const tree = assertParsesCleanly('void f() { barrier; }');
            const barrier = findNodeByType(tree.rootNode, 'barrier_statement');
            assert.ok(barrier, 'Should find barrier_statement node');
        });
    });

    describe('Comments', () => {
        it('should parse line comments', () => {
            const tree = parseCode('// This is a comment\nuint32 x;');
            const comments = findAllNodesByType(tree.rootNode, 'comment');
            assert.ok(comments.length > 0, 'Should find comment nodes');
        });

        it('should parse doc comments', () => {
            const tree = parseCode('//| Documentation\nvoid foo() {}');
            const comments = findAllNodesByType(tree.rootNode, 'comment');
            assert.ok(comments.length > 0, 'Should find doc comment nodes');
        });

        it('should parse block comments', () => {
            const tree = parseCode('/* block comment */\nuint32 x;');
            const comments = findAllNodesByType(tree.rootNode, 'comment');
            assert.ok(comments.length > 0, 'Should find block comment nodes');
        });
    });

    describe('Type Aliases', () => {
        it('should parse using alias', () => {
            const tree = assertParsesCleanly('using Index = uint32;');
            const alias = findNodeByType(tree.rootNode, 'alias_decl');
            assert.ok(alias, 'Should find alias_decl node');
        });

        it('should parse template alias', () => {
            const tree = assertParsesCleanly('template <typename T>\nusing Ptr = optional<T>;');
            const aliasTemplate = findNodeByType(tree.rootNode, 'alias_template');
            assert.ok(aliasTemplate, 'Should find alias_template node');
        });
    });

    describe('Expressions', () => {
        it('should parse binary expressions', () => {
            const tree = assertParsesCleanly('auto x = a + b * c;');
            const binaryExpr = findNodeByType(tree.rootNode, 'binary_expression');
            assert.ok(binaryExpr, 'Should find binary_expression node');
        });

        it('should parse ternary expression', () => {
            const tree = assertParsesCleanly('auto x = cond ? a : b;');
            const ternary = findNodeByType(tree.rootNode, 'ternary_expression');
            assert.ok(ternary, 'Should find ternary_expression node');
        });

        it('should parse lambda expression', () => {
            const tree = assertParsesCleanly('auto f = [x](uint32 y) -> uint32 { return x + y; };');
            const lambda = findNodeByType(tree.rootNode, 'lambda_expression');
            assert.ok(lambda, 'Should find lambda_expression node');
        });

        it('should parse string literal with interpolation', () => {
            const tree = assertParsesCleanly('auto s = "value: {x}";');
            const stringLit = findNodeByType(tree.rootNode, 'string_literal');
            assert.ok(stringLit, 'Should find string_literal node');
        });
    });

    describe('Error Recovery', () => {
        it('should detect parse errors in invalid syntax', () => {
            const tree = parseCode('class { }'); // Missing name
            assert.ok(hasParseErrors(tree), 'Should detect parse errors');
        });

        it('should recover from incomplete statements', () => {
            const tree = parseCode('uint32 x =');
            assert.ok(hasParseErrors(tree), 'Should detect incomplete statement');
        });
    });
});
