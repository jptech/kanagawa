/**
 * Member resolution utilities for Kanagawa language support.
 * Provides precise member lookup using qualified names and scope context.
 */

import { SymbolInfo, SymbolCategory } from '../service/indexer';

/**
 * Options for member resolution.
 */
export interface MemberResolutionOptions {
    /** Include methods in results */
    includeMethods?: boolean;
    /** Include fields/members in results */
    includeFields?: boolean;
    /** Include constants in results */
    includeConstants?: boolean;
    /** Include nested types in results */
    includeTypes?: boolean;
    /** Filter by name prefix */
    namePrefix?: string;
}

/**
 * Result of member resolution with metadata.
 */
export interface MemberResolutionResult {
    /** The resolved members */
    members: SymbolInfo[];
    /** The container type name that was resolved */
    containerType: string;
    /** The qualified name of the container */
    containerQualified?: string;
    /** Whether this was an exact container match */
    isExactMatch: boolean;
}

/**
 * Extracts the container qualified name from a member's qualified name.
 * 
 * @example
 * getContainerFromMember("data.fifo::FIFO::push") → "data.fifo::FIFO"
 * getContainerFromMember("FIFO::push") → "FIFO"
 * getContainerFromMember("globalFunc") → undefined
 */
export function getContainerFromMember(memberQualifiedName: string): string | undefined {
    const lastSep = memberQualifiedName.lastIndexOf('::');
    return lastSep > 0 ? memberQualifiedName.substring(0, lastSep) : undefined;
}

/**
 * Checks if a symbol is a member of the given container.
 */
export function isMemberOfContainer(
    symbol: SymbolInfo,
    containerQualified: string
): boolean {
    const symbolContainer = getContainerFromMember(symbol.qualifiedName);
    return symbolContainer === containerQualified;
}

/**
 * Filters symbols to only those that are direct members of a container.
 */
export function filterDirectMembers(
    symbols: SymbolInfo[],
    containerQualified: string
): SymbolInfo[] {
    return symbols.filter(sym => isMemberOfContainer(sym, containerQualified));
}

/**
 * Categorizes a symbol for member filtering.
 */
export function getMemberCategory(category: SymbolCategory): 'method' | 'field' | 'constant' | 'type' | 'other' {
    switch (category) {
        case 'method':
        case 'function': // Functions inside a class are methods
            return 'method';
        case 'member':
        case 'variable':
            return 'field';
        case 'constant':
            return 'constant';
        case 'class':
        case 'struct':
        case 'union':
        case 'enum':
        case 'alias':
            return 'type';
        default:
            return 'other';
    }
}

/**
 * Filters members based on resolution options.
 */
export function filterMembersByOptions(
    members: SymbolInfo[],
    options: MemberResolutionOptions
): SymbolInfo[] {
    const includeMethods = options.includeMethods ?? true;
    const includeFields = options.includeFields ?? true;
    const includeConstants = options.includeConstants ?? false;
    const includeTypes = options.includeTypes ?? false;
    const namePrefix = options.namePrefix?.toLowerCase();

    return members.filter(sym => {
        // Check category
        const cat = getMemberCategory(sym.category);
        const categoryOk = 
            (cat === 'method' && includeMethods) ||
            (cat === 'field' && includeFields) ||
            (cat === 'constant' && includeConstants) ||
            (cat === 'type' && includeTypes);
        
        if (!categoryOk) {
            return false;
        }

        // Check name prefix
        if (namePrefix && !sym.name.toLowerCase().startsWith(namePrefix)) {
            return false;
        }

        return true;
    });
}

/**
 * Sorts members in a user-friendly order:
 * 1. Methods (alphabetically)
 * 2. Fields (alphabetically)  
 * 3. Constants (alphabetically)
 * 4. Types (alphabetically)
 */
export function sortMembers(members: SymbolInfo[]): SymbolInfo[] {
    const categoryOrder: Record<string, number> = {
        'method': 0,
        'field': 1,
        'constant': 2,
        'type': 3,
        'other': 4
    };

    return [...members].sort((a, b) => {
        const catA = getMemberCategory(a.category);
        const catB = getMemberCategory(b.category);
        
        if (catA !== catB) {
            return (categoryOrder[catA] ?? 4) - (categoryOrder[catB] ?? 4);
        }
        
        return a.name.localeCompare(b.name);
    });
}

/**
 * Computes a match score for a container type lookup.
 * Higher scores indicate better matches.
 */
export function computeContainerMatchScore(
    targetType: string,
    candidateContainer: string,
    candidateQualified: string
): number {
    let score = 0;
    
    // Exact match is best
    if (candidateContainer === targetType) {
        score += 100;
    }
    // Qualified name ends with target type
    else if (candidateQualified.endsWith('::' + targetType)) {
        score += 80;
    }
    // Container name ends with target (for aliased types)
    else if (candidateContainer.endsWith(targetType)) {
        score += 60;
    }
    // Partial match
    else if (candidateContainer.includes(targetType) || targetType.includes(candidateContainer)) {
        score += 30;
    }
    
    return score;
}

/**
 * Finds the best matching container for a type name.
 * Returns the qualified name of the container and its match score.
 */
export function findBestContainer(
    typeName: string,
    qualifiedIndex: Map<string, SymbolInfo>
): { qualifiedName: string; score: number } | undefined {
    let bestMatch: { qualifiedName: string; score: number } | undefined;
    
    for (const [qualifiedName, symbol] of qualifiedIndex) {
        // Only consider type-like symbols
        if (!['class', 'struct', 'union', 'enum', 'alias'].includes(symbol.category)) {
            continue;
        }
        
        const score = computeContainerMatchScore(typeName, symbol.name, qualifiedName);
        
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { qualifiedName, score };
        }
    }
    
    return bestMatch;
}

/**
 * Groups members by their source container for display.
 */
export function groupMembersByContainer(members: SymbolInfo[]): Map<string, SymbolInfo[]> {
    const groups = new Map<string, SymbolInfo[]>();
    
    for (const member of members) {
        const container = getContainerFromMember(member.qualifiedName) ?? '(global)';
        const list = groups.get(container) ?? [];
        list.push(member);
        groups.set(container, list);
    }
    
    return groups;
}

/**
 * Creates a detailed signature for a member including its container.
 */
export function formatMemberSignature(member: SymbolInfo): string {
    const container = getContainerFromMember(member.qualifiedName);
    const prefix = container ? `${container}::` : '';
    
    if (member.signature) {
        return `${prefix}${member.signature}`;
    }
    
    return `${prefix}${member.name}`;
}

/**
 * Checks if a type name looks like a template instantiation.
 * 
 * @example
 * isTemplateInstantiation("FIFO<int, 32>") → true
 * isTemplateInstantiation("FIFO") → false
 */
export function isTemplateInstantiation(typeName: string): boolean {
    return typeName.includes('<') && typeName.includes('>');
}

/**
 * Extracts the base type from a template instantiation.
 * 
 * @example
 * extractTemplateBase("FIFO<int, 32>") → "FIFO"
 * extractTemplateBase("FIFO") → "FIFO"
 */
export function extractTemplateBaseType(typeName: string): string {
    const angleIndex = typeName.indexOf('<');
    return angleIndex > 0 ? typeName.substring(0, angleIndex).trim() : typeName;
}
