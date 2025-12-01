/**
 * Tests for TreeSitterService
 * 
 * Note: Full integration tests require the Tree-sitter WASM files to be present.
 * These tests focus on testable logic without requiring parser initialization.
 * Integration tests should be run in the VS Code test runner with full extension context.
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    MockTextDocument,
    MockExtensionContext,
    createTestDocument
} from '../mocks/vscode';

describe('TreeSitterService', () => {
    describe('MockTextDocument (test infrastructure)', () => {
        // These tests validate our mock infrastructure works correctly

        it('should correctly calculate line count', () => {
            const doc = createTestDocument('line1\nline2\nline3');
            expect(doc.lineCount).to.equal(3);
        });

        it('should handle single line documents', () => {
            const doc = createTestDocument('single line');
            expect(doc.lineCount).to.equal(1);
            expect(doc.getText()).to.equal('single line');
        });

        it('should handle empty documents', () => {
            const doc = createTestDocument('');
            expect(doc.lineCount).to.equal(1);
            expect(doc.getText()).to.equal('');
        });

        it('should correctly return text for a range', () => {
            const doc = createTestDocument('hello world\nfoo bar');
            const range = new Range(0, 6, 0, 11);
            expect(doc.getText(range)).to.equal('world');
        });

        it('should correctly return text spanning multiple lines', () => {
            const doc = createTestDocument('line1\nline2\nline3');
            const range = new Range(0, 3, 2, 2);
            expect(doc.getText(range)).to.equal('e1\nline2\nli');
        });

        it('should correctly calculate offset from position', () => {
            const doc = createTestDocument('hello\nworld');
            expect(doc.offsetAt(new Position(0, 0))).to.equal(0);
            expect(doc.offsetAt(new Position(0, 5))).to.equal(5);
            expect(doc.offsetAt(new Position(1, 0))).to.equal(6); // After newline
            expect(doc.offsetAt(new Position(1, 5))).to.equal(11);
        });

        it('should correctly calculate position from offset', () => {
            const doc = createTestDocument('hello\nworld');
            expect(doc.positionAt(0)).to.deep.equal(new Position(0, 0));
            expect(doc.positionAt(5)).to.deep.equal(new Position(0, 5));
            expect(doc.positionAt(6)).to.deep.equal(new Position(1, 0));
            expect(doc.positionAt(11)).to.deep.equal(new Position(1, 5));
        });

        it('should return line text', () => {
            const doc = createTestDocument('  hello world\n  foo bar');
            const line = doc.lineAt(0);
            expect(line.text).to.equal('  hello world');
            expect(line.firstNonWhitespaceCharacterIndex).to.equal(2);
            expect(line.isEmptyOrWhitespace).to.be.false;
        });

        it('should detect empty/whitespace lines', () => {
            const doc = createTestDocument('hello\n   \nworld');
            const line1 = doc.lineAt(1);
            expect(line1.isEmptyOrWhitespace).to.be.true;
        });

        it('should get word range at position', () => {
            const doc = createTestDocument('hello world foo');
            
            // Position in middle of "hello"
            const range1 = doc.getWordRangeAtPosition(new Position(0, 2));
            expect(range1).to.not.be.undefined;
            expect(doc.getText(range1!)).to.equal('hello');

            // Position at start of "world"
            const range2 = doc.getWordRangeAtPosition(new Position(0, 6));
            expect(range2).to.not.be.undefined;
            expect(doc.getText(range2!)).to.equal('world');
        });
    });

    describe('Position', () => {
        it('should compare positions correctly', () => {
            const p1 = new Position(0, 5);
            const p2 = new Position(0, 10);
            const p3 = new Position(1, 0);

            expect(p1.isBefore(p2)).to.be.true;
            expect(p2.isBefore(p1)).to.be.false;
            expect(p1.isBefore(p3)).to.be.true;
            expect(p2.isBefore(p3)).to.be.true;
        });

        it('should detect equal positions', () => {
            const p1 = new Position(5, 10);
            const p2 = new Position(5, 10);
            const p3 = new Position(5, 11);

            expect(p1.isEqual(p2)).to.be.true;
            expect(p1.isEqual(p3)).to.be.false;
        });

        it('should translate positions', () => {
            const p = new Position(5, 10);
            const translated = p.translate(2, 3);
            expect(translated.line).to.equal(7);
            expect(translated.character).to.equal(13);
        });
    });

    describe('Range', () => {
        it('should construct from positions', () => {
            const start = new Position(1, 5);
            const end = new Position(3, 10);
            const range = new Range(start, end);

            expect(range.start).to.deep.equal(start);
            expect(range.end).to.deep.equal(end);
        });

        it('should construct from line/character numbers', () => {
            const range = new Range(1, 5, 3, 10);
            expect(range.start.line).to.equal(1);
            expect(range.start.character).to.equal(5);
            expect(range.end.line).to.equal(3);
            expect(range.end.character).to.equal(10);
        });

        it('should detect empty range', () => {
            const empty = new Range(1, 5, 1, 5);
            const notEmpty = new Range(1, 5, 1, 10);

            expect(empty.isEmpty).to.be.true;
            expect(notEmpty.isEmpty).to.be.false;
        });

        it('should detect single line range', () => {
            const singleLine = new Range(1, 5, 1, 15);
            const multiLine = new Range(1, 5, 3, 10);

            expect(singleLine.isSingleLine).to.be.true;
            expect(multiLine.isSingleLine).to.be.false;
        });

        it('should check containment of positions', () => {
            const range = new Range(1, 5, 3, 10);
            
            expect(range.contains(new Position(2, 0))).to.be.true;
            expect(range.contains(new Position(1, 5))).to.be.true;
            expect(range.contains(new Position(3, 10))).to.be.true;
            expect(range.contains(new Position(0, 0))).to.be.false;
            expect(range.contains(new Position(3, 11))).to.be.false;
        });
    });

    describe('Uri', () => {
        it('should create file URI', () => {
            const uri = Uri.file('/path/to/file.k');
            expect(uri.scheme).to.equal('file');
            expect(uri.path).to.equal('/path/to/file.k');
        });

        it('should normalize backslashes in file paths', () => {
            const uri = Uri.file('C:\\Users\\test\\file.k');
            expect(uri.path).to.equal('C:/Users/test/file.k');
        });

        it('should parse URI strings', () => {
            const uri = Uri.parse('file:///path/to/file.k');
            expect(uri.scheme).to.equal('file');
            expect(uri.path).to.equal('/path/to/file.k');
        });

        it('should join paths', () => {
            const base = Uri.file('/root/project');
            const joined = Uri.joinPath(base, 'src', 'file.k');
            expect(joined.path).to.equal('/root/project/src/file.k');
        });

        it('should convert to string', () => {
            const uri = Uri.file('/path/to/file.k');
            expect(uri.toString()).to.equal('file:///path/to/file.k');
        });
    });

    describe('TreeSitterService Logic (Unit)', () => {
        // These tests verify service behavior patterns without needing actual parsing

        describe('End Position Calculation', () => {
            // Test the algorithm used in calculateNewEndPosition
            
            function calculateNewEndPosition(
                startLine: number,
                startChar: number,
                insertedText: string
            ): { row: number; column: number } {
                const lines = insertedText.split(/\r?\n/);
                
                if (lines.length === 1) {
                    return {
                        row: startLine,
                        column: startChar + insertedText.length
                    };
                } else {
                    return {
                        row: startLine + lines.length - 1,
                        column: lines[lines.length - 1].length
                    };
                }
            }

            it('should handle single-line insertions', () => {
                const result = calculateNewEndPosition(5, 10, 'hello');
                expect(result.row).to.equal(5);
                expect(result.column).to.equal(15);
            });

            it('should handle multi-line insertions', () => {
                const result = calculateNewEndPosition(5, 10, 'hello\nworld');
                expect(result.row).to.equal(6);
                expect(result.column).to.equal(5);
            });

            it('should handle insertions ending with newline', () => {
                const result = calculateNewEndPosition(5, 10, 'hello\n');
                expect(result.row).to.equal(6);
                expect(result.column).to.equal(0);
            });

            it('should handle empty insertions', () => {
                const result = calculateNewEndPosition(5, 10, '');
                expect(result.row).to.equal(5);
                expect(result.column).to.equal(10);
            });

            it('should handle complex multi-line insertions', () => {
                const result = calculateNewEndPosition(0, 0, 'line1\nline2\nline3\nlast');
                expect(result.row).to.equal(3);
                expect(result.column).to.equal(4);
            });
        });
    });
});

describe('AsyncMutex Pattern', () => {
    // Test the mutex pattern used in TreeSitterService
    
    class AsyncMutex {
        private locked = false;
        private waiting: (() => void)[] = [];

        async acquire(): Promise<void> {
            if (!this.locked) {
                this.locked = true;
                return;
            }

            return new Promise<void>(resolve => {
                this.waiting.push(resolve);
            });
        }

        release(): void {
            if (this.waiting.length > 0) {
                const next = this.waiting.shift()!;
                next();
            } else {
                this.locked = false;
            }
        }
    }

    it('should allow first caller to acquire immediately', async () => {
        const mutex = new AsyncMutex();
        const acquired = await Promise.race([
            mutex.acquire().then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 10))
        ]);
        expect(acquired).to.be.true;
    });

    it('should block second caller until release', async () => {
        const mutex = new AsyncMutex();
        const order: number[] = [];
        
        await mutex.acquire();
        order.push(1);

        // Start second acquire (will wait)
        const secondAcquire = mutex.acquire().then(() => {
            order.push(3);
        });

        order.push(2);
        mutex.release();
        
        await secondAcquire;
        expect(order).to.deep.equal([1, 2, 3]);
    });

    it('should handle multiple waiting callers in order', async () => {
        const mutex = new AsyncMutex();
        const order: number[] = [];

        await mutex.acquire();

        const p1 = mutex.acquire().then(() => {
            order.push(1);
            mutex.release();
        });
        const p2 = mutex.acquire().then(() => {
            order.push(2);
            mutex.release();
        });
        const p3 = mutex.acquire().then(() => {
            order.push(3);
            mutex.release();
        });

        mutex.release();
        await Promise.all([p1, p2, p3]);

        expect(order).to.deep.equal([1, 2, 3]);
    });
});

describe('Query Cache Pattern', () => {
    // Test the LRU cache pattern used in TreeSitterService's query cache
    
    class MockQueryCache {
        private cache: Map<string, { query: string; queryString: string }> = new Map();
        private readonly maxSize: number;

        constructor(maxSize: number = 20) {
            this.maxSize = maxSize;
        }

        getOrCreate(queryString: string): string {
            const cached = this.cache.get(queryString);
            if (cached) {
                return cached.query;
            }

            // Create new "query" (in real code, this compiles the query)
            const query = `compiled:${queryString}`;
            
            // Evict oldest if full
            if (this.cache.size >= this.maxSize) {
                const firstKey = this.cache.keys().next().value;
                if (firstKey) {
                    this.cache.delete(firstKey);
                }
            }

            this.cache.set(queryString, { query, queryString });
            return query;
        }

        get size(): number {
            return this.cache.size;
        }

        clear(): void {
            this.cache.clear();
        }
    }

    it('should cache queries', () => {
        const cache = new MockQueryCache();
        const result1 = cache.getOrCreate('(identifier)');
        const result2 = cache.getOrCreate('(identifier)');
        
        expect(result1).to.equal(result2);
        expect(cache.size).to.equal(1);
    });

    it('should evict oldest entry when full', () => {
        const cache = new MockQueryCache(3);
        
        cache.getOrCreate('query1');
        cache.getOrCreate('query2');
        cache.getOrCreate('query3');
        expect(cache.size).to.equal(3);
        
        // This should evict query1
        cache.getOrCreate('query4');
        expect(cache.size).to.equal(3);
        
        // query1 should be gone (would create new entry)
        const beforeSize = cache.size;
        cache.getOrCreate('query1'); // This creates a new entry since query1 was evicted
        // After re-adding query1, query2 should be evicted
        expect(cache.size).to.equal(3);
    });

    it('should handle clear', () => {
        const cache = new MockQueryCache();
        cache.getOrCreate('query1');
        cache.getOrCreate('query2');
        expect(cache.size).to.equal(2);
        
        cache.clear();
        expect(cache.size).to.equal(0);
    });
});
