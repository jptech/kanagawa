/**
 * Tests for Type Utility Functions
 * 
 * Priority: P1 - Type utilities are used throughout providers for:
 * - Type inference for hover and inlay hints
 * - Type normalization for symbol resolution
 * - Template handling for completion and signature help
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
} from '../../src/utils/typeUtils';

describe('Type Utilities', () => {

    describe('normalizeTypeName', () => {
        it('should return empty string for empty input', () => {
            assert.strictEqual(normalizeTypeName(''), '');
        });

        it('should trim whitespace', () => {
            assert.strictEqual(normalizeTypeName('  uint32  '), 'uint32');
        });

        it('should remove const prefix', () => {
            assert.strictEqual(normalizeTypeName('const uint32'), 'uint32');
            assert.strictEqual(normalizeTypeName('const   FIFO'), 'FIFO');
        });

        it('should remove template arguments', () => {
            assert.strictEqual(normalizeTypeName('FIFO<uint32>'), 'FIFO');
            assert.strictEqual(normalizeTypeName('Map<string, int>'), 'Map');
        });

        it('should remove namespace prefix (::)', () => {
            assert.strictEqual(normalizeTypeName('data::fifo::FIFO'), 'FIFO');
            assert.strictEqual(normalizeTypeName('std::string'), 'string');
        });

        it('should remove module prefix (.)', () => {
            assert.strictEqual(normalizeTypeName('data.fifo.FIFO'), 'FIFO');
        });

        it('should handle combined modifiers', () => {
            assert.strictEqual(normalizeTypeName('const data.fifo::FIFO<uint32>'), 'FIFO');
        });

        it('should normalize whitespace', () => {
            assert.strictEqual(normalizeTypeName('const   FIFO'), 'FIFO');
        });
    });

    describe('sanitizeTypeText', () => {
        it('should return undefined for undefined input', () => {
            assert.strictEqual(sanitizeTypeText(undefined), undefined);
        });

        it('should return undefined for empty string', () => {
            assert.strictEqual(sanitizeTypeText(''), undefined);
        });

        it('should normalize multiple spaces to single space', () => {
            assert.strictEqual(sanitizeTypeText('const   uint32'), 'const uint32');
        });

        it('should trim leading and trailing whitespace', () => {
            assert.strictEqual(sanitizeTypeText('  uint32  '), 'uint32');
        });

        it('should handle newlines and tabs', () => {
            assert.strictEqual(sanitizeTypeText('FIFO\n<\tuint32>'), 'FIFO < uint32>');
        });
    });

    describe('lastSegment', () => {
        it('should return the last segment after dots', () => {
            assert.strictEqual(lastSegment('data.fifo.FIFO'), 'FIFO');
        });

        it('should return input if no dots', () => {
            assert.strictEqual(lastSegment('FIFO'), 'FIFO');
        });

        it('should handle single segment', () => {
            assert.strictEqual(lastSegment('uint32'), 'uint32');
        });

        it('should handle trailing dot', () => {
            assert.strictEqual(lastSegment('data.'), '');
        });
    });

    describe('inferLiteralType', () => {
        describe('boolean literals', () => {
            it('should infer bool for true', () => {
                assert.strictEqual(inferLiteralType('true'), 'bool');
            });

            it('should infer bool for false', () => {
                assert.strictEqual(inferLiteralType('false'), 'bool');
            });
        });

        describe('string literals', () => {
            it('should infer string for double-quoted strings', () => {
                assert.strictEqual(inferLiteralType('"hello"'), 'string');
            });

            it('should infer string for empty string', () => {
                assert.strictEqual(inferLiteralType('""'), 'string');
            });

            it('should infer string for string with spaces', () => {
                assert.strictEqual(inferLiteralType('"hello world"'), 'string');
            });
        });

        describe('character literals', () => {
            it('should infer char for single-quoted characters', () => {
                assert.strictEqual(inferLiteralType("'a'"), 'char');
            });

            it('should infer char for escape sequences', () => {
                assert.strictEqual(inferLiteralType("'\\n'"), 'char');
            });
        });

        describe('hex literals', () => {
            it('should infer uint32 for 0x prefix', () => {
                assert.strictEqual(inferLiteralType('0xFF'), 'uint32');
            });

            it('should infer uint32 for 0X prefix', () => {
                assert.strictEqual(inferLiteralType('0XABCD'), 'uint32');
            });
        });

        describe('binary literals', () => {
            it('should infer uint32 for 0b prefix', () => {
                assert.strictEqual(inferLiteralType('0b1010'), 'uint32');
            });

            it('should infer uint32 for 0B prefix', () => {
                assert.strictEqual(inferLiteralType('0B1111'), 'uint32');
            });
        });

        describe('float literals', () => {
            it('should infer float for decimal point', () => {
                assert.strictEqual(inferLiteralType('3.14'), 'float');
            });

            it('should infer float for exponent notation', () => {
                assert.strictEqual(inferLiteralType('1e10'), 'float');
                assert.strictEqual(inferLiteralType('1E-5'), 'float');
                assert.strictEqual(inferLiteralType('2.5e+3'), 'float');
            });
        });

        describe('integer literals', () => {
            it('should infer int32 for simple integers', () => {
                assert.strictEqual(inferLiteralType('42'), 'int32');
                assert.strictEqual(inferLiteralType('0'), 'int32');
                assert.strictEqual(inferLiteralType('-100'), 'int32');
            });
        });

        it('should handle whitespace', () => {
            assert.strictEqual(inferLiteralType('  42  '), 'int32');
            assert.strictEqual(inferLiteralType('  true  '), 'bool');
        });
    });

    describe('extractCastTargetTypeFromText', () => {
        it('should extract simple cast type', () => {
            assert.strictEqual(extractCastTargetTypeFromText('cast<float>(x)'), 'float');
        });

        it('should extract static_cast type', () => {
            assert.strictEqual(extractCastTargetTypeFromText('static_cast<uint32>(y)'), 'uint32');
        });

        it('should extract reinterpret_cast type', () => {
            assert.strictEqual(extractCastTargetTypeFromText('reinterpret_cast<uint64>(ptr)'), 'uint64');
        });

        it('should extract checked_cast type', () => {
            assert.strictEqual(extractCastTargetTypeFromText('checked_cast<uint8>(wide)'), 'uint8');
        });

        it('should handle nested template types', () => {
            assert.strictEqual(
                extractCastTargetTypeFromText('cast<FIFO<uint32>>(z)'),
                'FIFO<uint32>'
            );
        });

        it('should handle deeply nested templates', () => {
            assert.strictEqual(
                extractCastTargetTypeFromText('cast<Map<string, FIFO<int>>>(x)'),
                'Map<string, FIFO<int>>'
            );
        });

        it('should return undefined for non-cast expressions', () => {
            assert.strictEqual(extractCastTargetTypeFromText('foo(x)'), undefined);
            assert.strictEqual(extractCastTargetTypeFromText('x + y'), undefined);
        });

        it('should return undefined for malformed cast', () => {
            assert.strictEqual(extractCastTargetTypeFromText('cast<float'), undefined);
        });
    });

    describe('inferBinaryExpressionType', () => {
        describe('comparison operators', () => {
            it('should return bool for <', () => {
                assert.strictEqual(inferBinaryExpressionType('<', 'int32', 'int32'), 'bool');
            });

            it('should return bool for >', () => {
                assert.strictEqual(inferBinaryExpressionType('>', 'int32', 'int32'), 'bool');
            });

            it('should return bool for <=', () => {
                assert.strictEqual(inferBinaryExpressionType('<=', 'uint32', 'uint32'), 'bool');
            });

            it('should return bool for >=', () => {
                assert.strictEqual(inferBinaryExpressionType('>=', 'float', 'float'), 'bool');
            });

            it('should return bool for ==', () => {
                assert.strictEqual(inferBinaryExpressionType('==', 'bool', 'bool'), 'bool');
            });

            it('should return bool for !=', () => {
                assert.strictEqual(inferBinaryExpressionType('!=', 'string', 'string'), 'bool');
            });
        });

        describe('logical operators', () => {
            it('should return bool for &&', () => {
                assert.strictEqual(inferBinaryExpressionType('&&', 'bool', 'bool'), 'bool');
            });

            it('should return bool for ||', () => {
                assert.strictEqual(inferBinaryExpressionType('||', 'bool', 'bool'), 'bool');
            });

            it('should return bool for and', () => {
                assert.strictEqual(inferBinaryExpressionType('and', 'bool', 'bool'), 'bool');
            });

            it('should return bool for or', () => {
                assert.strictEqual(inferBinaryExpressionType('or', 'bool', 'bool'), 'bool');
            });
        });

        describe('bitwise operators', () => {
            it('should preserve type for &', () => {
                assert.strictEqual(inferBinaryExpressionType('&', 'uint32', 'uint32'), 'uint32');
            });

            it('should preserve type for |', () => {
                assert.strictEqual(inferBinaryExpressionType('|', 'uint8', 'uint8'), 'uint8');
            });

            it('should preserve type for ^', () => {
                assert.strictEqual(inferBinaryExpressionType('^', 'int32', 'int32'), 'int32');
            });

            it('should preserve type for <<', () => {
                assert.strictEqual(inferBinaryExpressionType('<<', 'uint64', 'int32'), 'uint64');
            });

            it('should preserve type for >>', () => {
                assert.strictEqual(inferBinaryExpressionType('>>', 'int64', 'int32'), 'int64');
            });
        });

        describe('arithmetic operators', () => {
            it('should promote to float when float is involved', () => {
                assert.strictEqual(inferBinaryExpressionType('+', 'int32', 'float'), 'float');
                assert.strictEqual(inferBinaryExpressionType('*', 'float', 'int32'), 'float');
            });

            it('should promote to float32', () => {
                assert.strictEqual(inferBinaryExpressionType('/', 'int32', 'float32'), 'float32');
            });

            it('should promote to float64', () => {
                assert.strictEqual(inferBinaryExpressionType('-', 'float64', 'int32'), 'float64');
            });

            it('should promote to int64', () => {
                assert.strictEqual(inferBinaryExpressionType('+', 'int32', 'int64'), 'int64');
            });

            it('should promote to uint64', () => {
                assert.strictEqual(inferBinaryExpressionType('*', 'uint32', 'uint64'), 'uint64');
            });

            it('should preserve left type for same types', () => {
                assert.strictEqual(inferBinaryExpressionType('+', 'int32', 'int32'), 'int32');
            });

            it('should handle % operator', () => {
                assert.strictEqual(inferBinaryExpressionType('%', 'int32', 'int32'), 'int32');
            });
        });
    });

    describe('isArrayType', () => {
        it('should detect array types', () => {
            assert.strictEqual(isArrayType('int[10]'), true);
            assert.strictEqual(isArrayType('FIFO<uint32>[8]'), true);
            assert.strictEqual(isArrayType('uint32[N]'), true);
        });

        it('should not detect non-array types', () => {
            assert.strictEqual(isArrayType('int'), false);
            assert.strictEqual(isArrayType('FIFO<uint32>'), false);
            assert.strictEqual(isArrayType('Map<K, V>'), false);
        });

        it('should not match template args as arrays', () => {
            assert.strictEqual(isArrayType('Array<int, 10>'), false);
        });
    });

    describe('extractArrayElementType', () => {
        it('should extract element type from simple array', () => {
            assert.strictEqual(extractArrayElementType('int[10]'), 'int');
        });

        it('should extract element type from templated array', () => {
            assert.strictEqual(extractArrayElementType('FIFO<uint32>[8]'), 'FIFO<uint32>');
        });

        it('should extract outer element type from multi-dimensional array', () => {
            assert.strictEqual(extractArrayElementType('int[3][2]'), 'int[3]');
        });

        it('should return input for non-array types', () => {
            assert.strictEqual(extractArrayElementType('int'), 'int');
        });
    });

    describe('isTemplatedType', () => {
        it('should detect templated types', () => {
            assert.strictEqual(isTemplatedType('FIFO<uint32>'), true);
            assert.strictEqual(isTemplatedType('Map<K, V>'), true);
            assert.strictEqual(isTemplatedType('optional<T>'), true);
        });

        it('should not detect non-templated types', () => {
            assert.strictEqual(isTemplatedType('int'), false);
            assert.strictEqual(isTemplatedType('uint32'), false);
            assert.strictEqual(isTemplatedType('MyClass'), false);
        });

        it('should handle partial brackets', () => {
            assert.strictEqual(isTemplatedType('less<T'), false);
            assert.strictEqual(isTemplatedType('T>'), false);
        });
    });

    describe('extractTemplateBase', () => {
        it('should extract base type', () => {
            assert.strictEqual(extractTemplateBase('FIFO<uint32>'), 'FIFO');
            assert.strictEqual(extractTemplateBase('Map<K, V>'), 'Map');
        });

        it('should return input if not templated', () => {
            assert.strictEqual(extractTemplateBase('int'), 'int');
            assert.strictEqual(extractTemplateBase('MyClass'), 'MyClass');
        });
    });

    describe('extractTemplateArgs', () => {
        it('should extract single argument', () => {
            assert.deepStrictEqual(extractTemplateArgs('FIFO<uint32>'), ['uint32']);
        });

        it('should extract multiple arguments', () => {
            assert.deepStrictEqual(extractTemplateArgs('Map<string, int>'), ['string', 'int']);
        });

        it('should handle nested templates', () => {
            assert.deepStrictEqual(
                extractTemplateArgs('Map<string, FIFO<int>>'),
                ['string', 'FIFO<int>']
            );
        });

        it('should handle complex nested templates', () => {
            assert.deepStrictEqual(
                extractTemplateArgs('A<B<C>, D<E, F>>'),
                ['B<C>', 'D<E, F>']
            );
        });

        it('should return empty array for non-templated types', () => {
            assert.deepStrictEqual(extractTemplateArgs('int'), []);
        });

        it('should trim whitespace from arguments', () => {
            assert.deepStrictEqual(
                extractTemplateArgs('Map< string , int >'),
                ['string', 'int']
            );
        });

        it('should handle single nested template', () => {
            assert.deepStrictEqual(
                extractTemplateArgs('optional<FIFO<uint32>>'),
                ['FIFO<uint32>']
            );
        });
    });
});
