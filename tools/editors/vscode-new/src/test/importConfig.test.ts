import { expect } from 'chai';
import { matchesGlobPattern } from '../utils/globUtils';

describe('matchesGlobPattern', () => {
    describe('basic patterns', () => {
        it('should match exact file names', () => {
            expect(matchesGlobPattern('file.k', 'file.k')).to.be.true;
            expect(matchesGlobPattern('file.k', 'other.k')).to.be.false;
        });

        it('should match with single wildcard *', () => {
            expect(matchesGlobPattern('file.k', '*.k')).to.be.true;
            expect(matchesGlobPattern('file.txt', '*.k')).to.be.false;
            expect(matchesGlobPattern('test_file.k', 'test_*.k')).to.be.true;
        });

        it('should match with ? for single character', () => {
            expect(matchesGlobPattern('file1.k', 'file?.k')).to.be.true;
            expect(matchesGlobPattern('file12.k', 'file?.k')).to.be.false;
        });
    });

    describe('directory patterns', () => {
        it('should match ** for any path depth with file extension', () => {
            expect(matchesGlobPattern('src/module.gen.k', '**/*.gen.k')).to.be.true;
            expect(matchesGlobPattern('deep/path/module.gen.k', '**/*.gen.k')).to.be.true;
            expect(matchesGlobPattern('module.gen.k', '**/*.gen.k')).to.be.true;
            expect(matchesGlobPattern('module.k', '**/*.gen.k')).to.be.false;
        });

        it('should match specific directory patterns', () => {
            expect(matchesGlobPattern('test_vectors/test1.k', 'test_vectors/**')).to.be.true;
            expect(matchesGlobPattern('test_vectors/sub/test1.k', 'test_vectors/**')).to.be.true;
            expect(matchesGlobPattern('other/test1.k', 'test_vectors/**')).to.be.false;
        });
        
        it('should match directory name patterns', () => {
            // Pattern: exclude anything in a 'generated' directory
            expect(matchesGlobPattern('generated/file.k', 'generated/**')).to.be.true;
            expect(matchesGlobPattern('src/generated/file.k', '*/generated/**')).to.be.true;
            expect(matchesGlobPattern('deep/path/generated/file.k', '**/generated/**')).to.be.true;
        });
    });

    describe('edge cases', () => {
        it('should handle empty patterns', () => {
            expect(matchesGlobPattern('file.k', '')).to.be.false;
        });

        it('should handle path separators consistently', () => {
            // Both forward and back slashes should work
            expect(matchesGlobPattern('src\\module.gen.k', '**/*.gen.k')).to.be.true;
            expect(matchesGlobPattern('src/module.gen.k', '**/*.gen.k')).to.be.true;
        });
    });
});
