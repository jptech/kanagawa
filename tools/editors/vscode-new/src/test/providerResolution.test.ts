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
        // Helper function matching the one in providers
        function parseParameterNames(signature: string): string[] {
            const names: string[] = [];
            const match = signature.match(/\(([^)]*)\)/);
            if (!match) { return names; }

            const params = match[1];
            if (!params.trim()) { return names; }

            // Simple split, not handling nested templates fully
            const paramList = splitParameters(params);

            for (const param of paramList) {
                const trimmed = param.trim();
                const withoutDefault = trimmed.split('=')[0].trim();
                const parts = withoutDefault.split(/\s+/);
                if (parts.length > 0) {
                    const name = parts[parts.length - 1]
                        .replace(/[&*\[\]]/g, '')
                        .trim();
                    if (name && !isTypeName(name)) {
                        names.push(name);
                    }
                }
            }
            return names;
        }

        function splitParameters(params: string): string[] {
            const result: string[] = [];
            let current = '';
            let depth = 0;

            for (const char of params) {
                if (char === '<' || char === '(') {
                    depth++;
                    current += char;
                } else if (char === '>' || char === ')') {
                    depth--;
                    current += char;
                } else if (char === ',' && depth === 0) {
                    result.push(current);
                    current = '';
                } else {
                    current += char;
                }
            }

            if (current.trim()) {
                result.push(current);
            }
            return result;
        }

        function isTypeName(name: string): boolean {
            const types = ['void', 'bool', 'int', 'uint', 'auto', 'char', 'float', 'double'];
            return types.includes(name) || 
                   /^(u?int\d+|uint\d+_t|float\d+)$/.test(name);
        }

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
    });
});
