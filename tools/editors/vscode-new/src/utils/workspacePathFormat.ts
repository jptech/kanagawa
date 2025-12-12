export interface WorkspaceFolderLike {
    uri: { fsPath: string };
    name?: string;
}

function toPosixPath(pathLike: string): string {
    return pathLike.replace(/\\/g, '/');
}

function normalizeForCompare(pathLike: string): string {
    // Normalize separators, trim trailing slash, normalize drive letter casing.
    let p = toPosixPath(pathLike).replace(/\/+$/g, '');

    // Normalize Windows drive letter (C:/...) to lowercase for case-insensitive matching.
    if (/^[A-Za-z]:\//.test(p)) {
        p = p[0].toLowerCase() + p.slice(1);
    }

    return p;
}

function isSubPath(child: string, parent: string): boolean {
    if (child === parent) return true;
    if (!child.startsWith(parent)) return false;
    const next = child[parent.length];
    return next === '/';
}

/**
 * Formats a file system path for Copilot tool output.
 *
 * - If the path is inside a workspace folder, returns a workspace-relative path.
 * - If multiple workspace folders exist, prefixes with the folder name to disambiguate.
 * - Otherwise returns an absolute path.
 * - Always normalizes slashes to `/`.
 */
export function formatWorkspacePathForTool(
    fsPath: string,
    workspaceFolders: readonly WorkspaceFolderLike[] | undefined
): string {
    const normalizedChild = normalizeForCompare(fsPath);

    if (!workspaceFolders || workspaceFolders.length === 0) {
        return toPosixPath(fsPath);
    }

    // Pick the longest matching workspace folder (handles nested workspace folders).
    let best: { folder: WorkspaceFolderLike; normalized: string } | undefined;
    for (const folder of workspaceFolders) {
        const normalizedFolder = normalizeForCompare(folder.uri.fsPath);
        if (!isSubPath(normalizedChild, normalizedFolder)) continue;

        if (!best || normalizedFolder.length > best.normalized.length) {
            best = { folder, normalized: normalizedFolder };
        }
    }

    if (!best) {
        return toPosixPath(fsPath);
    }

    const rel = normalizedChild.length === best.normalized.length
        ? ''
        : normalizedChild.slice(best.normalized.length + 1);

    const multiRoot = workspaceFolders.length > 1;
    const prefix = multiRoot ? (best.folder.name ?? '') : '';

    if (multiRoot && prefix) {
        return rel ? `${prefix}/${rel}` : prefix;
    }

    return rel || toPosixPath(fsPath);
}
