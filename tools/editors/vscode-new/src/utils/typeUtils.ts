/**
 * Pure utility functions for type inference and manipulation.
 * These functions are extracted from WorkspaceIndexer to enable unit testing
 * without VS Code dependencies.
 */

/**
 * Normalizes a type name by removing:
 * - const prefix
 * - Template arguments (after <)
 * - Namespace/module prefixes (:: and .)
 * - Whitespace
 */
export function normalizeTypeName(raw: string): string {
    if (!raw) { return ''; }
    let text = raw.trim();
    text = text.replace(/^const\s+/, '');
    const angleIndex = text.indexOf('<');
    if (angleIndex !== -1) {
        text = text.slice(0, angleIndex);
    }
    const doubleSep = text.lastIndexOf('::');
    if (doubleSep !== -1) {
        text = text.slice(doubleSep + 2);
    }
    const dotSep = text.lastIndexOf('.');
    if (dotSep !== -1) {
        text = text.slice(dotSep + 1);
    }
    return text.replace(/\s+/g, '');
}

/**
 * Cleans up type text by normalizing whitespace.
 */
export function sanitizeTypeText(text?: string): string | undefined {
    if (!text) { return undefined; }
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts the last segment of a dotted or double-colon separated path.
 */
export function lastSegment(value: string): string {
    const parts = value.split('.');
    return parts[parts.length - 1] ?? value;
}

/**
 * Infers the type from a literal value string.
 */
export function inferLiteralType(literalText: string): string {
    const trimmed = literalText.trim();
    
    // Boolean literals
    if (trimmed === 'true' || trimmed === 'false') {
        return 'bool';
    }
    
    // String literal
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return 'string';
    }
    
    // Character literal
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return 'char';
    }
    
    // Hex literal
    if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
        return 'uint32';
    }
    
    // Binary literal
    if (trimmed.startsWith('0b') || trimmed.startsWith('0B')) {
        return 'uint32';
    }
    
    // Float literal (contains decimal point or exponent)
    if (trimmed.includes('.') || /[eE][+-]?\d/.test(trimmed)) {
        return 'float';
    }
    
    // Default to int32 for integer literals
    return 'int32';
}

/**
 * Extracts the target type from a cast expression string.
 * Handles nested templates properly by counting angle brackets.
 * 
 * Examples:
 * - "cast<float>(x)" → "float"
 * - "static_cast<uint32>(y)" → "uint32"  
 * - "cast<FIFO<uint32>>(z)" → "FIFO<uint32>"
 */
export function extractCastTargetTypeFromText(castExpr: string): string | undefined {
    // Match the cast keyword followed by <
    const castMatch = castExpr.match(/(?:static_cast|reinterpret_cast|checked_cast|cast)</);
    if (!castMatch) { return undefined; }
    
    // Find the opening < after the cast keyword
    const startIdx = castMatch.index! + castMatch[0].length;
    if (castExpr[startIdx - 1] !== '<') { return undefined; }
    
    // Match brackets properly, handling nested templates
    let depth = 1;
    let endIdx = startIdx;
    
    while (endIdx < castExpr.length && depth > 0) {
        if (castExpr[endIdx] === '<') { depth++; }
        else if (castExpr[endIdx] === '>') { depth--; }
        if (depth > 0) { endIdx++; }
    }
    
    if (depth !== 0) { return undefined; }
    
    return castExpr.substring(startIdx, endIdx);
}

/**
 * Infers the result type of a binary expression.
 */
export function inferBinaryExpressionType(
    operator: string,
    leftType: string,
    rightType: string
): string {
    // Comparison operators return bool
    if (['<', '>', '<=', '>=', '==', '!='].includes(operator)) {
        return 'bool';
    }
    
    // Logical operators return bool
    if (['&&', '||', 'and', 'or'].includes(operator)) {
        return 'bool';
    }
    
    // Bitwise operators preserve type
    if (['&', '|', '^', '~', '<<', '>>'].includes(operator)) {
        return leftType;
    }
    
    // Arithmetic with type promotion
    if (['+', '-', '*', '/', '%'].includes(operator)) {
        // Basic type widening rules
        if (leftType === 'float' || rightType === 'float') { return 'float'; }
        if (leftType === 'float32' || rightType === 'float32') { return 'float32'; }
        if (leftType === 'float64' || rightType === 'float64') { return 'float64'; }
        if (leftType === 'int64' || rightType === 'int64') { return 'int64'; }
        if (leftType === 'uint64' || rightType === 'uint64') { return 'uint64'; }
        return leftType;
    }
    
    return leftType;
}

/**
 * Checks if a type string represents an array type.
 */
export function isArrayType(typeStr: string): boolean {
    // Check for array suffix [N] but not template args
    return /\[[^\]]+\]$/.test(typeStr);
}

/**
 * Extracts the element type from an array type string.
 */
export function extractArrayElementType(typeStr: string): string {
    const match = typeStr.match(/^(.+)\[[^\]]+\]$/);
    return match ? match[1] : typeStr;
}

/**
 * Checks if a type string is a templated type (contains < >).
 */
export function isTemplatedType(typeStr: string): boolean {
    return typeStr.includes('<') && typeStr.includes('>');
}

/**
 * Extracts the base type name from a templated type.
 * Example: "FIFO<uint32>" → "FIFO"
 */
export function extractTemplateBase(typeStr: string): string {
    const idx = typeStr.indexOf('<');
    return idx > 0 ? typeStr.substring(0, idx) : typeStr;
}

/**
 * Extracts template arguments from a templated type string.
 * Handles nested templates properly.
 * Example: "Map<string, int32>" → ["string", "int32"]
 */
export function extractTemplateArgs(typeStr: string): string[] {
    const start = typeStr.indexOf('<');
    const end = typeStr.lastIndexOf('>');
    if (start < 0 || end < 0 || end <= start) { return []; }

    const argsStr = typeStr.substring(start + 1, end);

    // Handle nested templates by counting angle brackets
    const args: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of argsStr) {
        if (char === '<') { depth++; }
        if (char === '>') { depth--; }
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
