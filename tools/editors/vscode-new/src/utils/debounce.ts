/**
 * Debouncing utilities for event handling.
 * Prevents rapid-fire events from causing performance issues.
 */

import * as vscode from 'vscode';

/**
 * A debouncer that groups rapid calls by a key and executes only the last one.
 * Useful for document change events where we want to wait for typing to pause.
 */
export class KeyedDebouncer<K = string> implements vscode.Disposable {
    private readonly timers = new Map<K, NodeJS.Timeout>();
    private disposed = false;
    /** Track in-flight async callbacks to prevent overlapping executions */
    private readonly inFlight = new Map<K, Promise<void>>();

    /**
     * Creates a new debouncer.
     * @param defaultDelay Default delay in milliseconds before executing the callback
     */
    constructor(private readonly defaultDelay: number = 200) {}

    /**
     * Schedules a callback to be executed after the delay.
     * If called again with the same key before the delay expires, 
     * the previous callback is cancelled and the delay resets.
     * 
     * Handles both sync and async callbacks safely. Async callbacks are properly
     * awaited and their errors are caught to prevent unhandled promise rejections.
     * 
     * @param key Unique identifier for this debounced action
     * @param callback The function to execute after the delay (can be async)
     * @param delay Optional custom delay (defaults to constructor value)
     */
    debounce(key: K, callback: () => void | Promise<void>, delay?: number): void {
        if (this.disposed) { return; }

        const effectiveDelay = delay ?? this.defaultDelay;

        // Cancel any existing timer for this key
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        // Schedule new timer
        const timer = setTimeout(() => {
            this.timers.delete(key);
            if (!this.disposed) {
                // Wrap in async IIFE to properly handle async callbacks
                const executeCallback = async (): Promise<void> => {
                    try {
                        // If there's already an in-flight callback for this key, wait for it
                        // This prevents overlapping async operations on the same document
                        const pending = this.inFlight.get(key);
                        if (pending) {
                            try {
                                await pending;
                            } catch {
                                // Ignore errors from previous callback
                            }
                        }
                        
                        // Check disposed again after potentially waiting
                        if (this.disposed) { return; }
                        
                        // Execute the callback and await if it's a promise
                        const result = callback();
                        if (result && typeof result.then === 'function') {
                            await result;
                        }
                    } catch (e) {
                        // Log error but don't crash - this is critical for stability
                        console.error(`Kanagawa: Debounced callback error for key ${key}:`, e);
                    } finally {
                        this.inFlight.delete(key);
                    }
                };
                
                // Track the in-flight promise
                const promise = executeCallback();
                this.inFlight.set(key, promise);
            }
        }, effectiveDelay);

        this.timers.set(key, timer);
    }

    /**
     * Cancels any pending callback for the given key.
     * Also waits for any in-flight async callback to complete (best-effort).
     */
    cancel(key: K): void {
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
        // Note: we don't await in-flight here to keep cancel() synchronous,
        // but the in-flight map entry is preserved so new debounce() calls can wait
    }

    /**
     * Cancels all pending callbacks.
     */
    cancelAll(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    /**
     * Returns true if there's a pending callback for the given key.
     */
    isPending(key: K): boolean {
        return this.timers.has(key);
    }

    /**
     * Disposes the debouncer and cancels all pending callbacks.
     * Any in-flight async callbacks will complete but their results are ignored.
     */
    dispose(): void {
        this.disposed = true;
        this.cancelAll();
        this.inFlight.clear();
    }
}

/**
 * A simple single-action debouncer (not keyed).
 */
export class Debouncer implements vscode.Disposable {
    private timer: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(private readonly delay: number = 200) {}

    /**
     * Schedules the callback to run after the delay.
     * Cancels any previously scheduled callback.
     */
    debounce(callback: () => void): void {
        if (this.disposed) { return; }

        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.disposed) {
                try {
                    callback();
                } catch (e) {
                    console.error('Kanagawa: Debounced callback error:', e);
                }
            }
        }, this.delay);
    }

    /**
     * Cancels any pending callback.
     */
    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.cancel();
    }
}

/**
 * Configuration constants for debounce delays.
 * These can be tuned based on user feedback.
 */
export const DEBOUNCE_DELAYS = {
    /** Delay for document change events (parsing, diagnostics) */
    DOCUMENT_CHANGE: 150,
    /** Delay for index updates after save */
    INDEX_UPDATE: 300,
    /** Delay for completion requests */
    COMPLETION: 100
} as const;
