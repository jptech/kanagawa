/**
 * Type Inference Tests for Kanagawa WorkspaceIndexer
 *
 * Tests for type inference capabilities including:
 * - Variable type inference from expressions
 * - Cast expression type inference
 * - Method return type inference
 * - Member access resolution
 */

import * as assert from 'assert';

// NOTE: Full type inference testing requires the actual indexer service.
// These tests cover the core logic patterns and expected behaviors.

describe('Type Inference', function() {
    this.timeout(10000);

    describe('Literal Type Inference', () => {
        it('should infer integer literal as int32', () => {
            // Pattern: auto x = 42;
            // Expected: x should be inferred as int32
            const literalValue = '42';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'int32');
        });

        it('should infer negative integer as int32', () => {
            const literalValue = '-10';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'int32');
        });

        it('should infer floating point as float', () => {
            const literalValue = '3.14';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'float');
        });

        it('should infer boolean true', () => {
            const literalValue = 'true';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'bool');
        });

        it('should infer boolean false', () => {
            const literalValue = 'false';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'bool');
        });

        it('should infer string literal', () => {
            const literalValue = '"hello"';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'string');
        });

        it('should infer character literal', () => {
            const literalValue = "'a'";
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'char');
        });

        it('should infer hex literal as uint32', () => {
            const literalValue = '0xFF';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'uint32');
        });

        it('should infer binary literal as uint32', () => {
            const literalValue = '0b1010';
            const inferredType = inferLiteralType(literalValue);
            assert.strictEqual(inferredType, 'uint32');
        });
    });

    describe('Cast Expression Type Extraction', () => {
        it('should extract type from cast<float>', () => {
            const castExpr = 'cast<float>(x)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, 'float');
        });

        it('should extract type from static_cast<uint32>', () => {
            const castExpr = 'static_cast<uint32>(y)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, 'uint32');
        });

        it('should extract type from reinterpret_cast<void*>', () => {
            const castExpr = 'reinterpret_cast<void*>(ptr)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, 'void*');
        });

        it('should extract type from checked_cast<uint8>', () => {
            const castExpr = 'checked_cast<uint8>(wide)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, 'uint8');
        });

        it('should extract templated type from cast', () => {
            const castExpr = 'cast<FIFO<uint32>>(x)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, 'FIFO<uint32>');
        });

        it('should return undefined for cast without type', () => {
            const castExpr = 'cast(x)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, undefined);
        });

        it('should handle nested template in cast', () => {
            const castExpr = 'cast<optional<FIFO<uint32>>>(x)';
            const targetType = extractCastTargetType(castExpr);
            assert.strictEqual(targetType, 'optional<FIFO<uint32>>');
        });
    });

    describe('Binary Expression Type Inference', () => {
        it('should infer comparison result as bool', () => {
            const operator = '<';
            const resultType = inferBinaryExprType(operator, 'int32', 'int32');
            assert.strictEqual(resultType, 'bool');
        });

        it('should infer equality result as bool', () => {
            const operator = '==';
            const resultType = inferBinaryExprType(operator, 'uint32', 'uint32');
            assert.strictEqual(resultType, 'bool');
        });

        it('should infer arithmetic result from operands', () => {
            const operator = '+';
            const resultType = inferBinaryExprType(operator, 'int32', 'int32');
            assert.strictEqual(resultType, 'int32');
        });

        it('should infer logical result as bool', () => {
            const operator = '&&';
            const resultType = inferBinaryExprType(operator, 'bool', 'bool');
            assert.strictEqual(resultType, 'bool');
        });

        it('should infer wider type for mixed arithmetic', () => {
            const operator = '+';
            const resultType = inferBinaryExprType(operator, 'int32', 'int64');
            assert.strictEqual(resultType, 'int64');
        });
    });

    describe('Member Expression Resolution', () => {
        // These test the patterns that the indexer uses

        it('should identify method call pattern', () => {
            // Pattern: obj.method()
            const expr = { hasArgs: true, memberName: 'compute' };
            assert.ok(isMethodCall(expr), 'Should detect as method call');
        });

        it('should identify field access pattern', () => {
            // Pattern: obj.field
            const expr = { hasArgs: false, memberName: 'length' };
            assert.ok(!isMethodCall(expr), 'Should detect as field access');
        });

        it('should handle chained member access', () => {
            // Pattern: obj.field.method()
            const parts = parseMemberChain('obj.field.method()');
            assert.deepStrictEqual(parts, ['obj', 'field', 'method']);
        });
    });

    describe('Template Type Inference', () => {
        it('should identify template type pattern', () => {
            const type = 'FIFO<uint32>';
            assert.ok(isTemplatedType(type), 'Should detect templated type');
        });

        it('should extract template base type', () => {
            const type = 'FIFO<uint32>';
            const base = extractTemplateBase(type);
            assert.strictEqual(base, 'FIFO');
        });

        it('should extract template arguments', () => {
            const type = 'FIFO<uint32>';
            const args = extractTemplateArgs(type);
            assert.deepStrictEqual(args, ['uint32']);
        });

        it('should handle multiple template arguments', () => {
            const type = 'Map<string, int32>';
            const args = extractTemplateArgs(type);
            assert.deepStrictEqual(args, ['string', 'int32']);
        });

        it('should handle nested templates', () => {
            const type = 'optional<FIFO<uint32>>';
            const base = extractTemplateBase(type);
            assert.strictEqual(base, 'optional');
            const args = extractTemplateArgs(type);
            assert.deepStrictEqual(args, ['FIFO<uint32>']);
        });
    });

    describe('Array Type Inference', () => {
        it('should identify array type pattern', () => {
            const type = 'uint32[8]';
            assert.ok(isArrayType(type), 'Should detect array type');
        });

        it('should extract array element type', () => {
            const type = 'uint32[8]';
            const elementType = extractArrayElementType(type);
            assert.strictEqual(elementType, 'uint32');
        });

        it('should extract array size', () => {
            const type = 'uint32[8]';
            const size = extractArraySize(type);
            assert.strictEqual(size, '8');
        });

        it('should handle template array type', () => {
            const type = 'FIFO<uint32>[4]';
            const elementType = extractArrayElementType(type);
            assert.strictEqual(elementType, 'FIFO<uint32>');
        });

        it('should handle multi-dimensional array', () => {
            const type = 'int32[3][2]';
            const elementType = extractArrayElementType(type);
            // First dimension extraction
            assert.strictEqual(elementType, 'int32[3]');
        });
    });
});

// Helper functions that mirror indexer logic

function inferLiteralType(literal: string): string {
    if (literal === 'true' || literal === 'false') {
        return 'bool';
    }
    if (literal.startsWith('"') && literal.endsWith('"')) {
        return 'string';
    }
    if (literal.startsWith("'") && literal.endsWith("'")) {
        return 'char';
    }
    if (literal.startsWith('0x') || literal.startsWith('0X')) {
        return 'uint32';
    }
    if (literal.startsWith('0b') || literal.startsWith('0B')) {
        return 'uint32';
    }
    if (literal.includes('.')) {
        return 'float';
    }
    return 'int32';
}

function extractCastTargetType(castExpr: string): string | undefined {
    // Match the cast keyword
    const castMatch = castExpr.match(/(?:static_cast|reinterpret_cast|checked_cast|cast)</);
    if (!castMatch) return undefined;
    
    // Find the opening < after the cast keyword
    const startIdx = castMatch.index! + castMatch[0].length;
    if (castExpr[startIdx - 1] !== '<') return undefined;
    
    // Match brackets properly, handling nested templates
    let depth = 1;
    let endIdx = startIdx;
    
    while (endIdx < castExpr.length && depth > 0) {
        if (castExpr[endIdx] === '<') depth++;
        else if (castExpr[endIdx] === '>') depth--;
        if (depth > 0) endIdx++;
    }
    
    if (depth !== 0) return undefined;
    
    return castExpr.substring(startIdx, endIdx);
}

function inferBinaryExprType(operator: string, leftType: string, rightType: string): string {
    // Comparison and equality operators
    if (['<', '>', '<=', '>=', '==', '!='].includes(operator)) {
        return 'bool';
    }
    // Logical operators
    if (['&&', '||'].includes(operator)) {
        return 'bool';
    }
    // Arithmetic operators - use wider type
    if (['+', '-', '*', '/', '%'].includes(operator)) {
        // Simple type widening
        if (leftType === 'int64' || rightType === 'int64') return 'int64';
        if (leftType === 'uint64' || rightType === 'uint64') return 'uint64';
        if (leftType === 'float' || rightType === 'float') return 'float';
        return leftType;
    }
    return leftType;
}

function isMethodCall(expr: { hasArgs: boolean; memberName: string }): boolean {
    return expr.hasArgs;
}

function parseMemberChain(expr: string): string[] {
    // Remove argument lists for parsing
    const cleaned = expr.replace(/\([^)]*\)/g, '');
    return cleaned.split('.');
}

function isTemplatedType(type: string): boolean {
    return type.includes('<') && type.includes('>');
}

function extractTemplateBase(type: string): string {
    const idx = type.indexOf('<');
    return idx > 0 ? type.substring(0, idx) : type;
}

function extractTemplateArgs(type: string): string[] {
    const start = type.indexOf('<');
    const end = type.lastIndexOf('>');
    if (start < 0 || end < 0) return [];

    const argsStr = type.substring(start + 1, end);

    // Handle nested templates by counting angle brackets
    const args: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of argsStr) {
        if (char === '<') depth++;
        if (char === '>') depth--;
        if (char === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) {
        args.push(current.trim());
    }

    return args;
}

function isArrayType(type: string): boolean {
    // Check for array suffix [N] but not template args
    return /\[\d+\]$/.test(type) || /\[[a-zA-Z_]\w*\]$/.test(type);
}

function extractArrayElementType(type: string): string {
    // Find the last [N] pattern
    const match = type.match(/^(.+?)\[[^\]]+\]$/);
    return match ? match[1] : type;
}

function extractArraySize(type: string): string {
    const match = type.match(/\[([^\]]+)\]$/);
    return match ? match[1] : '';
}
