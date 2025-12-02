/**
 * Tests for cooperative scheduling utilities.
 */

import * as assert from 'assert';
import {
    getWorkspaceSize,
    computeChunkSize,
    DEFAULT_SCHEDULER_CONFIG,
    CooperativeScheduler,
    processCooperatively,
    iterateCooperatively,
    createIndexingScheduler,
    createProviderScheduler
} from '../../src/utils/scheduling';

describe('Cooperative Scheduling', () => {
    describe('getWorkspaceSize', () => {
        it('should return small for < 100 files', () => {
            assert.strictEqual(getWorkspaceSize(0), 'small');
            assert.strictEqual(getWorkspaceSize(50), 'small');
            assert.strictEqual(getWorkspaceSize(99), 'small');
        });

        it('should return medium for 100-999 files', () => {
            assert.strictEqual(getWorkspaceSize(100), 'medium');
            assert.strictEqual(getWorkspaceSize(500), 'medium');
            assert.strictEqual(getWorkspaceSize(999), 'medium');
        });

        it('should return large for >= 1000 files', () => {
            assert.strictEqual(getWorkspaceSize(1000), 'large');
            assert.strictEqual(getWorkspaceSize(5000), 'large');
        });
    });

    describe('computeChunkSize', () => {
        it('should apply small multiplier for small workspaces', () => {
            const chunk = computeChunkSize(DEFAULT_SCHEDULER_CONFIG, 'small');
            assert.strictEqual(chunk, DEFAULT_SCHEDULER_CONFIG.baseChunkSize * DEFAULT_SCHEDULER_CONFIG.smallWorkspaceMultiplier);
        });

        it('should apply medium multiplier for medium workspaces', () => {
            const chunk = computeChunkSize(DEFAULT_SCHEDULER_CONFIG, 'medium');
            assert.strictEqual(chunk, DEFAULT_SCHEDULER_CONFIG.baseChunkSize * DEFAULT_SCHEDULER_CONFIG.mediumWorkspaceMultiplier);
        });

        it('should apply large multiplier for large workspaces', () => {
            const chunk = computeChunkSize(DEFAULT_SCHEDULER_CONFIG, 'large');
            assert.strictEqual(chunk, DEFAULT_SCHEDULER_CONFIG.baseChunkSize * DEFAULT_SCHEDULER_CONFIG.largeWorkspaceMultiplier);
        });
    });

    describe('CooperativeScheduler', () => {
        it('should create with default config', () => {
            const scheduler = new CooperativeScheduler();
            assert.ok(scheduler.getChunkSize() > 0);
        });

        it('should update workspace size', () => {
            const scheduler = new CooperativeScheduler();
            const mediumChunk = scheduler.getChunkSize();
            
            scheduler.setWorkspaceSize('small');
            const smallChunk = scheduler.getChunkSize();
            
            assert.ok(smallChunk > mediumChunk, 'Small workspace should have larger chunks');
        });

        it('should tick and track items', () => {
            const scheduler = new CooperativeScheduler(
                { ...DEFAULT_SCHEDULER_CONFIG, baseChunkSize: 5 },
                'large'
            );
            
            // Process items below chunk size - should not yield
            for (let i = 0; i < 4; i++) {
                assert.strictEqual(scheduler.tick(), false);
            }
            
            // At chunk size - should yield
            assert.strictEqual(scheduler.tick(), true);
        });

        it('should reset counters', () => {
            const scheduler = new CooperativeScheduler(
                { ...DEFAULT_SCHEDULER_CONFIG, baseChunkSize: 5 },
                'large'
            );
            
            // Tick a few times
            scheduler.tick();
            scheduler.tick();
            
            // Reset
            scheduler.reset();
            
            // Should start fresh - need full chunk before yield
            for (let i = 0; i < 4; i++) {
                assert.strictEqual(scheduler.tick(), false);
            }
        });
    });

    describe('processCooperatively', () => {
        it('should process all items', async () => {
            const items = [1, 2, 3, 4, 5];
            const results = await processCooperatively(items, (x) => x * 2);
            assert.deepStrictEqual(results, [2, 4, 6, 8, 10]);
        });

        it('should handle async processors', async () => {
            const items = [1, 2, 3];
            const results = await processCooperatively(items, async (x) => {
                return x + 1;
            });
            assert.deepStrictEqual(results, [2, 3, 4]);
        });

        it('should call progress callback', async () => {
            const items = [1, 2, 3, 4, 5];
            const progressCalls: [number, number][] = [];
            
            await processCooperatively(items, (x) => x, {
                progress: (processed, total) => {
                    progressCalls.push([processed, total]);
                }
            });
            
            assert.strictEqual(progressCalls.length, 5);
            assert.deepStrictEqual(progressCalls[0], [1, 5]);
            assert.deepStrictEqual(progressCalls[4], [5, 5]);
        });

        it('should respect cancellation token', async () => {
            const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const processed: number[] = [];
            let cancelled = false;
            
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} })
            };
            
            await processCooperatively(items, (x) => {
                if (x === 5) {
                    token.isCancellationRequested = true;
                    cancelled = true;
                }
                processed.push(x);
                return x;
            }, { token: token as any });
            
            assert.ok(cancelled);
            // Items up to and including 5 were processed
            assert.ok(processed.length <= 6);
        });
    });

    describe('iterateCooperatively', () => {
        it('should iterate all items', async () => {
            const items = [1, 2, 3, 4, 5];
            const seen: number[] = [];
            
            await iterateCooperatively(items, (x) => {
                seen.push(x);
            });
            
            assert.deepStrictEqual(seen, items);
        });

        it('should handle async callbacks', async () => {
            const items = ['a', 'b', 'c'];
            const seen: string[] = [];
            
            await iterateCooperatively(items, async (x) => {
                seen.push(x);
            });
            
            assert.deepStrictEqual(seen, items);
        });
    });

    describe('Scheduler Factories', () => {
        it('createIndexingScheduler should create for indexing workload', () => {
            const scheduler = createIndexingScheduler(500);
            assert.ok(scheduler.getChunkSize() > 0);
        });

        it('createProviderScheduler should create for provider workload', () => {
            const scheduler = createProviderScheduler(500);
            assert.ok(scheduler.getChunkSize() > 0);
        });

        it('provider scheduler should have larger chunks than indexing for same workspace', () => {
            const indexingScheduler = createIndexingScheduler(500);
            const providerScheduler = createProviderScheduler(500);
            
            // Provider scheduler handles lighter work, so can process more items
            assert.ok(
                providerScheduler.getChunkSize() > indexingScheduler.getChunkSize(),
                'Provider scheduler should have larger chunks for lighter workloads'
            );
        });
    });

    describe('DEFAULT_SCHEDULER_CONFIG', () => {
        it('should have reasonable defaults', () => {
            assert.ok(DEFAULT_SCHEDULER_CONFIG.baseChunkSize > 0);
            assert.ok(DEFAULT_SCHEDULER_CONFIG.maxTimeBeforeYield > 0);
            assert.ok(DEFAULT_SCHEDULER_CONFIG.smallWorkspaceMultiplier >= 1);
            assert.ok(DEFAULT_SCHEDULER_CONFIG.mediumWorkspaceMultiplier >= 1);
            assert.ok(DEFAULT_SCHEDULER_CONFIG.largeWorkspaceMultiplier >= 1);
        });

        it('should have increasing multipliers for smaller workspaces', () => {
            assert.ok(
                DEFAULT_SCHEDULER_CONFIG.smallWorkspaceMultiplier >= DEFAULT_SCHEDULER_CONFIG.mediumWorkspaceMultiplier,
                'Small workspace multiplier should be >= medium'
            );
            assert.ok(
                DEFAULT_SCHEDULER_CONFIG.mediumWorkspaceMultiplier >= DEFAULT_SCHEDULER_CONFIG.largeWorkspaceMultiplier,
                'Medium workspace multiplier should be >= large'
            );
        });
    });
});
