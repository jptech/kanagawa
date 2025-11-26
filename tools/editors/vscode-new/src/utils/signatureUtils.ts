/**
 * Signature parsing utilities for Kanagawa language support.
 * Handles parsing function signatures to extract parameter names,
 * stripping attributes, and other signature-related operations.
 */

import { stripComments } from './templateUtils';

/**
 * Strips attribute annotations [[...]] from a signature.
 * Handles nested brackets correctly.
 * 
 * @example
 * stripAttributes("[[max_threads(1)]] void func()") → "void func()"
 * stripAttributes("[[inline]] [[deprecated]] void f()") → "void f()"
 */
export function stripAttributes(signature: string): string {
    let result = '';
    let i = 0;
    
    while (i < signature.length) {
        // Check for [[
        if (i + 1 < signature.length && signature[i] === '[' && signature[i + 1] === '[') {
            // Skip until we find matching ]]
            let depth = 1;
            i += 2;
            while (i < signature.length && depth > 0) {
                if (i + 1 < signature.length && signature[i] === '[' && signature[i + 1] === '[') {
                    depth++;
                    i += 2;
                } else if (i + 1 < signature.length && signature[i] === ']' && signature[i + 1] === ']') {
                    depth--;
                    i += 2;
                } else {
                    i++;
                }
            }
        } else {
            result += signature[i];
            i++;
        }
    }
    
    return result.trim();
}

/**
 * Extracts the function parameter content from a signature.
 * Finds the parameter list parentheses (not template args or nested calls).
 * 
 * @example
 * extractFunctionParameters("optional<T> func(A a, B b)") → "A a, B b"
 * extractFunctionParameters("void func()") → ""
 */
export function extractFunctionParameters(signature: string): string | undefined {
    // Find all top-level parenthesized groups
    // The function parameters should be the last one at depth 0
    let depth = 0;
    let lastOpenParen = -1;
    let lastCloseParen = -1;
    
    for (let i = 0; i < signature.length; i++) {
        const ch = signature[i];
        
        if (ch === '<') {
            depth++;
        } else if (ch === '>') {
            depth--;
        } else if (ch === '(' && depth === 0) {
            // Track this as a potential parameter list start
            lastOpenParen = i;
        } else if (ch === ')' && depth === 0 && lastOpenParen !== -1) {
            // This closes the parameter list
            lastCloseParen = i;
        }
    }
    
    if (lastOpenParen !== -1 && lastCloseParen > lastOpenParen) {
        return signature.substring(lastOpenParen + 1, lastCloseParen);
    }
    
    return undefined;
}

/**
 * Splits parameters handling nested templates and parentheses.
 * 
 * @example
 * splitParameters("Map<K,V> m, int n") → ["Map<K,V> m", "int n"]
 */
export function splitParameters(params: string): string[] {
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

/**
 * Checks if a name looks like a type name rather than a parameter name.
 */
export function isTypeName(name: string): boolean {
    const types = ['void', 'bool', 'int', 'uint', 'auto', 'char', 'float', 'double'];
    return types.includes(name) || 
           /^(u?int\d+|uint\d+_t|float\d+)$/.test(name) ||
           /^[A-Z]/.test(name); // PascalCase is likely a type
}

/**
 * Parses parameter names from a function signature.
 * Handles attributes, comments, template types, and default values.
 * 
 * @example
 * parseParameterNames("void push(T value, bool block)") → ["value", "block"]
 * parseParameterNames("[[max_threads(1)]] void f(int x)") → ["x"]
 */
export function parseParameterNames(signature: string): string[] {
    const names: string[] = [];
    
    // Strip attribute annotations first
    const withoutAttrs = stripAttributes(signature);
    
    // Strip comments
    const cleanedSignature = stripComments(withoutAttrs);
    
    // Extract function parameters
    const params = extractFunctionParameters(cleanedSignature);
    if (!params || !params.trim()) { return names; }

    // Split by comma, handling nested templates
    const paramList = splitParameters(params);

    for (const param of paramList) {
        // Extract the parameter name (last identifier before any default value)
        const trimmed = param.trim();
        
        // Remove default value
        const withoutDefault = trimmed.split('=')[0].trim();
        
        // Find the last word (parameter name)
        const parts = withoutDefault.split(/\s+/);
        if (parts.length > 0) {
            const name = parts[parts.length - 1]
                .replace(/[&*\[\]]/g, '') // Remove pointer/reference/array markers
                .trim();
            if (name && !isTypeName(name)) {
                names.push(name);
            }
        }
    }

    return names;
}
