/**
 * Tests for timeout utilities to ensure robustness of provider operations.
 */

import * as assert from 'assert';
import { 
    OPERATION_TIMEOUTS,
    TimeoutError,
    withTimeout,
    withTimeoutThrow,
    withTimeoutAndCancellation,
    safeProviderOperation,
    CircuitBreaker
} from '../../src/utils/timeout';

describe('Timeout Utilities', () => {
    describe('OPERATION_TIMEOUTS constants', () => {
        it('should have reasonable values for user-facing operations', () => {
            // Fast operations should be under 3 seconds
            assert.ok(OPERATION_TIMEOUTS.HOVER <= 3000);
            assert.ok(OPERATION_TIMEOUTS.COMPLETION <= 3000);
            assert.ok(OPERATION_TIMEOUTS.SIGNATURE_HELP <= 3000);
            
            // Symbol resolution should be reasonably fast
            assert.ok(OPERATION_TIMEOUTS.SYMBOL_RESOLUTION <= 5000);
            
            // Longer operations can take more time
            assert.ok(OPERATION_TIMEOUTS.DEFINITION > OPERATION_TIMEOUTS.HOVER);
            assert.ok(OPERATION_TIMEOUTS.REFERENCES > OPERATION_TIMEOUTS.DEFINITION);
        });

        it('should have all required timeout constants', () => {
            assert.ok(typeof OPERATION_TIMEOUTS.HOVER === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.DEFINITION === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.COMPLETION === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.REFERENCES === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.RENAME === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.SIGNATURE_HELP === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.INLAY_HINTS === 'number');
            assert.ok(typeof OPERATION_TIMEOUTS.SYMBOL_RESOLUTION === 'number');
        });
    });

    describe('TimeoutError', () => {
        it('should create error with operation name', () => {
            const error = new TimeoutError('test operation', 1000);
            assert.ok(error.message.includes('test operation'));
            assert.ok(error.message.includes('1000'));
            assert.strictEqual(error.name, 'TimeoutError');
        });

        it('should be instanceof Error', () => {
            const error = new TimeoutError('test', 500);
            assert.ok(error instanceof Error);
            assert.ok(error instanceof TimeoutError);
        });
    });

    describe('withTimeout', () => {
        it('should return result when operation completes in time', async () => {
            const fastOperation = Promise.resolve('success');
            const result = await withTimeout('test', fastOperation, 1000);
            assert.strictEqual(result, 'success');
        });

        it('should return undefined when operation times out', async () => {
            const slowOperation = new Promise<string>(resolve => {
                setTimeout(() => resolve('too late'), 100);
            });
            const result = await withTimeout('test', slowOperation, 10);
            assert.strictEqual(result, undefined);
        });

        it('should handle null results correctly', async () => {
            const nullOperation = Promise.resolve(null);
            const result = await withTimeout('test', nullOperation, 1000);
            assert.strictEqual(result, null);
        });

        it('should handle zero results correctly', async () => {
            const zeroOperation = Promise.resolve(0);
            const result = await withTimeout('test', zeroOperation, 1000);
            assert.strictEqual(result, 0);
        });

        it('should handle array results correctly', async () => {
            const arrayOperation = Promise.resolve([1, 2, 3]);
            const result = await withTimeout('test', arrayOperation, 1000);
            assert.deepStrictEqual(result, [1, 2, 3]);
        });

        it('should propagate errors from the operation', async () => {
            const errorOperation = Promise.reject(new Error('test error'));
            try {
                await withTimeout('test', errorOperation, 1000);
                assert.fail('Should have thrown');
            } catch (error) {
                assert.ok((error as Error).message.includes('test error'));
            }
        });

        it('should use fallback value on timeout', async () => {
            const slowOperation = new Promise<string>(resolve => {
                setTimeout(() => resolve('too late'), 100);
            });
            const result = await withTimeout('test', slowOperation, 10, 'fallback');
            assert.strictEqual(result, 'fallback');
        });
    });

    describe('withTimeoutThrow', () => {
        it('should return result when operation completes in time', async () => {
            const fastOperation = Promise.resolve('success');
            const result = await withTimeoutThrow('test', fastOperation, 1000);
            assert.strictEqual(result, 'success');
        });

        it('should throw TimeoutError when operation times out', async () => {
            const slowOperation = new Promise<string>(resolve => {
                setTimeout(() => resolve('too late'), 100);
            });
            try {
                await withTimeoutThrow('test', slowOperation, 10);
                assert.fail('Should have thrown TimeoutError');
            } catch (error) {
                assert.ok(error instanceof TimeoutError);
            }
        });

        it('should include operation name in timeout error message', async () => {
            const slowOperation = new Promise<string>(resolve => {
                setTimeout(() => resolve('too late'), 100);
            });
            try {
                await withTimeoutThrow('my operation', slowOperation, 10);
                assert.fail('Should have thrown');
            } catch (error) {
                assert.ok((error as Error).message.includes('my operation'));
            }
        });
    });

    describe('withTimeoutAndCancellation', () => {
        it('should return result when operation completes in time', async () => {
            const isCancelled = () => false;
            const fastOperation = Promise.resolve('success');
            const result = await withTimeoutAndCancellation('test', fastOperation, 1000, isCancelled);
            assert.strictEqual(result, 'success');
        });

        it('should return undefined when cancelled before completion', async () => {
            const isCancelled = () => true;
            const operation = Promise.resolve('should not see this');
            const result = await withTimeoutAndCancellation('test', operation, 1000, isCancelled);
            assert.strictEqual(result, undefined);
        });

        it('should return undefined on timeout', async () => {
            const isCancelled = () => false;
            const slowOperation = new Promise<string>(resolve => {
                setTimeout(() => resolve('too late'), 100);
            });
            const result = await withTimeoutAndCancellation('test', slowOperation, 10, isCancelled);
            assert.strictEqual(result, undefined);
        });
    });

    describe('safeProviderOperation', () => {
        it('should return result from factory when successful', async () => {
            const isCancelled = () => false;
            const result = await safeProviderOperation(
                'test',
                async () => 'success',
                1000,
                isCancelled
            );
            assert.strictEqual(result, 'success');
        });

        it('should return undefined on timeout', async () => {
            const isCancelled = () => false;
            const result = await safeProviderOperation(
                'test',
                async () => {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    return 'too late';
                },
                10,
                isCancelled
            );
            assert.strictEqual(result, undefined);
        });

        it('should return undefined when cancelled', async () => {
            const isCancelled = () => true;
            const result = await safeProviderOperation(
                'test',
                async () => 'should not run',
                1000,
                isCancelled
            );
            assert.strictEqual(result, undefined);
        });

        it('should return undefined on error', async () => {
            const isCancelled = () => false;
            const result = await safeProviderOperation(
                'test',
                async () => { throw new Error('test error'); },
                1000,
                isCancelled
            );
            assert.strictEqual(result, undefined);
        });
    });

    describe('CircuitBreaker', () => {
        it('should allow operations when closed', async () => {
            const breaker = new CircuitBreaker(3, 1000);
            const result = await breaker.execute('test', async () => 'success');
            assert.strictEqual(result, 'success');
        });

        it('should open after threshold failures', async () => {
            const breaker = new CircuitBreaker(2, 10000);
            
            // Fail twice to open the circuit
            try {
                await breaker.execute('test', async () => { throw new Error('fail 1'); });
            } catch { /* expected */ }
            
            try {
                await breaker.execute('test', async () => { throw new Error('fail 2'); });
            } catch { /* expected */ }
            
            // Now circuit should be open - should return undefined instead of throwing
            const result = await breaker.execute('test', async () => 'should not run');
            assert.strictEqual(result, undefined);
        });

        it('should reset after timeout when half-open succeeds', async () => {
            const breaker = new CircuitBreaker(1, 10); // Very short cooldown for testing
            
            // Open the circuit
            try {
                await breaker.execute('test', async () => { throw new Error('fail'); });
            } catch { /* expected */ }
            
            // Wait for reset timeout
            await new Promise(resolve => setTimeout(resolve, 20));
            
            // Should allow one request (half-open state)
            const result = await breaker.execute('test', async () => 'success');
            assert.strictEqual(result, 'success');
            
            // Circuit should be closed again
            const result2 = await breaker.execute('test', async () => 'also success');
            assert.strictEqual(result2, 'also success');
        });

        it('should track success count correctly', async () => {
            const breaker = new CircuitBreaker(5, 1000);
            
            await breaker.execute('test', async () => 'success 1');
            await breaker.execute('test', async () => 'success 2');
            
            // Still allows operations
            const result = await breaker.execute('test', async () => 'success 3');
            assert.strictEqual(result, 'success 3');
        });

        it('should reset failure count on success', async () => {
            const breaker = new CircuitBreaker(3, 1000);
            
            // Two failures
            try {
                await breaker.execute('test', async () => { throw new Error('fail 1'); });
            } catch { /* expected */ }
            
            try {
                await breaker.execute('test', async () => { throw new Error('fail 2'); });
            } catch { /* expected */ }
            
            // One success should reset
            await breaker.execute('test', async () => 'success');
            
            // Now two more failures should be fine (reset to 0)
            try {
                await breaker.execute('test', async () => { throw new Error('fail 3'); });
            } catch { /* expected */ }
            
            try {
                await breaker.execute('test', async () => { throw new Error('fail 4'); });
            } catch { /* expected */ }
            
            // Still not open (reset after success)
            const result = await breaker.execute('test', async () => 'still working');
            assert.strictEqual(result, 'still working');
        });
    });

    describe('Edge Cases', () => {
        it('should handle very short timeouts', async () => {
            const operation = Promise.resolve('fast');
            // Even with 1ms timeout, synchronously resolved promises should complete
            const result = await withTimeout('test', operation, 1);
            assert.strictEqual(result, 'fast');
        });

        it('should handle undefined values correctly', async () => {
            const operation = Promise.resolve(undefined);
            const result = await withTimeout('test', operation, 1000);
            assert.strictEqual(result, undefined);
        });

        it('should handle complex objects', async () => {
            const complexResult = {
                symbols: [{ name: 'test', kind: 'function' }],
                confidence: 'high' as const,
                alternatives: []
            };
            const operation = Promise.resolve(complexResult);
            const result = await withTimeout('test', operation, 1000);
            assert.deepStrictEqual(result, complexResult);
        });

        it('should handle concurrent operations', async () => {
            const operations = Array.from({ length: 10 }, (_, i) => 
                withTimeout(`op-${i}`, Promise.resolve(i), 1000)
            );
            const results = await Promise.all(operations);
            assert.deepStrictEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        });
    });
});
