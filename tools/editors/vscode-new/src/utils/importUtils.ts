/**
 * Import resolution utilities for Kanagawa language support.
 * Handles module path matching, import resolution, and accessibility checking.
 * 
 * Key concepts:
 * - Explicit exports: Symbols listed in `module foo { symbol1, symbol2 }`
 * - Re-exports: `module foo { module bar }` re-exposes all of bar's exports
 * - Module difference: `module foo { module foo \ .cmdargs }` exposes foo's symbols minus cmdargs
 * - Implicit base: All files automatically `import base` unless disabled
 */

import { DocumentImport } from '../service/indexer';

/** Maximum depth for transitive re-export resolution to prevent infinite loops */
const MAX_REEXPORT_DEPTH = 10;

/**
 * Information about what a module explicitly exports.
 * This is parsed from the module declaration syntax:
 * `module foo.bar { symbol1, symbol2, module other.module }`
 */
export interface ModuleExports {
    /** The full module path (e.g., "data.fifo") */
    modulePath: string;
    /** Qualified names of all exported symbols (built after indexing) */
    exportedSymbols: Set<string>;
    /** Simple names of exported symbols (for quick lookup) */
    exportedNames: Set<string>;
    /** 
     * Explicitly listed symbol names in the export list.
     * Empty means "export all" (legacy behavior) or no export list parsed yet.
     */
    explicitExports: Set<string>;
    /**
     * Module paths that are re-exported via `module <path>` syntax.
     * Symbols from these modules become accessible when this module is imported.
     */
    reExportedModules: Set<string>;
    /**
     * Module difference exclusions via `module <base> \ <exclude>` syntax.
     * Maps base module path to excluded module path.
     */
    moduleDifferences: Map<string, string>;
    /**
     * Flattened set of all accessible qualified names including re-exports.
     * Computed lazily and cached after buildModuleExports().
     */
    resolvedExports?: Set<string>;
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
 * The module path is the first component (module names can be single-segment like `base`).
 * 
 * @example
 * extractModuleFromQualified("data.fifo::FIFO::push") → "data.fifo"
 * extractModuleFromQualified("base::uint32") → "base"
 * extractModuleFromQualified("FIFO::push") → undefined
 */
export function extractModuleFromQualified(qualifiedName: string): string | undefined {
    const parts = qualifiedName.split('::');
    // No scope separator means no module prefix.
    if (parts.length <= 1) {
        return undefined;
    }
    const first = parts[0];
    return first.length > 0 ? first : undefined;
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
 * Checks if a qualified name represents a class/struct member (nested symbol).
 * 
 * Class members should only be accessible via qualified access through the class,
 * not as bare identifiers. This prevents resolving `count_t` to a private
 * type alias inside some class when a module-level `count_t` should be used.
 * 
 * Detection logic:
 * - If first segment has '.', it's a module path: module::Type is level 0, module::Type::member is level 1+
 * - If first segment has no '.', we can't distinguish Type from module, so we need >= 3 segments
 * 
 * @example
 * isClassMember("data.fifo::FIFO::push") → true (push is inside FIFO class)
 * isClassMember("data.fifo::FIFO") → false (FIFO is module-level)
 * isClassMember("base::count_t") → false (count_t is module-level)
 * isClassMember("FIFO::push") → false (can't determine without module, be conservative)
 * isClassMember("data.counter.saturating::saturating_counter::count_t") → true
 */
export function isClassMember(qualifiedName: string): boolean {
    const parts = qualifiedName.split('::');
    
    if (parts.length < 2) {
        return false; // Single name, not nested
    }
    
    // Module::Type = 2 parts, NOT a member
    // Module::Type::member = 3 parts, IS a member
    //
    // Kanagawa modules can be single-segment (e.g., `base`, `counter`), so
    // we treat 3+ segments as a member regardless of whether the module has dots.
    return parts.length >= 3;
}

/**
 * Determines if a symbol is a class/struct member based on its scope path.
 * This is more accurate than isClassMember() which can only use the qualified name.
 * 
 * The scopePath array from SymbolInfo contains:
 * - First element: module name (e.g., "data.fifo", "base", "counter")
 * - Subsequent elements: nested containers (classes, structs, functions)
 * 
 * A symbol is a class member if its scopePath has 2+ elements, meaning
 * there's at least one container between the module and the symbol.
 * 
 * @example
 * isClassMemberFromScopePath(["data.fifo"]) → false (module-level symbol)
 * isClassMemberFromScopePath(["data.fifo", "FIFO"]) → true (inside FIFO class)
 * isClassMemberFromScopePath(["counter", "saturating_counter"]) → true (inside class)
 * isClassMemberFromScopePath([]) → false (global, no module)
 */
export function isClassMemberFromScopePath(scopePath: string[]): boolean {
    // If scopePath has 2+ elements, the symbol is nested inside a container
    // scopePath[0] = module, scopePath[1] = class/struct, etc.
    return scopePath.length >= 2;
}

/**
 * Checks if a qualified name is accessible given resolved imports.
 * 
 * IMPORTANT: Class/struct members are NOT accessible as bare identifiers.
 * They must be accessed through their containing type. This prevents
 * symbols like `saturating_counter::count_t` from being resolved when
 * the user writes just `count_t` and expects the module-level type.
 * 
 * @param qualifiedName The symbol's qualified name
 * @param resolvedImports The document's resolved imports
 * @param options.forBareIdentifier If true, excludes class members from accessibility
 */
export function isQualifiedNameAccessible(
    qualifiedName: string,
    resolvedImports: ResolvedImports,
    options?: { forBareIdentifier?: boolean }
): boolean {
    const forBareIdentifier = options?.forBareIdentifier ?? true;
    
    // Class/struct members are NOT accessible as bare identifiers
    // They must be accessed through their containing class
    if (forBareIdentifier && isClassMember(qualifiedName)) {
        return false;
    }
    
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
 * 
 * Class/struct members get a score of 0 since they should not
 * be resolved as bare identifiers.
 */
export function computeImportScore(
    qualifiedName: string,
    modulePath: string | undefined,
    resolvedImports: ResolvedImports
): number {
    // Class members should not be accessible as bare identifiers
    // Give them a score of 0 so they're filtered out
    if (isClassMember(qualifiedName)) {
        return 0;
    }
    
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
 * Uses scopePath for accurate class member detection when available.
 */
export function filterByAccessibility<T extends { qualifiedName: string; scopePath: string[] }>(
    symbols: T[],
    resolvedImports: ResolvedImports,
    options?: { includeInaccessible?: boolean }
): T[] {
    const includeInaccessible = options?.includeInaccessible ?? false;
    
    // Score each symbol
    const scored = symbols.map(sym => {
        // Use scopePath for reliable class member detection
        const isClassMemberSym = isClassMemberFromScopePath(sym.scopePath);
        
        // Class members get score 0 - they're not accessible as bare identifiers
        if (isClassMemberSym) {
            return { symbol: sym, score: 0, accessible: false };
        }
        
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

/**
 * Creates an empty ModuleExports structure for a new module.
 */
export function createEmptyModuleExports(modulePath: string): ModuleExports {
    return {
        modulePath,
        exportedSymbols: new Set(),
        exportedNames: new Set(),
        explicitExports: new Set(),
        reExportedModules: new Set(),
        moduleDifferences: new Map()
    };
}

/**
 * Resolves all transitive exports for a module, including re-exported modules.
 * Uses cycle detection and depth limiting to prevent infinite loops.
 * 
 * @param modulePath The module to resolve exports for
 * @param moduleExportsMap Map of all module exports
 * @param visited Set of already-visited modules (for cycle detection)
 * @param depth Current recursion depth
 * @returns Set of all accessible qualified names from this module
 */
export function resolveTransitiveExports(
    modulePath: string,
    moduleExportsMap: Map<string, ModuleExports>,
    visited: Set<string> = new Set(),
    depth: number = 0
): Set<string> {
    // Check depth limit
    if (depth > MAX_REEXPORT_DEPTH) {
        console.warn(`Kanagawa: Re-export depth exceeded for module '${modulePath}', stopping at depth ${depth}`);
        return new Set();
    }
    
    // Cycle detection
    if (visited.has(modulePath)) {
        return new Set();
    }
    visited.add(modulePath);
    
    const exports = moduleExportsMap.get(modulePath);
    if (!exports) {
        return new Set();
    }
    
    // Check if already resolved
    if (exports.resolvedExports) {
        return exports.resolvedExports;
    }
    
    const result = new Set<string>();
    
    // Add direct exports
    for (const qn of exports.exportedSymbols) {
        result.add(qn);
    }
    
    // Process re-exported modules
    for (const reExportedPath of exports.reExportedModules) {
        const normalizedPath = normalizeModulePath(reExportedPath);
        
        // Find matching modules (handles suffix matching like "fifo" → "data.fifo")
        for (const [candidatePath, candidateExports] of moduleExportsMap) {
            if (matchesImportPath(candidatePath, normalizedPath)) {
                // Recursively resolve transitive exports
                const transitive = resolveTransitiveExports(
                    candidatePath,
                    moduleExportsMap,
                    new Set(visited), // Copy to avoid contaminating sibling branches
                    depth + 1
                );
                for (const qn of transitive) {
                    result.add(qn);
                }
            }
        }
    }
    
    // Process module differences (e.g., `module foo \ .cmdargs`)
    for (const [basePath, excludePath] of exports.moduleDifferences) {
        const baseExports = resolveTransitiveExports(
            basePath,
            moduleExportsMap,
            new Set(visited),
            depth + 1
        );
        
        const excludeExports = resolveTransitiveExports(
            excludePath,
            moduleExportsMap,
            new Set(visited),
            depth + 1
        );
        
        // Add base exports minus excluded exports
        for (const qn of baseExports) {
            if (!excludeExports.has(qn)) {
                result.add(qn);
            }
        }
    }
    
    // Cache the result
    exports.resolvedExports = result;
    
    return result;
}

/**
 * Resolves imports for a document with transitive export support.
 * This is the enhanced version that handles re-exports and module differences.
 * 
 * @param currentModule The current document's module path (if any)
 * @param imports The document's import declarations
 * @param moduleExportsMap Map of all module exports
 * @param options Resolution options
 * @returns Resolved imports with all accessible qualified names
 */
export function resolveImportsWithTransitives(
    currentModule: string | undefined,
    imports: DocumentImport[],
    moduleExportsMap: Map<string, ModuleExports>,
    options?: { includeImplicitBase?: boolean }
): ResolvedImports {
    const result: ResolvedImports = {
        currentModule,
        importedModules: new Set(),
        aliasToModule: new Map(),
        accessibleQualifiedNames: new Set()
    };
    
    // Collect all imports (including implicit base if enabled)
    const allImports = [...imports];
    
    // Add implicit base import unless disabled
    const includeImplicitBase = options?.includeImplicitBase ?? true;
    if (includeImplicitBase) {
        // Only add if not already explicitly imported
        const hasExplicitBase = imports.some(imp => 
            normalizeModulePath(imp.path) === 'base'
        );
        if (!hasExplicitBase) {
            allImports.unshift({ path: 'base' });
        }
    }
    
    // Add symbols from current module (always accessible)
    if (currentModule) {
        const transitiveExports = resolveTransitiveExports(currentModule, moduleExportsMap);
        for (const qn of transitiveExports) {
            result.accessibleQualifiedNames.add(qn);
        }
    }
    
    // Process each import
    for (const imp of allImports) {
        const normalizedPath = normalizeModulePath(imp.path);
        
        // Find matching modules
        for (const [modulePath] of moduleExportsMap) {
            if (matchesImportPath(modulePath, normalizedPath)) {
                result.importedModules.add(modulePath);
                
                if (imp.alias) {
                    result.aliasToModule.set(imp.alias, modulePath);
                }
                
                // Add all transitively resolved exports from this module
                const transitiveExports = resolveTransitiveExports(modulePath, moduleExportsMap);
                for (const qn of transitiveExports) {
                    result.accessibleQualifiedNames.add(qn);
                }
            }
        }
    }
    
    return result;
}

/**
 * Checks if a symbol is accessible from a document using strict import-based rules.
 * This is the enhanced version that properly enforces import requirements.
 * 
 * A symbol is accessible if:
 * 1. It's in the current document's module (same module)
 * 2. It's in a directly imported module's export list (including re-exports)
 * 3. It's global (has no module prefix)
 * 
 * IMPORTANT: Class/struct members are NOT accessible as bare identifiers.
 * They can only be accessed through their containing type.
 * 
 * @param qualifiedName The symbol's qualified name
 * @param resolvedImports The document's resolved imports
 * @param options.forBareIdentifier If true (default), excludes class members
 * @returns true if the symbol is accessible without additional imports
 */
export function isSymbolStrictlyAccessible(
    qualifiedName: string,
    resolvedImports: ResolvedImports,
    options?: { forBareIdentifier?: boolean }
): boolean {
    const forBareIdentifier = options?.forBareIdentifier ?? true;
    
    // Class/struct members are NOT accessible as bare identifiers
    if (forBareIdentifier && isClassMember(qualifiedName)) {
        return false;
    }
    
    // Check if directly in accessible set (includes re-exports)
    if (resolvedImports.accessibleQualifiedNames.has(qualifiedName)) {
        return true;
    }
    
    // Check if it's in the current module
    const module = extractModuleFromQualified(qualifiedName);
    if (module && module === resolvedImports.currentModule) {
        return true;
    }
    
    // Check if the module is imported (for symbols not explicitly tracked)
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
 * Suggests imports for an inaccessible symbol.
 * Returns module paths that would make the symbol accessible.
 * 
 * @param qualifiedName The inaccessible symbol's qualified name
 * @param moduleExportsMap Map of all module exports
 * @returns Array of module paths that export this symbol
 */
export function suggestImportsForSymbol(
    qualifiedName: string,
    moduleExportsMap: Map<string, ModuleExports>
): string[] {
    const suggestions: string[] = [];
    
    for (const [modulePath, exports] of moduleExportsMap) {
        // Check direct exports
        if (exports.exportedSymbols.has(qualifiedName)) {
            suggestions.push(modulePath);
            continue;
        }
        
        // Check resolved exports (including re-exports)
        if (exports.resolvedExports?.has(qualifiedName)) {
            suggestions.push(modulePath);
        }
    }
    
    return suggestions;
}
