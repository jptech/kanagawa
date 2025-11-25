/**
 * Template instantiation utilities for Kanagawa language support.
 * Handles parsing template arguments and substituting type parameters
 * to provide accurate type information for template instantiations.
 */

/**
 * Parsed template type information.
 */
export interface TemplateType {
    /** Base type name without arguments (e.g., "FIFO") */
    baseName: string;
    /** Template arguments (e.g., ["uint32", "32"]) */
    arguments: string[];
    /** Full type string (e.g., "FIFO<uint32, 32>") */
    fullType: string;
}

/**
 * Template parameter definition.
 */
export interface TemplateParameter {
    /** Parameter name (e.g., "T", "N") */
    name: string;
    /** Parameter kind: 'type' or 'value' */
    kind: 'type' | 'value';
    /** Default value if any */
    defaultValue?: string;
    /** Constraint if any */
    constraint?: string;
}

/**
 * Result of template instantiation.
 */
export interface TemplateInstantiation {
    /** The base template type */
    baseType: string;
    /** Mapping from parameter name to actual argument */
    substitutions: Map<string, string>;
    /** The fully instantiated type string */
    instantiatedType: string;
}

/**
 * Checks if a type string contains template arguments.
 * 
 * @example
 * isTemplatedType("FIFO<int, 32>") → true
 * isTemplatedType("FIFO") → false
 */
export function isTemplatedType(typeName: string): boolean {
    const trimmed = typeName.trim();
    const angleStart = trimmed.indexOf('<');
    const angleEnd = trimmed.lastIndexOf('>');
    return angleStart > 0 && angleEnd > angleStart;
}

/**
 * Parses a template type string into its components.
 * 
 * @example
 * parseTemplateType("FIFO<uint32, 32>") → { baseName: "FIFO", arguments: ["uint32", "32"], fullType: "FIFO<uint32, 32>" }
 * parseTemplateType("Map<string, List<int>>") → { baseName: "Map", arguments: ["string", "List<int>"], fullType: "..." }
 */
export function parseTemplateType(typeName: string): TemplateType | undefined {
    const trimmed = typeName.trim();
    const angleStart = trimmed.indexOf('<');
    
    if (angleStart <= 0) {
        return undefined;
    }
    
    const angleEnd = findMatchingCloseBracket(trimmed, angleStart);
    if (angleEnd < 0) {
        return undefined;
    }
    
    const baseName = trimmed.substring(0, angleStart).trim();
    const argsString = trimmed.substring(angleStart + 1, angleEnd);
    const args = parseTemplateArguments(argsString);
    
    return {
        baseName,
        arguments: args,
        fullType: trimmed
    };
}

/**
 * Finds the matching closing bracket for an opening bracket.
 * Handles nested brackets correctly.
 */
export function findMatchingCloseBracket(text: string, openPos: number): number {
    let depth = 0;
    for (let i = openPos; i < text.length; i++) {
        const ch = text[i];
        if (ch === '<') {
            depth++;
        } else if (ch === '>') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Parses template arguments from a comma-separated string.
 * Handles nested templates correctly.
 * 
 * @example
 * parseTemplateArguments("uint32, 32") → ["uint32", "32"]
 * parseTemplateArguments("string, List<int>") → ["string", "List<int>"]
 */
export function parseTemplateArguments(argsString: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let currentArg = '';
    
    for (let i = 0; i < argsString.length; i++) {
        const ch = argsString[i];
        
        if (ch === '<') {
            depth++;
            currentArg += ch;
        } else if (ch === '>') {
            depth--;
            currentArg += ch;
        } else if (ch === ',' && depth === 0) {
            const trimmed = currentArg.trim();
            if (trimmed) {
                args.push(trimmed);
            }
            currentArg = '';
        } else {
            currentArg += ch;
        }
    }
    
    // Add final argument
    const trimmed = currentArg.trim();
    if (trimmed) {
        args.push(trimmed);
    }
    
    return args;
}

/**
 * Extracts the base type from a possibly-templated type.
 * 
 * @example
 * extractBaseType("FIFO<int, 32>") → "FIFO"
 * extractBaseType("FIFO") → "FIFO"
 */
export function extractBaseType(typeName: string): string {
    const trimmed = typeName.trim();
    const angleStart = trimmed.indexOf('<');
    return angleStart > 0 ? trimmed.substring(0, angleStart).trim() : trimmed;
}

/**
 * Creates a template instantiation by mapping parameters to arguments.
 */
export function createInstantiation(
    baseType: string,
    parameters: TemplateParameter[],
    args: string[]
): TemplateInstantiation {
    const substitutions = new Map<string, string>();
    
    // Map each parameter to its argument (or default)
    for (let i = 0; i < parameters.length; i++) {
        const param = parameters[i];
        const arg = i < args.length ? args[i] : param.defaultValue;
        if (arg) {
            substitutions.set(param.name, arg);
        }
    }
    
    // Build instantiated type string
    const argStrings = parameters.map((p, i) => 
        i < args.length ? args[i] : p.defaultValue ?? p.name
    );
    const instantiatedType = argStrings.length > 0
        ? `${baseType}<${argStrings.join(', ')}>`
        : baseType;
    
    return {
        baseType,
        substitutions,
        instantiatedType
    };
}

/**
 * Substitutes template parameters in a type string.
 * 
 * @example
 * substituteParameters("optional<T>", new Map([["T", "uint32"]])) → "optional<uint32>"
 * substituteParameters("T", new Map([["T", "int"]])) → "int"
 */
export function substituteParameters(
    typeString: string,
    substitutions: Map<string, string>
): string {
    if (substitutions.size === 0) {
        return typeString;
    }
    
    let result = typeString;
    
    // Sort by length descending to handle longer names first
    // This prevents "T" from matching in "TValue"
    const sortedParams = Array.from(substitutions.keys())
        .sort((a, b) => b.length - a.length);
    
    for (const param of sortedParams) {
        const replacement = substitutions.get(param)!;
        // Replace whole word matches only
        const regex = new RegExp(`\\b${escapeRegExp(param)}\\b`, 'g');
        result = result.replace(regex, replacement);
    }
    
    return result;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Infers template arguments from a method call context.
 * 
 * @example
 * For a call `fifo.push(value)` where `fifo` is `FIFO<uint32, 32>`:
 * The method signature `void push(T value)` becomes `void push(uint32 value)`
 */
export function instantiateMethodSignature(
    signature: string,
    instantiation: TemplateInstantiation
): string {
    return substituteParameters(signature, instantiation.substitutions);
}

/**
 * Extracts the return type from a method signature after substitution.
 * 
 * @example
 * extractReturnType("T pop()") → "T"
 * extractReturnType("void push(T value)") → "void"
 */
export function extractReturnTypeFromSignature(signature: string): string | undefined {
    const trimmed = signature.trim();
    
    // Handle various signature formats
    // "T pop()" → "T"
    // "optional<T> tryPop()" → "optional<T>"
    // "void push(T value)" → "void"
    
    // Find the function name (identifier followed by parenthesis)
    const parenIndex = trimmed.indexOf('(');
    if (parenIndex < 0) {
        return undefined;
    }
    
    const beforeParen = trimmed.substring(0, parenIndex).trim();
    
    // Split by whitespace to get return type and name
    const lastSpaceIndex = beforeParen.lastIndexOf(' ');
    if (lastSpaceIndex < 0) {
        // No space means no explicit return type (could be constructor)
        return undefined;
    }
    
    const returnType = beforeParen.substring(0, lastSpaceIndex).trim();
    return returnType || undefined;
}

/**
 * Gets the instantiated return type for a method call.
 */
export function getInstantiatedReturnType(
    signature: string,
    instantiation: TemplateInstantiation
): string | undefined {
    const returnType = extractReturnTypeFromSignature(signature);
    if (!returnType) {
        return undefined;
    }
    
    return substituteParameters(returnType, instantiation.substitutions);
}

/**
 * Parses template parameters from a template declaration.
 * 
 * @example
 * parseTemplateParameters("<T, uint32 N>") → [
 *   { name: "T", kind: "type" },
 *   { name: "N", kind: "value" }
 * ]
 */
export function parseTemplateParameters(paramString: string): TemplateParameter[] {
    // Remove angle brackets if present
    let content = paramString.trim();
    if (content.startsWith('<') && content.endsWith('>')) {
        content = content.substring(1, content.length - 1);
    }
    
    const params: TemplateParameter[] = [];
    const args = parseTemplateArguments(content);
    
    for (const arg of args) {
        const trimmed = arg.trim();
        
        // Check for default value
        const eqIndex = trimmed.indexOf('=');
        let paramPart = eqIndex >= 0 ? trimmed.substring(0, eqIndex).trim() : trimmed;
        const defaultValue = eqIndex >= 0 ? trimmed.substring(eqIndex + 1).trim() : undefined;
        
        // Parse the parameter
        const parts = paramPart.split(/\s+/);
        
        if (parts.length === 1) {
            // Just a type parameter like "T"
            params.push({
                name: parts[0],
                kind: 'type',
                defaultValue
            });
        } else if (parts.length >= 2) {
            // Value parameter like "uint32 N" or constrained type
            const name = parts[parts.length - 1];
            const constraint = parts.slice(0, -1).join(' ');
            
            // Heuristic: if constraint looks like a type, it's a value parameter
            const isValueParam = /^(u?int\d+|bool|float|double|size_t|char)$/i.test(constraint);
            
            params.push({
                name,
                kind: isValueParam ? 'value' : 'type',
                constraint,
                defaultValue
            });
        }
    }
    
    return params;
}

/**
 * Builds a cache key for template instantiation caching.
 */
export function buildInstantiationKey(baseType: string, args: string[]): string {
    return `${baseType}<${args.join(',')}>`;
}

/**
 * Normalizes a template type string for comparison.
 */
export function normalizeTemplateType(typeName: string): string {
    const parsed = parseTemplateType(typeName);
    if (!parsed) {
        return typeName.trim();
    }
    
    // Normalize arguments
    const normalizedArgs = parsed.arguments.map(arg => normalizeTemplateType(arg));
    return `${parsed.baseName}<${normalizedArgs.join(', ')}>`;
}
