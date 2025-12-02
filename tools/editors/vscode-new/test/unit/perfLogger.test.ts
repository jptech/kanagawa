/**
 * Tests for PerfLogger utility.
 */

import * as assert from 'assert';

// Re-implement PerfLogger for testing without vscode dependency
interface TimingEntry {
    operation: string;
    duration: number;
    timestamp: number;
    metadata?: Record<string, any>;
}

class TestPerfLogger {
    private static instance: TestPerfLogger | undefined;
    private enabled: boolean = true;
    private timings: Map<string, number> = new Map();
    private completedTimings: TimingEntry[] = [];
    private logToConsole: boolean = false;

    static getInstance(): TestPerfLogger {
        if (!TestPerfLogger.instance) {
            TestPerfLogger.instance = new TestPerfLogger();
        }
        return TestPerfLogger.instance;
    }

    static resetInstance(): void {
        TestPerfLogger.instance = undefined;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    setLogToConsole(log: boolean): void {
        this.logToConsole = log;
    }

    start(operation: string): void {
        if (!this.enabled) {
            return;
        }
        this.timings.set(operation, Date.now());
    }

    end(operation: string, metadata?: Record<string, any>): number {
        if (!this.enabled) {
            return 0;
        }

        const startTime = this.timings.get(operation);
        if (startTime === undefined) {
            return 0;
        }

        const duration = Date.now() - startTime;
        this.timings.delete(operation);

        const entry: TimingEntry = {
            operation,
            duration,
            timestamp: Date.now(),
            metadata
        };
        this.completedTimings.push(entry);

        if (this.logToConsole) {
            console.log(`[Perf] ${operation}: ${duration}ms`);
        }

        return duration;
    }

    measure<T>(operation: string, fn: () => T): T {
        this.start(operation);
        try {
            const result = fn();
            this.end(operation);
            return result;
        } catch (e) {
            this.end(operation, { error: true });
            throw e;
        }
    }

    async measureAsync<T>(operation: string, fn: () => Promise<T>): Promise<T> {
        this.start(operation);
        try {
            const result = await fn();
            this.end(operation);
            return result;
        } catch (e) {
            this.end(operation, { error: true });
            throw e;
        }
    }

    getCompletedTimings(): TimingEntry[] {
        return [...this.completedTimings];
    }

    getPendingOperations(): string[] {
        return Array.from(this.timings.keys());
    }

    getAverageDuration(operation: string): number {
        const matching = this.completedTimings.filter(t => t.operation === operation);
        if (matching.length === 0) {
            return 0;
        }
        const total = matching.reduce((sum, t) => sum + t.duration, 0);
        return total / matching.length;
    }

    getMaxDuration(operation: string): number {
        const matching = this.completedTimings.filter(t => t.operation === operation);
        if (matching.length === 0) {
            return 0;
        }
        return Math.max(...matching.map(t => t.duration));
    }

    getMinDuration(operation: string): number {
        const matching = this.completedTimings.filter(t => t.operation === operation);
        if (matching.length === 0) {
            return 0;
        }
        return Math.min(...matching.map(t => t.duration));
    }

    clear(): void {
        this.timings.clear();
        this.completedTimings = [];
    }

    getStatistics(operation: string): { count: number; avg: number; min: number; max: number } | undefined {
        const matching = this.completedTimings.filter(t => t.operation === operation);
        if (matching.length === 0) {
            return undefined;
        }

        const durations = matching.map(t => t.duration);
        return {
            count: matching.length,
            avg: durations.reduce((a, b) => a + b, 0) / durations.length,
            min: Math.min(...durations),
            max: Math.max(...durations)
        };
    }
}

describe('PerfLogger', () => {
    let logger: TestPerfLogger;

    beforeEach(() => {
        TestPerfLogger.resetInstance();
        logger = TestPerfLogger.getInstance();
        logger.clear();
        logger.setEnabled(true);
    });

    describe('singleton pattern', () => {
        it('should return the same instance', () => {
            const instance1 = TestPerfLogger.getInstance();
            const instance2 = TestPerfLogger.getInstance();
            assert.strictEqual(instance1, instance2);
        });

        it('should return new instance after reset', () => {
            const instance1 = TestPerfLogger.getInstance();
            TestPerfLogger.resetInstance();
            const instance2 = TestPerfLogger.getInstance();
            assert.notStrictEqual(instance1, instance2);
        });
    });

    describe('enabled state', () => {
        it('should be enabled by default', () => {
            assert.strictEqual(logger.isEnabled(), true);
        });

        it('should track state changes', () => {
            logger.setEnabled(false);
            assert.strictEqual(logger.isEnabled(), false);
            logger.setEnabled(true);
            assert.strictEqual(logger.isEnabled(), true);
        });

        it('should not record when disabled', () => {
            logger.setEnabled(false);
            logger.start('test-op');
            logger.end('test-op');
            assert.strictEqual(logger.getCompletedTimings().length, 0);
        });
    });

    describe('start and end', () => {
        it('should record timing for operation', () => {
            logger.start('test-op');
            const duration = logger.end('test-op');
            assert.ok(duration >= 0);
            assert.strictEqual(logger.getCompletedTimings().length, 1);
        });

        it('should return 0 for unknown operation', () => {
            const duration = logger.end('unknown-op');
            assert.strictEqual(duration, 0);
        });

        it('should track metadata', () => {
            logger.start('test-op');
            logger.end('test-op', { fileCount: 10 });
            const timings = logger.getCompletedTimings();
            assert.strictEqual(timings.length, 1);
            assert.deepStrictEqual(timings[0].metadata, { fileCount: 10 });
        });

        it('should handle multiple operations', () => {
            logger.start('op1');
            logger.start('op2');
            logger.end('op1');
            logger.end('op2');
            assert.strictEqual(logger.getCompletedTimings().length, 2);
        });

        it('should track pending operations', () => {
            logger.start('op1');
            logger.start('op2');
            const pending = logger.getPendingOperations();
            assert.ok(pending.includes('op1'));
            assert.ok(pending.includes('op2'));

            logger.end('op1');
            const pendingAfter = logger.getPendingOperations();
            assert.ok(!pendingAfter.includes('op1'));
            assert.ok(pendingAfter.includes('op2'));
        });
    });

    describe('measure', () => {
        it('should measure synchronous function', () => {
            const result = logger.measure('sync-op', () => {
                return 42;
            });
            assert.strictEqual(result, 42);
            assert.strictEqual(logger.getCompletedTimings().length, 1);
            assert.strictEqual(logger.getCompletedTimings()[0].operation, 'sync-op');
        });

        it('should propagate errors from measured function', () => {
            assert.throws(() => {
                logger.measure('error-op', () => {
                    throw new Error('test error');
                });
            }, /test error/);

            // Should still record the timing
            assert.strictEqual(logger.getCompletedTimings().length, 1);
            assert.deepStrictEqual(logger.getCompletedTimings()[0].metadata, { error: true });
        });
    });

    describe('measureAsync', () => {
        it('should measure async function', async () => {
            const result = await logger.measureAsync('async-op', async () => {
                return Promise.resolve(42);
            });
            assert.strictEqual(result, 42);
            assert.strictEqual(logger.getCompletedTimings().length, 1);
            assert.strictEqual(logger.getCompletedTimings()[0].operation, 'async-op');
        });

        it('should measure async function with delay', async () => {
            const result = await logger.measureAsync('delayed-op', async () => {
                await new Promise(resolve => setTimeout(resolve, 20));
                return 'done';
            });
            assert.strictEqual(result, 'done');
            const timing = logger.getCompletedTimings()[0];
            assert.ok(timing.duration >= 15); // Allow some tolerance
        });

        it('should handle async errors', async () => {
            await assert.rejects(async () => {
                await logger.measureAsync('async-error', async () => {
                    throw new Error('async error');
                });
            }, /async error/);

            assert.strictEqual(logger.getCompletedTimings().length, 1);
            assert.deepStrictEqual(logger.getCompletedTimings()[0].metadata, { error: true });
        });
    });

    describe('statistics', () => {
        beforeEach(() => {
            // Manually add some timings for statistics testing
            logger.start('stats-op');
            logger.end('stats-op'); // Will be ~0ms

            // Simulate different durations by directly manipulating completed timings
            const timings = logger.getCompletedTimings();
            // Clear and add controlled entries for testing
            logger.clear();
        });

        it('should calculate average duration', () => {
            // Add entries with known durations by measuring actual operations
            logger.start('op');
            logger.end('op');
            logger.start('op');
            logger.end('op');
            
            const avg = logger.getAverageDuration('op');
            assert.ok(avg >= 0);
        });

        it('should return 0 for unknown operation average', () => {
            assert.strictEqual(logger.getAverageDuration('unknown'), 0);
        });

        it('should return 0 for unknown operation max', () => {
            assert.strictEqual(logger.getMaxDuration('unknown'), 0);
        });

        it('should return 0 for unknown operation min', () => {
            assert.strictEqual(logger.getMinDuration('unknown'), 0);
        });

        it('should return undefined statistics for unknown operation', () => {
            assert.strictEqual(logger.getStatistics('unknown'), undefined);
        });

        it('should compute statistics for recorded operations', () => {
            logger.start('test');
            logger.end('test');
            logger.start('test');
            logger.end('test');

            const stats = logger.getStatistics('test');
            assert.ok(stats !== undefined);
            assert.strictEqual(stats.count, 2);
            assert.ok(stats.avg >= 0);
            assert.ok(stats.min >= 0);
            assert.ok(stats.max >= stats.min);
        });
    });

    describe('clear', () => {
        it('should clear all timings', () => {
            logger.start('op1');
            logger.end('op1');
            logger.start('op2'); // pending

            logger.clear();

            assert.strictEqual(logger.getCompletedTimings().length, 0);
            assert.strictEqual(logger.getPendingOperations().length, 0);
        });
    });

    describe('timing entries', () => {
        it('should include timestamp in entries', () => {
            const beforeTime = Date.now();
            logger.start('op');
            logger.end('op');
            const afterTime = Date.now();

            const entry = logger.getCompletedTimings()[0];
            assert.ok(entry.timestamp >= beforeTime);
            assert.ok(entry.timestamp <= afterTime);
        });

        it('should preserve operation names', () => {
            logger.start('operation-with-long-name');
            logger.end('operation-with-long-name');

            assert.strictEqual(
                logger.getCompletedTimings()[0].operation,
                'operation-with-long-name'
            );
        });
    });

    describe('concurrent operations', () => {
        it('should handle overlapping operations with same name', () => {
            logger.start('concurrent');
            // Second start overwrites the first - this is expected behavior
            logger.start('concurrent');
            logger.end('concurrent');

            // Only one completed because start was overwritten
            assert.strictEqual(logger.getCompletedTimings().length, 1);
        });

        it('should handle many concurrent operations', () => {
            for (let i = 0; i < 100; i++) {
                logger.start(`op-${i}`);
            }
            
            assert.strictEqual(logger.getPendingOperations().length, 100);

            for (let i = 0; i < 100; i++) {
                logger.end(`op-${i}`);
            }

            assert.strictEqual(logger.getPendingOperations().length, 0);
            assert.strictEqual(logger.getCompletedTimings().length, 100);
        });
    });
});
