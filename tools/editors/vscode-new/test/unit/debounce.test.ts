/**
 * Tests for debounce utilities.
 */

import * as assert from 'assert';

// Mock minimal vscode.Disposable interface
interface Disposable {
    dispose(): void;
}

// Re-implement debounce classes for testing without vscode dependency
class KeyedDebouncer<K = string> implements Disposable {
    private readonly timers = new Map<K, NodeJS.Timeout>();
    private disposed = false;

    constructor(private readonly defaultDelay: number = 200) {}

    debounce(key: K, callback: () => void, delay?: number): void {
        if (this.disposed) { return; }

        const effectiveDelay = delay ?? this.defaultDelay;

        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.timers.delete(key);
            if (!this.disposed) {
                callback();
            }
        }, effectiveDelay);

        this.timers.set(key, timer);
    }

    cancel(key: K): void {
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
    }

    cancelAll(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    isPending(key: K): boolean {
        return this.timers.has(key);
    }

    dispose(): void {
        this.disposed = true;
        this.cancelAll();
    }
}

class Debouncer implements Disposable {
    private timer: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(private readonly delay: number = 200) {}

    debounce(callback: () => void): void {
        if (this.disposed) { return; }

        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.disposed) {
                callback();
            }
        }, this.delay);
    }

    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    isPending(): boolean {
        return this.timer !== undefined;
    }

    dispose(): void {
        this.disposed = true;
        this.cancel();
    }
}

describe('Debounce Utilities', () => {
    describe('KeyedDebouncer', () => {
        it('should execute callback after delay', async () => {
            const debouncer = new KeyedDebouncer(10);
            let executed = false;
            
            debouncer.debounce('key1', () => { executed = true; });
            
            assert.strictEqual(executed, false);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.strictEqual(executed, true);
            
            debouncer.dispose();
        });

        it('should cancel previous callback when called again with same key', async () => {
            const debouncer = new KeyedDebouncer(20);
            const calls: number[] = [];
            
            debouncer.debounce('key1', () => { calls.push(1); });
            await new Promise(resolve => setTimeout(resolve, 5));
            debouncer.debounce('key1', () => { calls.push(2); });
            
            await new Promise(resolve => setTimeout(resolve, 30));
            
            assert.deepStrictEqual(calls, [2]); // Only second callback executed
            
            debouncer.dispose();
        });

        it('should allow different keys to run independently', async () => {
            const debouncer = new KeyedDebouncer(10);
            const calls: string[] = [];
            
            debouncer.debounce('key1', () => { calls.push('a'); });
            debouncer.debounce('key2', () => { calls.push('b'); });
            
            await new Promise(resolve => setTimeout(resolve, 20));
            
            assert.strictEqual(calls.length, 2);
            assert.ok(calls.includes('a'));
            assert.ok(calls.includes('b'));
            
            debouncer.dispose();
        });

        it('should allow custom delay per call', async () => {
            const debouncer = new KeyedDebouncer(100); // default 100ms
            let executed = false;
            
            debouncer.debounce('key1', () => { executed = true; }, 10); // custom 10ms
            
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.strictEqual(executed, true);
            
            debouncer.dispose();
        });

        it('should cancel specific key', async () => {
            const debouncer = new KeyedDebouncer(20);
            const calls: string[] = [];
            
            debouncer.debounce('key1', () => { calls.push('a'); });
            debouncer.debounce('key2', () => { calls.push('b'); });
            
            debouncer.cancel('key1');
            
            await new Promise(resolve => setTimeout(resolve, 30));
            
            assert.deepStrictEqual(calls, ['b']);
            
            debouncer.dispose();
        });

        it('should cancel all pending callbacks', async () => {
            const debouncer = new KeyedDebouncer(20);
            const calls: string[] = [];
            
            debouncer.debounce('key1', () => { calls.push('a'); });
            debouncer.debounce('key2', () => { calls.push('b'); });
            
            debouncer.cancelAll();
            
            await new Promise(resolve => setTimeout(resolve, 30));
            
            assert.deepStrictEqual(calls, []);
            
            debouncer.dispose();
        });

        it('should report pending status correctly', () => {
            const debouncer = new KeyedDebouncer(100);
            
            assert.strictEqual(debouncer.isPending('key1'), false);
            
            debouncer.debounce('key1', () => {});
            assert.strictEqual(debouncer.isPending('key1'), true);
            assert.strictEqual(debouncer.isPending('key2'), false);
            
            debouncer.cancel('key1');
            assert.strictEqual(debouncer.isPending('key1'), false);
            
            debouncer.dispose();
        });

        it('should not execute after dispose', async () => {
            const debouncer = new KeyedDebouncer(10);
            let executed = false;
            
            debouncer.debounce('key1', () => { executed = true; });
            debouncer.dispose();
            
            await new Promise(resolve => setTimeout(resolve, 20));
            
            assert.strictEqual(executed, false);
        });

        it('should not schedule new callbacks after dispose', () => {
            const debouncer = new KeyedDebouncer(10);
            debouncer.dispose();
            
            // Should not throw
            debouncer.debounce('key1', () => {});
            assert.strictEqual(debouncer.isPending('key1'), false);
        });
    });

    describe('Debouncer (simple)', () => {
        it('should execute callback after delay', async () => {
            const debouncer = new Debouncer(10);
            let executed = false;
            
            debouncer.debounce(() => { executed = true; });
            
            assert.strictEqual(executed, false);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.strictEqual(executed, true);
            
            debouncer.dispose();
        });

        it('should cancel previous callback when called again', async () => {
            const debouncer = new Debouncer(20);
            const calls: number[] = [];
            
            debouncer.debounce(() => { calls.push(1); });
            await new Promise(resolve => setTimeout(resolve, 5));
            debouncer.debounce(() => { calls.push(2); });
            
            await new Promise(resolve => setTimeout(resolve, 30));
            
            assert.deepStrictEqual(calls, [2]);
            
            debouncer.dispose();
        });

        it('should cancel pending callback', async () => {
            const debouncer = new Debouncer(20);
            let executed = false;
            
            debouncer.debounce(() => { executed = true; });
            debouncer.cancel();
            
            await new Promise(resolve => setTimeout(resolve, 30));
            
            assert.strictEqual(executed, false);
            
            debouncer.dispose();
        });

        it('should report pending status correctly', () => {
            const debouncer = new Debouncer(100);
            
            assert.strictEqual(debouncer.isPending(), false);
            
            debouncer.debounce(() => {});
            assert.strictEqual(debouncer.isPending(), true);
            
            debouncer.cancel();
            assert.strictEqual(debouncer.isPending(), false);
            
            debouncer.dispose();
        });

        it('should not execute after dispose', async () => {
            const debouncer = new Debouncer(10);
            let executed = false;
            
            debouncer.debounce(() => { executed = true; });
            debouncer.dispose();
            
            await new Promise(resolve => setTimeout(resolve, 20));
            
            assert.strictEqual(executed, false);
        });

        it('should handle rapid successive calls', async () => {
            const debouncer = new Debouncer(15);
            let counter = 0;
            
            // Rapid fire calls
            for (let i = 0; i < 10; i++) {
                debouncer.debounce(() => { counter++; });
                await new Promise(resolve => setTimeout(resolve, 2));
            }
            
            await new Promise(resolve => setTimeout(resolve, 30));
            
            // Only the last call should execute
            assert.strictEqual(counter, 1);
            
            debouncer.dispose();
        });
    });
});
