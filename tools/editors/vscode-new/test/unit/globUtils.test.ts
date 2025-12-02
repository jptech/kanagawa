/**
 * Tests for glob pattern matching utilities.
 */

import * as assert from 'assert';
import { matchesGlobPattern } from '../../src/utils/globUtils';

describe('Glob Pattern Matching', () => {
    describe('exact matches', () => {
        it('should match exact filename', () => {
            assert.strictEqual(matchesGlobPattern('file.ts', 'file.ts'), true);
            assert.strictEqual(matchesGlobPattern('file.ts', 'file.js'), false);
        });

        it('should match exact path', () => {
            assert.strictEqual(matchesGlobPattern('src/file.ts', 'src/file.ts'), true);
            assert.strictEqual(matchesGlobPattern('src/file.ts', 'lib/file.ts'), false);
        });
    });

    describe('single wildcard (*)', () => {
        it('should match any extension', () => {
            assert.strictEqual(matchesGlobPattern('file.ts', 'file.*'), true);
            assert.strictEqual(matchesGlobPattern('file.js', 'file.*'), true);
            assert.strictEqual(matchesGlobPattern('file', 'file.*'), false);
        });

        it('should match any filename', () => {
            assert.strictEqual(matchesGlobPattern('test.ts', '*.ts'), true);
            assert.strictEqual(matchesGlobPattern('index.ts', '*.ts'), true);
            assert.strictEqual(matchesGlobPattern('test.js', '*.ts'), false);
        });

        it('should not cross directory boundaries', () => {
            assert.strictEqual(matchesGlobPattern('src/file.ts', '*.ts'), false);
            assert.strictEqual(matchesGlobPattern('file.ts', 'src/*.ts'), false);
        });

        it('should match partial names', () => {
            assert.strictEqual(matchesGlobPattern('test_utils.ts', 'test_*.ts'), true);
            assert.strictEqual(matchesGlobPattern('mock_utils.ts', 'test_*.ts'), false);
        });
    });

    describe('question mark (?)', () => {
        it('should match single character', () => {
            assert.strictEqual(matchesGlobPattern('file1.ts', 'file?.ts'), true);
            assert.strictEqual(matchesGlobPattern('fileA.ts', 'file?.ts'), true);
            assert.strictEqual(matchesGlobPattern('file.ts', 'file?.ts'), false);
            assert.strictEqual(matchesGlobPattern('file12.ts', 'file?.ts'), false);
        });

        it('should not match directory separator', () => {
            assert.strictEqual(matchesGlobPattern('a/b.ts', 'a?b.ts'), false);
        });
    });

    describe('double star (**)', () => {
        it('should match any path depth', () => {
            assert.strictEqual(matchesGlobPattern('src/file.ts', '**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('src/deep/nested/file.ts', '**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('file.ts', '**/*.ts'), true);
        });

        it('should match at end of pattern', () => {
            assert.strictEqual(matchesGlobPattern('src/anything', 'src/**'), true);
            assert.strictEqual(matchesGlobPattern('src/deep/nested', 'src/**'), true);
        });

        it('should match specific subdirectory', () => {
            assert.strictEqual(matchesGlobPattern('src/test/file.ts', '**/test/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('deep/nested/test/file.ts', '**/test/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('src/other/file.ts', '**/test/*.ts'), false);
        });

        it('should match zero path segments', () => {
            // **/ at start should match files in root
            assert.strictEqual(matchesGlobPattern('file.ts', '**/*.ts'), true);
        });
    });

    describe('combined patterns', () => {
        it('should match complex patterns', () => {
            assert.strictEqual(matchesGlobPattern('src/utils/test.ts', 'src/**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('src/test.ts', 'src/**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('lib/test.ts', 'src/**/*.ts'), false);
        });

        it('should match multiple wildcards', () => {
            assert.strictEqual(matchesGlobPattern('test_utils.test.ts', '*_*.test.ts'), true);
            assert.strictEqual(matchesGlobPattern('utils.test.ts', '*_*.test.ts'), false);
        });
    });

    describe('path separator normalization', () => {
        it('should normalize backslashes to forward slashes', () => {
            assert.strictEqual(matchesGlobPattern('src\\file.ts', 'src/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('src/file.ts', 'src\\*.ts'), true);
            assert.strictEqual(matchesGlobPattern('src\\deep\\file.ts', '**/*.ts'), true);
        });
    });

    describe('special regex characters', () => {
        it('should escape dots in pattern', () => {
            assert.strictEqual(matchesGlobPattern('file.ts', 'file.ts'), true);
            assert.strictEqual(matchesGlobPattern('filets', 'file.ts'), false); // . should not match any char
        });

        it('should handle parentheses in filenames', () => {
            assert.strictEqual(matchesGlobPattern('file(1).ts', 'file(1).ts'), true);
            assert.strictEqual(matchesGlobPattern('file(1).ts', 'file(*).ts'), true);
        });

        it('should handle brackets in filenames', () => {
            assert.strictEqual(matchesGlobPattern('file[1].ts', 'file[1].ts'), true);
        });

        it('should handle plus sign in filenames', () => {
            assert.strictEqual(matchesGlobPattern('file+test.ts', 'file+test.ts'), true);
            assert.strictEqual(matchesGlobPattern('file+test.ts', 'file+*.ts'), true);
        });
    });

    describe('edge cases', () => {
        it('should return false for empty pattern', () => {
            assert.strictEqual(matchesGlobPattern('file.ts', ''), false);
        });

        it('should handle empty filename', () => {
            assert.strictEqual(matchesGlobPattern('', '*.ts'), false);
            assert.strictEqual(matchesGlobPattern('', '*'), true); // * matches empty string
        });

        it('should handle deeply nested paths', () => {
            const deepPath = 'a/b/c/d/e/f/g/h/i/j/file.ts';
            assert.strictEqual(matchesGlobPattern(deepPath, '**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern(deepPath, 'a/**/file.ts'), true);
        });

        it('should handle multiple extensions', () => {
            assert.strictEqual(matchesGlobPattern('file.test.ts', '*.test.ts'), true);
            assert.strictEqual(matchesGlobPattern('file.test.ts', '*.ts'), true);
        });
    });

    describe('real-world patterns', () => {
        it('should match TypeScript files', () => {
            assert.strictEqual(matchesGlobPattern('src/index.ts', '**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('src/utils/helper.ts', '**/*.ts'), true);
            assert.strictEqual(matchesGlobPattern('test/index.test.ts', '**/*.ts'), true);
        });

        it('should match test files', () => {
            assert.strictEqual(matchesGlobPattern('src/utils.test.ts', '**/*.test.ts'), true);
            assert.strictEqual(matchesGlobPattern('test/unit/utils.test.ts', '**/test/**/*.test.ts'), true);
        });

        it('should match node_modules exclusion pattern', () => {
            // This would typically be used with negation, but we test the match
            assert.strictEqual(matchesGlobPattern('node_modules/pkg/file.ts', 'node_modules/**'), true);
            assert.strictEqual(matchesGlobPattern('src/file.ts', 'node_modules/**'), false);
        });

        it('should match Kanagawa files', () => {
            assert.strictEqual(matchesGlobPattern('src/module.k', '**/*.k'), true);
            assert.strictEqual(matchesGlobPattern('library/base.k', '**/*.k'), true);
        });
    });
});
