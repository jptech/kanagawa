/**
 * Type Inference Tests for Kanagawa Extension
 *
 * These tests exercise the ACTUAL utility functions from src/utils/typeUtils.ts
 * that are used by the WorkspaceIndexer for type inference.
 */

import * as assert from 'assert';
import {
    normalizeTypeName,
    sanitizeTypeText,
    lastSegment,
    inferLiteralType,
    extractCastTargetTypeFromText,
    inferBinaryExpressionType,
    isArrayType,
    extractArrayElementType,
    isTemplatedType,
    extractTemplateBase,
    extractTemplateArgs
} from '../utils/typeUtils';

describe('Type Utilities (Real Extension Code)', function() {
    this.timeout(10000);

    describe('normalizeTypeName', () => {
        it('should return empty string for empty input', () => {
            assert.strictEqual(normalizeTypeName(''), '');
        });

        it('should strip const prefix', () => {
            assert.strictEqual(normalizeTypeName('const uint32'), 'uint32');
        });

        it('should strip template arguments', () => {
            assert.strictEqual(normalizeTypeName('FIFO<uint32>'), 'FIFO');
            assert.strictEqual(normalizeTypeName('optional<FIFO<uint32>>'), 'optional');
        });

        it('should extract last segment from :: paths', () => {
            assert.strictEqual(normalizeTypeName('std::vector'), 'vector');
            assert.strictEqual(normalizeTypeName('ns::inner::Type'), 'Type');
        });

        it('should extract last segment from . paths', () => {
            assert.strictEqual(normalizeTypeName('data.fifo.FIFO'), 'FIFO');
        });

        it('should remove whitespace', () => {
            assert.strictEqual(normalizeTypeName('  uint32  '), 'uint32');
        });

        it('should handle combined cases', () => {
            assert.strictEqual(normalizeTypeName('const std::optional<T>'), 'optional');
        });
    });

    describe('sanitizeTypeText', () => {
        it('should return undefined for undefined input', () => {
            assert.strictEqual(sanitizeTypeText(undefined), undefined);
        });

        it('should normalize whitespace', () => {
            assert.strictEqual(sanitizeTypeText('uint32   [  8  ]'), 'uint32 [ 8 ]');
        });

        it('should trim', () => {
            assert.strictEqual(sanitizeTypeText('  uint32  '), 'uint32');
        });
    });

    describe('lastSegment', () => {
        it('should return last segment of dotted path', () => {
            assert.strictEqual(lastSegment('a.b.c'), 'c');
        });

        it('should return input if no dots', () => {
            assert.strictEqual(lastSegment('identifier'), 'identifier');
        });
    });

    describe('inferLiteralType', () => {
        it('should infer bool for true/false', () => {
            assert.strictEqual(inferLiteralType('true'), 'bool');
            assert.strictEqual(inferLiteralType('false'), 'bool');
        });

        it('should infer string for quoted strings', () => {
            assert.strictEqual(inferLiteralType('"hello"'), 'string');
        });

        it('should infer char for single-quoted chars', () => {
            assert.strictEqual(inferLiteralType("'a'"), 'char');
        });

        it('should infer uint32 for hex literals', () => {
            assert.strictEqual(inferLiteralType('0xFF'), 'uint32');
            assert.strictEqual(inferLiteralType('0XAB'), 'uint32');
        });

        it('should infer uint32 for binary literals', () => {
            assert.strictEqual(inferLiteralType('0b1010'), 'uint32');
            assert.strictEqual(inferLiteralType('0B1111'), 'uint32');
        });

        it('should infer float for decimal literals', () => {
            assert.strictEqual(inferLiteralType('3.14'), 'float');
            assert.strictEqual(inferLiteralType('1e10'), 'float');
            assert.strictEqual(inferLiteralType('2.5E-3'), 'float');
        });

        it('should infer int32 for integer literals', () => {
            assert.strictEqual(inferLiteralType('42'), 'int32');
            assert.strictEqual(inferLiteralType('-10'), 'int32');
        });
    });

    describe('extractCastTargetTypeFromText', () => {
        it('should extract type from cast<Type>', () => {
            assert.strictEqual(extractCastTargetTypeFromText('cast<float>(x)'), 'float');
        });

        it('should extract type from static_cast<Type>', () => {
            assert.strictEqual(extractCastTargetTypeFromText('static_cast<uint32>(y)'), 'uint32');
        });

        it('should extract type from reinterpret_cast<Type>', () => {
            assert.strictEqual(extractCastTargetTypeFromText('reinterpret_cast<void*>(ptr)'), 'void*');
        });

        it('should extract type from checked_cast<Type>', () => {
            assert.strictEqual(extractCastTargetTypeFromText('checked_cast<uint8>(wide)'), 'uint8');
        });

        it('should handle templated cast types', () => {
            assert.strictEqual(extractCastTargetTypeFromText('cast<FIFO<uint32>>(x)'), 'FIFO<uint32>');
        });

        it('should handle nested templates in cast', () => {
            assert.strictEqual(
                extractCastTargetTypeFromText('cast<optional<FIFO<uint32>>>(x)'),
                'optional<FIFO<uint32>>'
            );
        });

        it('should return undefined for cast without type', () => {
            assert.strictEqual(extractCastTargetTypeFromText('cast(x)'), undefined);
        });

        it('should return undefined for non-cast expressions', () => {
            assert.strictEqual(extractCastTargetTypeFromText('foo<T>(x)'), undefined);
        });
    });

    describe('inferBinaryExpressionType', () => {
        it('should return bool for comparison operators', () => {
            assert.strictEqual(inferBinaryExpressionType('<', 'int32', 'int32'), 'bool');
            assert.strictEqual(inferBinaryExpressionType('>=', 'uint32', 'uint32'), 'bool');
            assert.strictEqual(inferBinaryExpressionType('==', 'int32', 'int32'), 'bool');
            assert.strictEqual(inferBinaryExpressionType('!=', 'int32', 'int32'), 'bool');
        });

        it('should return bool for logical operators', () => {
            assert.strictEqual(inferBinaryExpressionType('&&', 'bool', 'bool'), 'bool');
            assert.strictEqual(inferBinaryExpressionType('||', 'bool', 'bool'), 'bool');
        });

        it('should preserve type for bitwise operators', () => {
            assert.strictEqual(inferBinaryExpressionType('&', 'uint32', 'uint32'), 'uint32');
            assert.strictEqual(inferBinaryExpressionType('|', 'uint8', 'uint8'), 'uint8');
        });

        it('should promote to float for arithmetic with float', () => {
            assert.strictEqual(inferBinaryExpressionType('+', 'int32', 'float'), 'float');
            assert.strictEqual(inferBinaryExpressionType('*', 'float', 'int32'), 'float');
        });

        it('should promote to wider integer type', () => {
            assert.strictEqual(inferBinaryExpressionType('+', 'int32', 'int64'), 'int64');
            assert.strictEqual(inferBinaryExpressionType('-', 'uint64', 'uint32'), 'uint64');
        });
    });

    describe('isArrayType', () => {
        it('should detect array types', () => {
            assert.ok(isArrayType('uint32[8]'));
            assert.ok(isArrayType('int[N]'));
        });

        it('should not detect non-array types', () => {
            assert.ok(!isArrayType('uint32'));
            assert.ok(!isArrayType('FIFO<uint32>')); // template, not array
        });
    });

    describe('extractArrayElementType', () => {
        it('should extract element type from simple arrays', () => {
            assert.strictEqual(extractArrayElementType('uint32[8]'), 'uint32');
        });

        it('should extract element type from templated arrays', () => {
            assert.strictEqual(extractArrayElementType('FIFO<uint32>[4]'), 'FIFO<uint32>');
        });

        it('should extract outer element type from multi-dimensional arrays', () => {
            // int[3][2] → element is int[3]
            assert.strictEqual(extractArrayElementType('int[3][2]'), 'int[3]');
        });
    });

    describe('isTemplatedType', () => {
        it('should detect templated types', () => {
            assert.ok(isTemplatedType('FIFO<uint32>'));
            assert.ok(isTemplatedType('optional<T>'));
        });

        it('should not detect non-templated types', () => {
            assert.ok(!isTemplatedType('uint32'));
            assert.ok(!isTemplatedType('uint32[8]'));
        });
    });

    describe('extractTemplateBase', () => {
        it('should extract base type', () => {
            assert.strictEqual(extractTemplateBase('FIFO<uint32>'), 'FIFO');
            assert.strictEqual(extractTemplateBase('optional<FIFO<uint32>>'), 'optional');
        });

        it('should return input if not templated', () => {
            assert.strictEqual(extractTemplateBase('uint32'), 'uint32');
        });
    });

    describe('extractTemplateArgs', () => {
        it('should extract single argument', () => {
            assert.deepStrictEqual(extractTemplateArgs('FIFO<uint32>'), ['uint32']);
        });

        it('should extract multiple arguments', () => {
            assert.deepStrictEqual(extractTemplateArgs('Map<string, int32>'), ['string', 'int32']);
        });

        it('should handle nested templates', () => {
            assert.deepStrictEqual(
                extractTemplateArgs('optional<FIFO<uint32>>'),
                ['FIFO<uint32>']
            );
        });

        it('should handle complex nested templates', () => {
            assert.deepStrictEqual(
                extractTemplateArgs('Map<string, FIFO<uint32>>'),
                ['string', 'FIFO<uint32>']
            );
        });

        it('should return empty array for non-templated types', () => {
            assert.deepStrictEqual(extractTemplateArgs('uint32'), []);
        });
    });
});
