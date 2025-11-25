/**
 * Import resolution utilities for Kanagawa language support.
 * Handles module path matching, import resolution, and accessibility checking.
 */

import { DocumentImport } from '../service/indexer';

/**
 * Information about what a module exports.
 */
export interface ModuleExports {
    /** The full module path (e.g., "data.fifo") */
    modulePath: string;
    /** Qualified names of all exported symbols */
    exportedSymbols: Set<string>;
    /** Simple names of exported symbols (for quick lookup) */
    exportedNames: Set<string>;
}

/**
 * Result of resolving imports for a document.
 */
export interface ResolvedImports {
    /** The module path of the current document, if any */
    currentModule?: string;
    /** Set of module paths that are directly imported */
    importedModules: Set<string>;
    /** Map of alias → module path for aliased imports */
    aliasToModule: Map<string, string>;
    /** Set of qualified names accessible through imports */
    accessibleQualifiedNames: Set<string>;
}

/**
 * Normalizes a module path for consistent comparison.
 * Removes leading/trailing dots and normalizes separators.
 */
export function normalizeModulePath(path: string): string {
    return path.trim().replace(/^\.+|\.+$/g, '');
}

/**
 * Checks if a module path matches an import path.
 * Handles exact matches, suffix matches, and prefix matches.
 * 
 * @example
 * matchesImportPath("data.fifo", "data.fifo") → true
 * matchesImportPath("data.fifo", "fifo") → true (suffix match)
 * matchesImportPath("data.fifo.FIFO", "data.fifo") → true (prefix match for specific symbols)
 */
export function matchesImportPath(modulePath: string, importPath: string): boolean {
    const normalizedModule = normalizeModulePath(modulePath);
    const normalizedImport = normalizeModulePath(importPath);
    
    // Exact match
    if (normalizedModule === normalizedImport) {
        return true;
    }
    
    // Import is a suffix of module (e.g., import "fifo" matches "data.fifo")
    if (normalizedModule.endsWith('.' + normalizedImport)) {
        return true;
    }
    
    // Import is more specific than module (e.g., import "data.fifo.FIFO" for module "data.fifo")
    if (normalizedImport.startsWith(normalizedModule + '.')) {
        return true;
    }
    
    return false;
}

/**
 * Extracts the module path from a qualified name.
 * The module path is the first component if it contains dots.
 * 
 * @example
 * extractModuleFromQualified("data.fifo::FIFO::push") → "data.fifo"
 * extractModuleFromQualified("FIFO::push") → undefined
 */
export function extractModuleFromQualified(qualifiedName: string): string | undefined {
    const parts = qualifiedName.split('::');
    if (parts.length === 0) {
        return undefined;
    }
    const first = parts[0];
    return first.includes('.') ? first : undefined;
}

/**
 * Extracts the container path from a qualified name (everything except the final name).
 * 
 * @example
 * extractContainerPath("data.fifo::FIFO::push") → "data.fifo::FIFO"
 * extractContainerPath("FIFO") → undefined
 */
export function extractContainerPath(qualifiedName: string): string | undefined {
    const lastSep = qualifiedName.lastIndexOf('::');
    return lastSep > 0 ? qualifiedName.substring(0, lastSep) : undefined;
}

/**
 * Resolves imports for a document and determines what symbols are accessible.
 */
export function resolveImports(
    currentModule: string | undefined,
    imports: DocumentImport[],
    moduleExportsMap: Map<string, ModuleExports>
): ResolvedImports {
    const result: ResolvedImports = {
        currentModule,
        importedModules: new Set(),
        aliasToModule: new Map(),
        accessibleQualifiedNames: new Set()
    };
    
    // Add symbols from current module (always accessible)
    if (currentModule) {
        const ownExports = moduleExportsMap.get(currentModule);
        if (ownExports) {
            for (const qn of ownExports.exportedSymbols) {
                result.accessibleQualifiedNames.add(qn);
            }
        }
    }
    
    // Process each import
    for (const imp of imports) {
        const normalizedPath = normalizeModulePath(imp.path);
        
        // Find matching modules
        for (const [modulePath, exports] of moduleExportsMap) {
            if (matchesImportPath(modulePath, normalizedPath)) {
                result.importedModules.add(modulePath);
                
                if (imp.alias) {
                    result.aliasToModule.set(imp.alias, modulePath);
                }
                
                // Add all exported symbols from this module
                for (const qn of exports.exportedSymbols) {
                    result.accessibleQualifiedNames.add(qn);
                }
            }
        }
    }
    
    return result;
}

/**
 * Checks if a qualified name is accessible given resolved imports.
 */
export function isQualifiedNameAccessible(
    qualifiedName: string,
    resolvedImports: ResolvedImports
): boolean {
    // Check if directly accessible
    if (resolvedImports.accessibleQualifiedNames.has(qualifiedName)) {
        return true;
    }
    
    // Check if it's in the current module
    const module = extractModuleFromQualified(qualifiedName);
    if (module && module === resolvedImports.currentModule) {
        return true;
    }
    
    // Check if the module is imported
    if (module && resolvedImports.importedModules.has(module)) {
        return true;
    }
    
    // No module means global scope - always accessible
    if (!module) {
        return true;
    }
    
    return false;
}

/**
 * Computes an import-aware accessibility score for a symbol.
 * Higher scores indicate more accessible symbols.
 */
export function computeImportScore(
    qualifiedName: string,
    modulePath: string | undefined,
    resolvedImports: ResolvedImports
): number {
    let score = 0;
    
    // Same module gets highest priority
    if (modulePath && modulePath === resolvedImports.currentModule) {
        score += 100;
    }
    
    // Directly accessible through imports
    if (resolvedImports.accessibleQualifiedNames.has(qualifiedName)) {
        score += 50;
    }
    
    // Module is imported
    if (modulePath && resolvedImports.importedModules.has(modulePath)) {
        score += 40;
    }
    
    // Global scope (no module) gets base accessibility
    if (!modulePath) {
        score += 20;
    }
    
    return score;
}

/**
 * Filters and sorts symbols by accessibility from a document.
 */
export function filterByAccessibility<T extends { qualifiedName: string; scopePath: string[] }>(
    symbols: T[],
    resolvedImports: ResolvedImports,
    options?: { includeInaccessible?: boolean }
): T[] {
    const includeInaccessible = options?.includeInaccessible ?? false;
    
    // Score each symbol
    const scored = symbols.map(sym => {
        // Extract module from qualified name or scope path
        const modulePath = extractModuleFromQualified(sym.qualifiedName)
            ?? (sym.scopePath.length > 0 ? sym.scopePath[0] : undefined);
        const score = computeImportScore(sym.qualifiedName, modulePath, resolvedImports);
        const accessible = isQualifiedNameAccessible(sym.qualifiedName, resolvedImports);
        return { symbol: sym, score, accessible };
    });
    
    // Filter out inaccessible unless requested
    const filtered = includeInaccessible
        ? scored
        : scored.filter(s => s.accessible || s.score > 0);
    
    // Sort by score descending
    filtered.sort((a, b) => b.score - a.score);
    
    return filtered.map(s => s.symbol);
}
