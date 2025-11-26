/**
 * Simple glob pattern matcher supporting:
 * - ** for any path segment(s) (including empty)
 * - * for any characters within a segment (not crossing /)
 * - ? for single character (not /)
 * 
 * @param filePath The file path to check
 * @param pattern The glob pattern to match against
 * @returns true if the file path matches the pattern
 */
export function matchesGlobPattern(filePath: string, pattern: string): boolean {
    if (!pattern) { return false; }
    
    // Normalize path separators to forward slashes
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');
    
    // Build regex from pattern
    let regexStr = '';
    let i = 0;
    
    while (i < normalizedPattern.length) {
        const char = normalizedPattern[i];
        const nextChar = normalizedPattern[i + 1];
        
        if (char === '*' && nextChar === '*') {
            // ** matches any path segments (including none)
            const afterStars = normalizedPattern[i + 2];
            if (afterStars === '/') {
                // **/ at start or middle - matches zero or more path segments
                regexStr += '(?:[^/]+/)*';
                i += 3;
            } else if (afterStars === undefined) {
                // ** at end - matches anything remaining
                regexStr += '.*';
                i += 2;
            } else {
                // ** not followed by / - treat as literal
                regexStr += '\\*\\*';
                i += 2;
            }
        } else if (char === '*') {
            // * matches any characters except /
            regexStr += '[^/]*';
            i++;
        } else if (char === '?') {
            // ? matches single character except /
            regexStr += '[^/]';
            i++;
        } else if ('.+^${}()|[]\\'.includes(char)) {
            // Escape regex special characters
            regexStr += '\\' + char;
            i++;
        } else {
            regexStr += char;
            i++;
        }
    }
    
    // Pattern should match the whole path
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(normalizedPath);
}
