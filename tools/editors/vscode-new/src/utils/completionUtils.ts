import { extractModuleFromQualified, ResolvedImports } from './importUtils';

export type CompletionSymbolTier = 'same_module' | 'imported' | 'global' | 'inaccessible';

export interface CompletionSymbolLike {
    name: string;
    qualifiedName: string;
    /** Optional scopePath (preferred for module extraction, supports single-segment modules like `base`). */
    scopePath?: string[];
}

const TIER_RANK: Record<CompletionSymbolTier, number> = {
    same_module: 0,
    imported: 1,
    global: 2,
    inaccessible: 3
};

export function computeCompletionTier(
    symbol: Pick<CompletionSymbolLike, 'qualifiedName' | 'scopePath'>,
    resolvedImports: ResolvedImports | undefined
): CompletionSymbolTier {
    const qualifiedName = symbol.qualifiedName;
    const modulePath = extractModuleFromQualified(qualifiedName)
        ?? (symbol.scopePath && symbol.scopePath.length > 0 ? symbol.scopePath[0] : undefined);

    // No module = global scope
    if (!modulePath) {
        return 'global';
    }

    if (!resolvedImports) {
        // Without import info, treat module symbols as globally reachable
        return 'global';
    }

    if (modulePath && modulePath === resolvedImports.currentModule) {
        return 'same_module';
    }

    // Accessible through import closure (direct imports, re-exports, transitive exports)
    if (resolvedImports.accessibleQualifiedNames.has(qualifiedName)) {
        return 'imported';
    }

    // Module is directly imported (or part of transitive closure tracked as importedModules)
    if (modulePath && resolvedImports.importedModules.has(modulePath)) {
        return 'imported';
    }

    return 'inaccessible';
}

/**
 * Picks one representative symbol per name for completions.
 * 
 * This prevents pathological behavior where an inaccessible symbol is encountered
 * first, causing the accessible one to be dropped due to name de-duping.
 */
export function pickBestCompletionSymbols<T extends CompletionSymbolLike>(
    symbols: T[],
    resolvedImports: ResolvedImports | undefined
): Map<string, { symbol: T; tier: CompletionSymbolTier }> {
    const best = new Map<string, { symbol: T; tier: CompletionSymbolTier }>();

    for (const sym of symbols) {
        const tier = computeCompletionTier(sym, resolvedImports);
        const existing = best.get(sym.name);
        if (!existing) {
            best.set(sym.name, { symbol: sym, tier });
            continue;
        }

        // Lower rank = better tier
        const currentRank = TIER_RANK[tier];
        const existingRank = TIER_RANK[existing.tier];
        if (currentRank < existingRank) {
            best.set(sym.name, { symbol: sym, tier });
            continue;
        }

        // Tie-breaker: prefer shorter qualified name (tends to prefer module-level
        // symbols over deeply nested ones when tiers tie).
        if (currentRank === existingRank) {
            if (sym.qualifiedName.length < existing.symbol.qualifiedName.length) {
                best.set(sym.name, { symbol: sym, tier });
            }
        }
    }

    return best;
}
