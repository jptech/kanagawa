/**
 * Symbol utilities for qualified name computation and module matching.
 * These are pure functions that can be unit tested independently.
 */

/**
 * Computes the fully-qualified name for a symbol given its name and scope path.
 * 
 * @example
 * computeQualifiedName("push", ["data.fifo", "FIFO"]) → "data.fifo::FIFO::push"
 * computeQualifiedName("FIFO", ["data.fifo"]) → "data.fifo::FIFO"
 * computeQualifiedName("helper", []) → "helper"
 */
export function computeQualifiedName(name: string, scopePath: string[]): string {
    if (scopePath.length === 0) {
        return name;
    }
    return [...scopePath, name].join('::');
}

/**
 * Parses a qualified name into its components.
 * 
 * @example
 * parseQualifiedName("data.fifo::FIFO::push") → { module: "data.fifo", path: ["FIFO"], name: "push" }
 * parseQualifiedName("FIFO") → { module: undefined, path: [], name: "FIFO" }
 */
export function parseQualifiedName(qualifiedName: string): {
    module: string | undefined;
    path: string[];
    name: string;
} {
    const parts = qualifiedName.split('::');
    if (parts.length === 0) {
        return { module: undefined, path: [], name: qualifiedName };
    }
    
    const name = parts[parts.length - 1];
    const containerParts = parts.slice(0, -1);
    
    // First part with a dot is likely the module path
    const module = containerParts.length > 0 && containerParts[0].includes('.')
        ? containerParts[0]
        : undefined;
    
    const path = module ? containerParts.slice(1) : containerParts;
    
    return { module, path, name };
}

/**
 * Checks if a module path matches an import statement.
 * Handles exact matches, suffix matches, and aliases.
 * 
 * @example
 * moduleMatchesImport("data.fifo", { path: "data.fifo" }) → true
 * moduleMatchesImport("data.fifo", { path: "fifo", alias: "fifo" }) → false (path doesn't match)
 * moduleMatchesImport("data.fifo", { path: "data.fifo", alias: "df" }) → true
 */
export function moduleMatchesImport(
    modulePath: string,
    importEntry: { path: string; alias?: string }
): boolean {
    // Exact match
    if (importEntry.path === modulePath) {
        return true;
    }
    
    // Module ends with import path (e.g., "data.fifo" matches import "fifo")
    if (modulePath.endsWith('.' + importEntry.path)) {
        return true;
    }
    
    // Import path ends with module (e.g., import "data.fifo.FIFO" matches module "data.fifo")
    if (importEntry.path.startsWith(modulePath + '.')) {
        return true;
    }
    
    return false;
}

/**
 * Extracts the last segment of a module path.
 * 
 * @example
 * getModuleTail("data.fifo") → "fifo"
 * getModuleTail("control") → "control"
 */
export function getModuleTail(modulePath: string): string {
    const lastDot = modulePath.lastIndexOf('.');
    return lastDot >= 0 ? modulePath.slice(lastDot + 1) : modulePath;
}

/**
 * Checks if a symbol is accessible from a document given its imports.
 * A symbol is accessible if:
 * 1. It's in the same module as the document
 * 2. It's in a module that's imported by the document
 * 3. It's a top-level symbol (no module scope)
 */
export function isSymbolAccessible(
    symbolModule: string | undefined,
    documentModule: string | undefined,
    imports: { path: string; alias?: string }[]
): boolean {
    // No module = global scope, always accessible
    if (!symbolModule) {
        return true;
    }
    
    // Same module
    if (documentModule && symbolModule === documentModule) {
        return true;
    }
    
    // Check imports
    for (const imp of imports) {
        if (moduleMatchesImport(symbolModule, imp)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Computes an accessibility score for sorting symbols.
 * Higher score = more accessible/relevant.
 */
export function computeAccessibilityScore(
    symbolModule: string | undefined,
    symbolScopePath: string[],
    documentModule: string | undefined,
    imports: { path: string; alias?: string }[],
    currentScopePath: string[]
): number {
    let score = 0;
    
    // Same module is highly preferred
    if (symbolModule && documentModule && symbolModule === documentModule) {
        score += 100;
    }
    
    // Global symbols get a small bonus
    if (!symbolModule) {
        score += 20;
    }
    
    // Imported modules get a bonus
    if (symbolModule) {
        for (const imp of imports) {
            if (moduleMatchesImport(symbolModule, imp)) {
                score += 50;
                break;
            }
        }
    }
    
    // Scope path similarity bonus
    const commonPrefix = countCommonPrefix(currentScopePath, symbolScopePath);
    score += commonPrefix * 10;
    
    // Exact scope match is very high
    if (arraysEqual(currentScopePath, symbolScopePath)) {
        score += 200;
    }
    
    return score;
}

/**
 * Counts the common prefix length between two arrays.
 */
export function countCommonPrefix(a: string[], b: string[]): number {
    let count = 0;
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
        if (a[i] === b[i]) {
            count++;
        } else {
            break;
        }
    }
    return count;
}

/**
 * Checks if two string arrays are equal.
 */
export function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Result of a symbol resolution with confidence information.
 */
export interface ResolutionResult<T> {
    /** The best match, if any */
    primary: T | undefined;
    /** Confidence level of the resolution */
    confidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
    /** Alternative matches (if ambiguous) */
    alternatives: T[];
    /** Total number of candidates considered */
    totalCandidates: number;
}

/**
 * Creates a resolution result from a sorted list of candidates.
 */
export function createResolutionResult<T>(
    sortedCandidates: T[],
    scoreGetter: (item: T) => number,
    exactThreshold: number = 150,
    highThreshold: number = 100
): ResolutionResult<T> {
    if (sortedCandidates.length === 0) {
        return {
            primary: undefined,
            confidence: 'none',
            alternatives: [],
            totalCandidates: 0
        };
    }
    
    const primary = sortedCandidates[0];
    const primaryScore = scoreGetter(primary);
    const alternatives = sortedCandidates.slice(1);
    
    // Single candidate is exact
    if (sortedCandidates.length === 1) {
        return {
            primary,
            confidence: primaryScore >= highThreshold ? 'exact' : 'high',
            alternatives: [],
            totalCandidates: 1
        };
    }
    
    // Check score gap to determine confidence
    const secondScore = scoreGetter(sortedCandidates[1]);
    const scoreGap = primaryScore - secondScore;
    
    let confidence: ResolutionResult<T>['confidence'];
    if (primaryScore >= exactThreshold && scoreGap >= 50) {
        confidence = 'exact';
    } else if (primaryScore >= highThreshold && scoreGap >= 30) {
        confidence = 'high';
    } else if (scoreGap >= 20) {
        confidence = 'medium';
    } else {
        confidence = 'low';
    }
    
    return {
        primary,
        confidence,
        alternatives,
        totalCandidates: sortedCandidates.length
    };
}
