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
     * @param key Unique identifier for this debounced action
     * @param callback The function to execute after the delay
     * @param delay Optional custom delay (defaults to constructor value)
     */
    debounce(key: K, callback: () => void, delay?: number): void {
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
                try {
                    callback();
                } catch (e) {
                    console.error(`Kanagawa: Debounced callback error for key ${key}:`, e);
                }
            }
        }, effectiveDelay);

        this.timers.set(key, timer);
    }

    /**
     * Cancels any pending callback for the given key.
     */
    cancel(key: K): void {
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
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
     */
    dispose(): void {
        this.disposed = true;
        this.cancelAll();
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
