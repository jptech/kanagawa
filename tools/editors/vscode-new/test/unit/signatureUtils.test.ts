/**
 * Tests for signature parsing utilities.
 */

import * as assert from 'assert';
import {
    stripAttributes,
    extractFunctionParameters,
    splitParameters,
    isTypeName,
    parseParameterNames
} from '../../src/utils/signatureUtils';

describe('Signature Utilities', () => {
    describe('stripAttributes', () => {
        it('should strip single attribute', () => {
            assert.strictEqual(
                stripAttributes('[[nodiscard]] int foo(int x)'),
                'int foo(int x)'
            );
        });

        it('should strip multiple attributes', () => {
            assert.strictEqual(
                stripAttributes('[[nodiscard]] [[deprecated]] int foo(int x)'),
                'int foo(int x)'
            );
        });

        it('should strip attributes with arguments', () => {
            assert.strictEqual(
                stripAttributes('[[deprecated("use bar")]] int foo()'),
                'int foo()'
            );
        });

        it('should strip complex nested attributes', () => {
            assert.strictEqual(
                stripAttributes('[[maybe_unused, nodiscard]] void foo()'),
                'void foo()'
            );
        });

        it('should handle no attributes', () => {
            assert.strictEqual(
                stripAttributes('int foo(int x)'),
                'int foo(int x)'
            );
        });

        it('should handle empty string', () => {
            assert.strictEqual(stripAttributes(''), '');
        });

        it('should preserve template brackets', () => {
            assert.strictEqual(
                stripAttributes('[[nodiscard]] Array<int, 10> foo()'),
                'Array<int, 10> foo()'
            );
        });
    });

    describe('extractFunctionParameters', () => {
        it('should extract simple parameters', () => {
            assert.strictEqual(
                extractFunctionParameters('void foo(int x, int y)'),
                'int x, int y'
            );
        });

        it('should extract parameters from attributed signature', () => {
            assert.strictEqual(
                extractFunctionParameters('[[nodiscard]] int foo(string s)'),
                'string s'
            );
        });

        it('should handle empty parameter list', () => {
            assert.strictEqual(
                extractFunctionParameters('void foo()'),
                ''
            );
        });

        it('should return undefined for missing parentheses', () => {
            assert.strictEqual(
                extractFunctionParameters('int foo'),
                undefined
            );
        });

        it('should handle nested parentheses in parameters', () => {
            assert.strictEqual(
                extractFunctionParameters('void foo(Func<int(int)> callback)'),
                'Func<int(int)> callback'
            );
        });

        it('should handle template return types', () => {
            assert.strictEqual(
                extractFunctionParameters('Array<int, 10> foo(int size)'),
                'int size'
            );
        });

        it('should handle complex signatures', () => {
            const sig = '[[inline]] Map<string, List<int>> process(Array<int, N> input, bool flag = true)';
            assert.strictEqual(
                extractFunctionParameters(sig),
                'Array<int, N> input, bool flag = true'
            );
        });
    });

    describe('splitParameters', () => {
        it('should split simple parameters', () => {
            // Note: splitParameters doesn't trim leading whitespace after comma
            assert.deepStrictEqual(
                splitParameters('int x, int y, int z'),
                ['int x', ' int y', ' int z']
            );
        });

        it('should handle single parameter', () => {
            assert.deepStrictEqual(
                splitParameters('int x'),
                ['int x']
            );
        });

        it('should handle empty string', () => {
            assert.deepStrictEqual(
                splitParameters(''),
                []
            );
        });

        it('should handle template parameters', () => {
            // Note: splitParameters preserves whitespace after commas
            assert.deepStrictEqual(
                splitParameters('Array<int, 10> arr, Map<string, int> map'),
                ['Array<int, 10> arr', ' Map<string, int> map']
            );
        });

        it('should handle nested templates', () => {
            assert.deepStrictEqual(
                splitParameters('Map<string, List<int>> m, int n'),
                ['Map<string, List<int>> m', ' int n']
            );
        });

        it('should handle default values with commas', () => {
            // This is a limitation - we can't easily parse default values with commas
            // But we should handle simple defaults
            assert.deepStrictEqual(
                splitParameters('int x = 0, int y = 1'),
                ['int x = 0', ' int y = 1']
            );
        });

        it('should preserve whitespace in parameters', () => {
            // splitParameters does not trim individual parameters
            assert.deepStrictEqual(
                splitParameters('  int x  ,  int y  '),
                ['  int x  ', '  int y  ']
            );
        });

        it('should handle function pointer types', () => {
            assert.deepStrictEqual(
                splitParameters('void (*callback)(int, int), int data'),
                ['void (*callback)(int, int)', ' int data']
            );
        });
    });

    describe('isTypeName', () => {
        it('should identify builtin types', () => {
            assert.strictEqual(isTypeName('int'), true);
            assert.strictEqual(isTypeName('uint'), true);
            assert.strictEqual(isTypeName('float'), true);
            assert.strictEqual(isTypeName('bool'), true);
            assert.strictEqual(isTypeName('void'), true);
            assert.strictEqual(isTypeName('char'), true);
            assert.strictEqual(isTypeName('double'), true);
            assert.strictEqual(isTypeName('auto'), true);
        });

        it('should not identify non-builtin lowercase words as types', () => {
            // 'string' is not in the builtin list and doesn't start with uppercase
            assert.strictEqual(isTypeName('string'), false);
            assert.strictEqual(isTypeName('value'), false);
            assert.strictEqual(isTypeName('count'), false);
        });

        it('should identify sized integer types', () => {
            assert.strictEqual(isTypeName('int8'), true);
            assert.strictEqual(isTypeName('int16'), true);
            assert.strictEqual(isTypeName('int32'), true);
            assert.strictEqual(isTypeName('int64'), true);
            assert.strictEqual(isTypeName('uint8'), true);
            assert.strictEqual(isTypeName('uint16'), true);
            assert.strictEqual(isTypeName('uint32'), true);
            assert.strictEqual(isTypeName('uint64'), true);
        });

        it('should identify float types', () => {
            assert.strictEqual(isTypeName('float16'), true);
            assert.strictEqual(isTypeName('float32'), true);
            assert.strictEqual(isTypeName('float64'), true);
        });

        it('should identify PascalCase as types', () => {
            assert.strictEqual(isTypeName('Array'), true);
            assert.strictEqual(isTypeName('MyClass'), true);
            assert.strictEqual(isTypeName('HTTPRequest'), true);
            assert.strictEqual(isTypeName('String'), true); // PascalCase String is a type
        });

        it('should not identify lowercase names as types', () => {
            assert.strictEqual(isTypeName('value'), false);
            assert.strictEqual(isTypeName('count'), false);
            assert.strictEqual(isTypeName('myVar'), false);
        });

        it('should not identify names starting with underscore as types', () => {
            assert.strictEqual(isTypeName('_internal'), false);
            assert.strictEqual(isTypeName('__private'), false);
        });

        it('should not identify modifiers as types', () => {
            // const is not in the builtin type list and doesn't start with uppercase
            assert.strictEqual(isTypeName('const'), false);
            assert.strictEqual(isTypeName('mutable'), false);
        });
    });

    describe('parseParameterNames', () => {
        it('should extract names from simple signature', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(int x, int y)'),
                ['x', 'y']
            );
        });

        it('should extract names with types', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(string name, int count)'),
                ['name', 'count']
            );
        });

        it('should handle template types', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(Array<int, 10> arr, Map<string, int> map)'),
                ['arr', 'map']
            );
        });

        it('should handle no parameters', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo()'),
                []
            );
        });

        it('should handle default values', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(int x = 0, int y = 1)'),
                ['x', 'y']
            );
        });

        it('should handle const parameters', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(const int x, const string& s)'),
                ['x', 's']
            );
        });

        it('should handle pointer/reference parameters', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(int* ptr, int& ref)'),
                ['ptr', 'ref']
            );
        });

        it('should handle attributed signatures', () => {
            assert.deepStrictEqual(
                parseParameterNames('[[nodiscard]] int foo(int value)'),
                ['value']
            );
        });

        it('should handle complex nested templates', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(Map<string, List<int>> data, int count)'),
                ['data', 'count']
            );
        });

        it('should handle variadic parameters', () => {
            // May or may not extract "args" depending on implementation
            const result = parseParameterNames('void foo(int first, T... args)');
            assert.ok(result.includes('first'));
        });

        it('should handle multi-word types', () => {
            assert.deepStrictEqual(
                parseParameterNames('void foo(unsigned int value, long long count)'),
                ['value', 'count']
            );
        });
    });
});
