/**
 * Timeout and safety utilities for provider operations.
 * 
 * These utilities prevent providers from hanging indefinitely by adding
 * timeouts to async operations and proper error boundaries.
 */

/**
 * Default timeout values for different operation types (in milliseconds).
 */
export const OPERATION_TIMEOUTS = {
    /** Timeout for hover operations - should be fast */
    HOVER: 2000,
    /** Timeout for definition lookup */
    DEFINITION: 3000,
    /** Timeout for completion - needs to feel responsive */
    COMPLETION: 2000,
    /** Timeout for references - can be slower for large workspaces */
    REFERENCES: 10000,
    /** Timeout for signature help */
    SIGNATURE_HELP: 2000,
    /** Timeout for inlay hints */
    INLAY_HINTS: 5000,
    /** Timeout for type inference */
    TYPE_INFERENCE: 1000,
    /** Timeout for member resolution */
    MEMBER_RESOLUTION: 2000,
    /** Timeout for symbol resolution */
    SYMBOL_RESOLUTION: 2000,
} as const;

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}

/**
 * Wraps an async operation with a timeout.
 * If the operation takes longer than the timeout, returns undefined.
 * 
 * @param operation Name of the operation (for logging)
 * @param promise The async operation to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param fallback Optional fallback value on timeout (defaults to undefined)
 * @returns The operation result or fallback value
 */
export async function withTimeout<T>(
    operation: string,
    promise: Promise<T>,
    timeoutMs: number,
    fallback?: T
): Promise<T | undefined> {
    let timeoutId: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<T | undefined>((resolve) => {
        timeoutId = setTimeout(() => {
            console.warn(`Kanagawa: ${operation} timed out after ${timeoutMs}ms`);
            resolve(fallback);
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        return result;
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Wraps an async operation with a timeout that throws on timeout.
 * Use this when you need to know if a timeout occurred.
 * 
 * @param operation Name of the operation (for error message)
 * @param promise The async operation to wrap
 * @param timeoutMs Timeout in milliseconds
 * @returns The operation result
 * @throws TimeoutError if the operation times out
 */
export async function withTimeoutThrow<T>(
    operation: string,
    promise: Promise<T>,
    timeoutMs: number
): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new TimeoutError(operation, timeoutMs));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Wraps an async operation with both timeout and cancellation support.
 * Returns undefined if cancelled or timed out.
 * 
 * @param operation Name of the operation (for logging)
 * @param promise The async operation to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param isCancelled Function that returns true if operation should be cancelled
 * @returns The operation result or undefined
 */
export async function withTimeoutAndCancellation<T>(
    operation: string,
    promise: Promise<T>,
    timeoutMs: number,
    isCancelled: () => boolean
): Promise<T | undefined> {
    // Check cancellation before starting
    if (isCancelled()) {
        return undefined;
    }

    let timeoutId: NodeJS.Timeout | undefined;
    let cancelled = false;
    
    const timeoutPromise = new Promise<T | undefined>((resolve) => {
        timeoutId = setTimeout(() => {
            if (!cancelled) {
                console.warn(`Kanagawa: ${operation} timed out after ${timeoutMs}ms`);
            }
            resolve(undefined);
        }, timeoutMs);
    });

    // Also check cancellation periodically
    const cancellationCheckPromise = new Promise<T | undefined>((resolve) => {
        const checkInterval = setInterval(() => {
            if (isCancelled()) {
                cancelled = true;
                clearInterval(checkInterval);
                resolve(undefined);
            }
        }, 50);
        
        // Clean up interval when promise resolves
        promise.finally(() => clearInterval(checkInterval));
        timeoutPromise.finally(() => clearInterval(checkInterval));
    });

    try {
        const result = await Promise.race([promise, timeoutPromise, cancellationCheckPromise]);
        return result;
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Safely executes an async operation with error handling.
 * Returns undefined on any error, logging the error for debugging.
 * 
 * @param operation Name of the operation (for logging)
 * @param fn The async function to execute
 * @returns The result or undefined on error
 */
export async function safeAsync<T>(
    operation: string,
    fn: () => Promise<T>
): Promise<T | undefined> {
    try {
        return await fn();
    } catch (error) {
        console.error(`Kanagawa: ${operation} failed:`, error);
        return undefined;
    }
}

/**
 * Combines timeout, cancellation, and error handling for provider operations.
 * This is the recommended wrapper for all provider entry points.
 * 
 * @param operation Name of the operation
 * @param fn The async function to execute
 * @param timeoutMs Timeout in milliseconds
 * @param isCancelled Function that returns true if cancelled
 * @returns The result or undefined on error/timeout/cancellation
 */
export async function safeProviderOperation<T>(
    operation: string,
    fn: () => Promise<T>,
    timeoutMs: number,
    isCancelled: () => boolean
): Promise<T | undefined> {
    // Check cancellation before starting
    if (isCancelled()) {
        return undefined;
    }

    try {
        return await withTimeoutAndCancellation(
            operation,
            fn(),
            timeoutMs,
            isCancelled
        );
    } catch (error) {
        // Don't log cancellation as errors
        if (error instanceof Error && error.name === 'CancellationError') {
            return undefined;
        }
        console.error(`Kanagawa: ${operation} failed:`, error);
        return undefined;
    }
}

/**
 * Circuit breaker state for tracking operation failures.
 */
interface CircuitBreakerState {
    failures: number;
    lastFailure: number;
    isOpen: boolean;
}

/**
 * Simple circuit breaker to prevent repeated failures from degrading performance.
 * After a threshold of failures, the circuit "opens" and rejects operations
 * for a cooldown period.
 */
export class CircuitBreaker {
    private state: CircuitBreakerState = {
        failures: 0,
        lastFailure: 0,
        isOpen: false
    };

    /**
     * Creates a circuit breaker.
     * @param failureThreshold Number of failures before opening the circuit
     * @param cooldownMs Time in ms before attempting operations again
     */
    constructor(
        private readonly failureThreshold: number = 5,
        private readonly cooldownMs: number = 30000
    ) {}

    /**
     * Records a successful operation, resetting the failure count.
     */
    recordSuccess(): void {
        this.state.failures = 0;
        this.state.isOpen = false;
    }

    /**
     * Records a failed operation.
     */
    recordFailure(): void {
        this.state.failures++;
        this.state.lastFailure = Date.now();
        
        if (this.state.failures >= this.failureThreshold) {
            this.state.isOpen = true;
            console.warn(`Kanagawa: Circuit breaker opened after ${this.state.failures} failures`);
        }
    }

    /**
     * Returns true if operations should be attempted.
     * If the circuit is open, checks if cooldown has elapsed.
     */
    shouldAttempt(): boolean {
        if (!this.state.isOpen) {
            return true;
        }

        // Check if cooldown has elapsed
        const elapsed = Date.now() - this.state.lastFailure;
        if (elapsed >= this.cooldownMs) {
            // Reset to half-open state (allow one attempt)
            this.state.isOpen = false;
            this.state.failures = Math.floor(this.failureThreshold / 2);
            console.log('Kanagawa: Circuit breaker reset, attempting operations again');
            return true;
        }

        return false;
    }

    /**
     * Executes an operation with circuit breaker protection.
     */
    async execute<T>(
        operation: string,
        fn: () => Promise<T>
    ): Promise<T | undefined> {
        if (!this.shouldAttempt()) {
            console.warn(`Kanagawa: ${operation} skipped - circuit breaker open`);
            return undefined;
        }

        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (error) {
            this.recordFailure();
            throw error;
        }
    }
}
