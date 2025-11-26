/**
 * Provider Resolution Tests
 * 
 * Tests that verify signature help, inlay hints, and hover all use
 * consistent resolution logic for symbols.
 */

import * as assert from 'assert';
import {
    normalizeTypeName,
    extractCastTargetTypeFromText,
    inferLiteralType,
    isTemplatedType,
    extractTemplateBase,
    extractTemplateArgs
} from '../utils/typeUtils';

import {
    computeQualifiedName,
    parseQualifiedName,
    computeAccessibilityScore,
    createResolutionResult
} from '../utils/symbolUtils';

import {
    parseTemplateType,
    parseTemplateArguments,
    substituteParameters,
    instantiateMethodSignature,
    createInstantiation
} from '../utils/templateUtils';

import {
    stripAttributes,
    extractFunctionParameters,
    splitParameters,
    isTypeName,
    parseParameterNames
} from '../utils/signatureUtils';

describe('Provider Resolution Consistency', function() {
    this.timeout(10000);

    describe('Symbol Resolution Scoring', () => {
        it('should score same-module symbols highest', () => {
            const score = computeAccessibilityScore(
                'mymodule',                    // symbol module
                ['mymodule', 'MyClass'],       // symbol scope
                'mymodule',                    // document module
                [{ path: 'other' }],           // imports (array of ImportRef)
                ['mymodule', 'MyClass']        // current scope
            );
            // Same module + exact scope match should be high
            assert.ok(score >= 200, `Expected score >= 200 for same module + exact scope, got ${score}`);
        });

        it('should score imported symbols moderately', () => {
            const score = computeAccessibilityScore(
                'othermodule',
                ['othermodule', 'OtherClass'],
                'mymodule',
                [{ path: 'othermodule' }],     // imported
                ['mymodule']
            );
            assert.ok(score > 0, 'Imported symbols should have positive score');
            assert.ok(score < 200, 'Imported symbols should score less than same-module');
        });

        it('should score global symbols with base score', () => {
            const score = computeAccessibilityScore(
                undefined,                     // no module (global)
                [],                            // no scope
                'mymodule',
                [],
                ['mymodule']
            );
            assert.ok(score > 0, 'Global symbols should have positive score');
        });

        it('should prefer exact scope matches', () => {
            const exactScore = computeAccessibilityScore(
                'mod',
                ['mod', 'Container', 'method'],
                'mod',
                [],
                ['mod', 'Container', 'method']
            );
            
            const partialScore = computeAccessibilityScore(
                'mod',
                ['mod', 'Container', 'method'],
                'mod',
                [],
                ['mod', 'Container']           // partial match
            );
            
            assert.ok(exactScore > partialScore, 'Exact scope should score higher than partial');
        });
    });

    describe('Qualified Name Handling', () => {
        it('should parse module-qualified names correctly', () => {
            const result = parseQualifiedName('data.fifo::FIFO::push');
            assert.strictEqual(result.module, 'data.fifo');
            assert.deepStrictEqual(result.path, ['FIFO']);
            assert.strictEqual(result.name, 'push');
        });

        it('should handle simple names', () => {
            const result = parseQualifiedName('push');
            assert.strictEqual(result.module, undefined);
            assert.deepStrictEqual(result.path, []);
            assert.strictEqual(result.name, 'push');
        });

        it('should compute qualified name from scope path', () => {
            const qname = computeQualifiedName('push', ['data.fifo', 'FIFO']);
            assert.strictEqual(qname, 'data.fifo::FIFO::push');
        });
    });

    describe('Type Inference Consistency', () => {
        it('should infer literal types consistently', () => {
            // These should match what the indexer returns
            assert.strictEqual(inferLiteralType('42'), 'int32');
            assert.strictEqual(inferLiteralType('3.14'), 'float');
            assert.strictEqual(inferLiteralType('true'), 'bool');
            assert.strictEqual(inferLiteralType('"hello"'), 'string');
            assert.strictEqual(inferLiteralType("'c'"), 'char');
            assert.strictEqual(inferLiteralType('0xFF'), 'uint32');
        });

        it('should extract cast types consistently', () => {
            assert.strictEqual(extractCastTargetTypeFromText('cast<float32>(x)'), 'float32');
            assert.strictEqual(extractCastTargetTypeFromText('cast<FIFO<uint32>>(x)'), 'FIFO<uint32>');
        });

        it('should normalize type names consistently', () => {
            assert.strictEqual(normalizeTypeName('const FIFO<uint32>'), 'FIFO');
            assert.strictEqual(normalizeTypeName('data.fifo::FIFO'), 'FIFO');
        });
    });

    describe('Template Instantiation Consistency', () => {
        it('should parse template types for signature display', () => {
            const parsed = parseTemplateType('FIFO<uint32, 32>');
            assert.ok(parsed);
            assert.strictEqual(parsed!.baseName, 'FIFO');
            assert.deepStrictEqual(parsed!.arguments, ['uint32', '32']);
        });

        it('should substitute template parameters in signatures', () => {
            const substitutions = new Map([['T', 'uint32'], ['N', '32']]);
            
            const result = substituteParameters('void push(T value)', substitutions);
            assert.strictEqual(result, 'void push(uint32 value)');
        });

        it('should instantiate method signatures consistently', () => {
            const instantiation = createInstantiation(
                'FIFO',
                [{ name: 'T', kind: 'type' as const }, { name: 'N', kind: 'value' as const }],
                ['uint32', '32']
            );
            
            const signature = instantiateMethodSignature('T pop()', instantiation);
            assert.strictEqual(signature, 'uint32 pop()');
        });

        it('should handle nested template substitution', () => {
            const substitutions = new Map([['T', 'FIFO<uint32>']]);
            
            const result = substituteParameters('optional<T> get()', substitutions);
            assert.strictEqual(result, 'optional<FIFO<uint32>> get()');
        });
    });

    describe('Resolution Result Creation', () => {
        it('should return exact confidence for single high-scoring candidate', () => {
            const candidates = [{ name: 'push', score: 100 }];
            const scorer = (c: typeof candidates[0]) => c.score;
            
            const result = createResolutionResult(candidates, scorer);
            
            assert.ok(result.primary);
            assert.strictEqual(result.primary.name, 'push');
            assert.ok(result.confidence === 'exact' || result.confidence === 'high');
        });

        it('should return low confidence for tied candidates', () => {
            const candidates = [
                { name: 'push1', score: 50 },
                { name: 'push2', score: 50 }
            ];
            const scorer = (c: typeof candidates[0]) => c.score;
            
            const result = createResolutionResult(candidates, scorer);
            
            // Tied scores should be low confidence
            assert.ok(result.confidence === 'low' || result.confidence === 'medium');
        });

        it('should list alternatives after primary', () => {
            const candidates = [
                { name: 'best', score: 100 },
                { name: 'alt1', score: 50 },
                { name: 'alt2', score: 40 }
            ];
            const scorer = (c: typeof candidates[0]) => c.score;
            
            const result = createResolutionResult(candidates, scorer);
            
            assert.strictEqual(result.primary!.name, 'best');
            assert.strictEqual(result.alternatives.length, 2);
            assert.strictEqual(result.alternatives[0].name, 'alt1');
        });
    });

    describe('Parameter Name Extraction', () => {
        // Tests use shared utility functions from signatureUtils.ts
        // This ensures the tests validate the same code used by the providers

        it('should extract parameter names from simple signature', () => {
            const names = parseParameterNames('void push(T value, bool block)');
            assert.deepStrictEqual(names, ['value', 'block']);
        });

        it('should extract parameter names with template types', () => {
            const names = parseParameterNames('void insert(Map<string, int> map, string key)');
            assert.deepStrictEqual(names, ['map', 'key']);
        });

        it('should handle parameters with default values', () => {
            const names = parseParameterNames('void connect(string host, int port = 80)');
            assert.deepStrictEqual(names, ['host', 'port']);
        });

        it('should handle empty parameter list', () => {
            const names = parseParameterNames('int getValue()');
            assert.deepStrictEqual(names, []);
        });

        it('should handle functions with [[...]] attributes', () => {
            const names = parseParameterNames('[[max_threads(1)]] optional<lqd_control_data_t> control(LqdControlOp opcode, lqd_control_address_t address, lqd_control_data_t data)');
            assert.deepStrictEqual(names, ['opcode', 'address', 'data']);
        });

        it('should handle multiple attributes', () => {
            const names = parseParameterNames('[[inline]] [[deprecated]] void process(int value)');
            assert.deepStrictEqual(names, ['value']);
        });

        it('should handle nested attribute parentheses', () => {
            const names = parseParameterNames('[[attr(foo(1, 2))]] void func(string name)');
            assert.deepStrictEqual(names, ['name']);
        });

        it('should handle template return types with attributes', () => {
            const names = parseParameterNames('[[nodiscard]] optional<Result<T>> compute(Input input)');
            assert.deepStrictEqual(names, ['input']);
        });

        // Additional tests for stripAttributes
        describe('stripAttributes helper', () => {
            it('should strip single attribute', () => {
                assert.strictEqual(stripAttributes('[[inline]] void f()'), 'void f()');
            });

            it('should strip multiple attributes', () => {
                assert.strictEqual(stripAttributes('[[a]] [[b]] void f()'), 'void f()');
            });

            it('should handle attributes with parentheses', () => {
                assert.strictEqual(stripAttributes('[[max_threads(1)]] void f()'), 'void f()');
            });

            it('should handle no attributes', () => {
                assert.strictEqual(stripAttributes('void f()'), 'void f()');
            });
        });

        // Additional tests for extractFunctionParameters
        describe('extractFunctionParameters helper', () => {
            it('should extract simple parameters', () => {
                assert.strictEqual(extractFunctionParameters('void f(int a, int b)'), 'int a, int b');
            });

            it('should handle template return types', () => {
                assert.strictEqual(extractFunctionParameters('optional<T> f(int a)'), 'int a');
            });

            it('should return undefined for no parentheses', () => {
                assert.strictEqual(extractFunctionParameters('void f'), undefined);
            });
        });

        // Additional tests for splitParameters
        describe('splitParameters helper', () => {
            it('should split simple parameters', () => {
                assert.deepStrictEqual(splitParameters('int a, int b'), ['int a', ' int b']);
            });

            it('should handle template types', () => {
                assert.deepStrictEqual(splitParameters('Map<K,V> m, int n'), ['Map<K,V> m', ' int n']);
            });
        });

        // Additional tests for isTypeName
        describe('isTypeName helper', () => {
            it('should identify basic types', () => {
                assert.strictEqual(isTypeName('void'), true);
                assert.strictEqual(isTypeName('int'), true);
                assert.strictEqual(isTypeName('bool'), true);
            });

            it('should identify sized types', () => {
                assert.strictEqual(isTypeName('int32'), true);
                assert.strictEqual(isTypeName('uint64'), true);
            });

            it('should identify PascalCase as types', () => {
                assert.strictEqual(isTypeName('MyClass'), true);
                assert.strictEqual(isTypeName('String'), true);
            });

            it('should not identify lowercase names as types', () => {
                assert.strictEqual(isTypeName('value'), false);
                assert.strictEqual(isTypeName('name'), false);
            });
        });
    });
});
