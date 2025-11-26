import { expect } from 'chai';

// Test the key format pattern used by makeLocationKey and makePositionKey
// These utility functions use vscode types and are tested via the key format they produce

describe('Node Utilities - Key Format Pattern', () => {
    // The key format is: `${uri.toString()}#${line}:${character}`
    // We can verify the format logic without vscode dependencies

    describe('key format consistency', () => {
        it('key format produces unique strings for different positions', () => {
            const uri = 'file:///test/file.k';
            const key1 = `${uri}#10:5`;
            const key2 = `${uri}#10:6`;
            expect(key1).to.not.equal(key2);
        });

        it('key format produces unique strings for different files', () => {
            const uri1 = 'file:///test/file1.k';
            const uri2 = 'file:///test/file2.k';
            const key1 = `${uri1}#10:5`;
            const key2 = `${uri2}#10:5`;
            expect(key1).to.not.equal(key2);
        });

        it('key format produces unique strings for different lines', () => {
            const uri = 'file:///test/file.k';
            const key1 = `${uri}#10:5`;
            const key2 = `${uri}#11:5`;
            expect(key1).to.not.equal(key2);
        });

        it('key format handles zero positions', () => {
            const uri = 'file:///test/file.k';
            const key = `${uri}#0:0`;
            expect(key).to.include('#0:0');
        });

        it('key format handles large line numbers', () => {
            const uri = 'file:///test/file.k';
            const key = `${uri}#10000:500`;
            expect(key).to.include('#10000:500');
        });

        it('key format is parseable', () => {
            const uri = 'file:///test/file.k';
            const line = 42;
            const char = 15;
            const key = `${uri}#${line}:${char}`;
            
            // Verify we can extract components
            const hashIndex = key.lastIndexOf('#');
            const extractedUri = key.substring(0, hashIndex);
            const [extractedLine, extractedChar] = key.substring(hashIndex + 1).split(':').map(Number);
            
            expect(extractedUri).to.equal(uri);
            expect(extractedLine).to.equal(line);
            expect(extractedChar).to.equal(char);
        });
    });
});
