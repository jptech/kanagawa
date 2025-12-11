import * as path from 'path';
import * as vscode from 'vscode';
import { ResolvedImports, extractModuleFromQualified } from './importUtils';

export interface RankableSymbol {
	qualifiedName: string;
	scopePath: string[];
	uri: vscode.Uri;
}

export interface RankContext {
	documentUri: vscode.Uri;
	resolvedImports: ResolvedImports;
	/**
	 * Module path declared by the file that defines the symbol (if known).
	 * This is important for symbols that are "global" (no module prefix in qualifiedName)
	 * but live in a file that is part of an imported module.
	 */
	declaringModule?: string;
}

function splitPathSegments(filePath: string): string[] {
	const normalized = path.normalize(filePath);
	// Support both separators regardless of platform/mocks.
	return normalized.split(/[/\\]+/g).filter(Boolean);
}

function commonPrefixLength(a: string[], b: string[]): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	for (; i < limit; i++) {
		if (a[i].toLowerCase() !== b[i].toLowerCase()) break;
	}
	return i;
}

export type ResolutionTier = 'same_module' | 'imported' | 'global' | 'inaccessible';

export function computeResolutionTier(
	symbol: Pick<RankableSymbol, 'qualifiedName' | 'scopePath'>,
	resolvedImports: ResolvedImports
): ResolutionTier {
	const modulePath = extractModuleFromQualified(symbol.qualifiedName)
		?? (symbol.scopePath.length > 0 ? symbol.scopePath[0] : undefined);

	if (!modulePath) {
		return 'global';
	}

	if (modulePath === resolvedImports.currentModule) {
		return 'same_module';
	}

	if (resolvedImports.accessibleQualifiedNames.has(symbol.qualifiedName)) {
		return 'imported';
	}

	if (resolvedImports.importedModules.has(modulePath)) {
		return 'imported';
	}

	return 'inaccessible';
}

export function computeResolutionRelevanceScore(
	symbol: RankableSymbol,
	ctx: RankContext
): number {
	let score = 0;

	// Tier score: make tier differences dominate.
	const tier = computeResolutionTier(symbol, ctx.resolvedImports);
	switch (tier) {
		case 'same_module':
			score += 400;
			break;
		case 'imported':
			score += 250;
			break;
		case 'global':
			score += 120;
			break;
		case 'inaccessible':
			// Still allow ranking for “did you mean to import”, but keep it far below.
			score -= 1000;
			break;
	}

	// Strong preference for same file.
	if (symbol.uri.toString() === ctx.documentUri.toString()) {
		score += 200;
	}

	// If the symbol is global, but its defining file belongs to an imported/same module,
	// prefer it over global symbols from unrelated files.
	if (tier === 'global' && ctx.declaringModule) {
		if (ctx.declaringModule === ctx.resolvedImports.currentModule) {
			score += 180;
		} else if (ctx.resolvedImports.importedModules.has(ctx.declaringModule)) {
			score += 120;
		}
	}

	// Path proximity: prefer definitions “near” the current file.
	const docSegs = splitPathSegments(ctx.documentUri.fsPath);
	const symSegs = splitPathSegments(symbol.uri.fsPath);
	const common = commonPrefixLength(docSegs, symSegs);
	// Cap the proximity bonus so it doesn't overpower tier/module.
	score += Math.min(common * 6, 60);

	// Mild preference for “less nested” qualified names when all else ties.
	score += Math.max(0, 40 - symbol.qualifiedName.length / 4);

	return score;
}

export function rankSymbolsForResolution<T extends RankableSymbol>(
	symbols: T[],
	ctx: Omit<RankContext, 'declaringModule'> & {
		getDeclaringModule?: (symbol: T) => string | undefined;
	}
): { symbol: T; score: number; tier: ResolutionTier }[] {
	const ranked = symbols.map(symbol => {
		const declaringModule = ctx.getDeclaringModule?.(symbol);
		const score = computeResolutionRelevanceScore(symbol, {
			documentUri: ctx.documentUri,
			resolvedImports: ctx.resolvedImports,
			declaringModule
		});
		const tier = computeResolutionTier(symbol, ctx.resolvedImports);
		return { symbol, score, tier };
	});

	ranked.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		// Stable-ish deterministic fallback: URI, then qualified name.
		const uriCmp = a.symbol.uri.toString().localeCompare(b.symbol.uri.toString());
		if (uriCmp !== 0) return uriCmp;
		return a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName);
	});

	return ranked;
}
