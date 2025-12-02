/**
 * CooperativeScheduler - Yields to the event loop periodically during long-running operations.
 * 
 * This prevents Extension Host thread blocking by breaking up large operations into
 * smaller chunks that yield control back to VS Code's event loop.
 * 
 * Key features:
 * - Configurable chunk size based on workspace size
 * - Automatic time-based yielding (e.g., every 16ms for 60fps UI responsiveness)
 * - Cancellation token integration
 * - Progress callback for UI updates
 */

import * as vscode from 'vscode';

/**
 * Configuration for cooperative scheduling behavior.
 */
export interface SchedulerConfig {
    /** Base number of items to process before yielding. Adjusted by workspace size. */
    baseChunkSize: number;
    /** Maximum time (ms) before yielding, regardless of chunk size. */
    maxTimeBeforeYield: number;
    /** Multiplier for chunk size in small workspaces (< 100 files). */
    smallWorkspaceMultiplier: number;
    /** Multiplier for chunk size in medium workspaces (100-1000 files). */
    mediumWorkspaceMultiplier: number;
    /** Multiplier for chunk size in large workspaces (> 1000 files). */
    largeWorkspaceMultiplier: number;
}

/**
 * Progress callback for UI updates during long operations.
 */
export type ProgressCallback = (processed: number, total: number) => void;

/**
 * Default scheduler configuration optimized for UI responsiveness.
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
    baseChunkSize: 100,
    maxTimeBeforeYield: 16, // ~60fps
    smallWorkspaceMultiplier: 4,
    mediumWorkspaceMultiplier: 2,
    largeWorkspaceMultiplier: 1
};

/**
 * Workspace size categories for adaptive scheduling.
 */
export type WorkspaceSize = 'small' | 'medium' | 'large';

/**
 * Determines workspace size category based on file count.
 */
export function getWorkspaceSize(fileCount: number): WorkspaceSize {
    if (fileCount < 100) return 'small';
    if (fileCount < 1000) return 'medium';
    return 'large';
}

/**
 * Computes effective chunk size based on workspace size.
 */
export function computeChunkSize(
    config: SchedulerConfig,
    workspaceSize: WorkspaceSize
): number {
    switch (workspaceSize) {
        case 'small':
            return Math.floor(config.baseChunkSize * config.smallWorkspaceMultiplier);
        case 'medium':
            return Math.floor(config.baseChunkSize * config.mediumWorkspaceMultiplier);
        case 'large':
            return Math.floor(config.baseChunkSize * config.largeWorkspaceMultiplier);
    }
}

/**
 * Yields to the event loop. Uses setImmediate in Node.js or setTimeout as fallback.
 */
export function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => {
        // setImmediate is preferred as it runs after I/O but before timers
        if (typeof setImmediate === 'function') {
            setImmediate(resolve);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

/**
 * Processes an array of items cooperatively, yielding periodically.
 * 
 * @param items Items to process
 * @param processor Function to call for each item
 * @param options Processing options
 * @returns Array of results
 */
export async function processCooperatively<T, R>(
    items: T[],
    processor: (item: T, index: number) => R | Promise<R>,
    options: {
        config?: SchedulerConfig;
        workspaceSize?: WorkspaceSize;
        token?: vscode.CancellationToken;
        progress?: ProgressCallback;
    } = {}
): Promise<R[]> {
    const config = options.config ?? DEFAULT_SCHEDULER_CONFIG;
    const workspaceSize = options.workspaceSize ?? 'medium';
    const chunkSize = computeChunkSize(config, workspaceSize);
    
    const results: R[] = [];
    let lastYieldTime = Date.now();
    
    for (let i = 0; i < items.length; i++) {
        // Check cancellation
        if (options.token?.isCancellationRequested) {
            break;
        }
        
        // Process item
        const result = await processor(items[i], i);
        results.push(result);
        
        // Report progress
        options.progress?.(i + 1, items.length);
        
        // Check if we should yield
        const now = Date.now();
        const shouldYield = 
            (i + 1) % chunkSize === 0 || 
            (now - lastYieldTime) >= config.maxTimeBeforeYield;
        
        if (shouldYield && i < items.length - 1) {
            await yieldToEventLoop();
            lastYieldTime = Date.now();
        }
    }
    
    return results;
}

/**
 * Iterates over items cooperatively, yielding periodically.
 * Similar to processCooperatively but doesn't collect results.
 * 
 * @param items Items to iterate
 * @param callback Function to call for each item
 * @param options Iteration options
 */
export async function iterateCooperatively<T>(
    items: T[],
    callback: (item: T, index: number) => void | Promise<void>,
    options: {
        config?: SchedulerConfig;
        workspaceSize?: WorkspaceSize;
        token?: vscode.CancellationToken;
        progress?: ProgressCallback;
    } = {}
): Promise<void> {
    const config = options.config ?? DEFAULT_SCHEDULER_CONFIG;
    const workspaceSize = options.workspaceSize ?? 'medium';
    const chunkSize = computeChunkSize(config, workspaceSize);
    
    let lastYieldTime = Date.now();
    
    for (let i = 0; i < items.length; i++) {
        // Check cancellation
        if (options.token?.isCancellationRequested) {
            break;
        }
        
        // Process item
        await callback(items[i], i);
        
        // Report progress
        options.progress?.(i + 1, items.length);
        
        // Check if we should yield
        const now = Date.now();
        const shouldYield = 
            (i + 1) % chunkSize === 0 || 
            (now - lastYieldTime) >= config.maxTimeBeforeYield;
        
        if (shouldYield && i < items.length - 1) {
            await yieldToEventLoop();
            lastYieldTime = Date.now();
        }
    }
}

/**
 * CooperativeScheduler class for stateful scheduling across multiple operations.
 */
export class CooperativeScheduler {
    private config: SchedulerConfig;
    private workspaceSize: WorkspaceSize;
    private lastYieldTime: number = Date.now();
    private itemsSinceYield: number = 0;
    
    constructor(
        config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
        workspaceSize: WorkspaceSize = 'medium'
    ) {
        this.config = config;
        this.workspaceSize = workspaceSize;
    }
    
    /**
     * Updates the workspace size (call when file count changes significantly).
     */
    setWorkspaceSize(size: WorkspaceSize): void {
        this.workspaceSize = size;
    }
    
    /**
     * Gets the effective chunk size for the current workspace.
     */
    getChunkSize(): number {
        return computeChunkSize(this.config, this.workspaceSize);
    }
    
    /**
     * Call this after processing each item. Returns true if yield is recommended.
     */
    tick(): boolean {
        this.itemsSinceYield++;
        const now = Date.now();
        const timeSinceYield = now - this.lastYieldTime;
        
        const shouldYield = 
            this.itemsSinceYield >= this.getChunkSize() ||
            timeSinceYield >= this.config.maxTimeBeforeYield;
        
        return shouldYield;
    }
    
    /**
     * Yields to the event loop and resets counters.
     */
    async yield(): Promise<void> {
        await yieldToEventLoop();
        this.lastYieldTime = Date.now();
        this.itemsSinceYield = 0;
    }
    
    /**
     * Yields if tick() returns true. Call after each item processed.
     */
    async maybeYield(): Promise<void> {
        if (this.tick()) {
            await this.yield();
        }
    }
    
    /**
     * Resets internal counters. Call at the start of a new operation.
     */
    reset(): void {
        this.lastYieldTime = Date.now();
        this.itemsSinceYield = 0;
    }
    
    /**
     * Processes items with this scheduler instance.
     */
    async process<T, R>(
        items: T[],
        processor: (item: T, index: number) => R | Promise<R>,
        token?: vscode.CancellationToken,
        progress?: ProgressCallback
    ): Promise<R[]> {
        return processCooperatively(items, processor, {
            config: this.config,
            workspaceSize: this.workspaceSize,
            token,
            progress
        });
    }
    
    /**
     * Iterates items with this scheduler instance.
     */
    async iterate<T>(
        items: T[],
        callback: (item: T, index: number) => void | Promise<void>,
        token?: vscode.CancellationToken,
        progress?: ProgressCallback
    ): Promise<void> {
        return iterateCooperatively(items, callback, {
            config: this.config,
            workspaceSize: this.workspaceSize,
            token,
            progress
        });
    }
}

/**
 * Creates a scheduler tuned for the indexing workload.
 * Uses larger chunks since parsing is CPU-bound.
 */
export function createIndexingScheduler(fileCount: number): CooperativeScheduler {
    const config: SchedulerConfig = {
        baseChunkSize: 50, // Fewer files per chunk since parsing is heavy
        maxTimeBeforeYield: 32, // Allow slightly longer processing for efficiency
        smallWorkspaceMultiplier: 4,
        mediumWorkspaceMultiplier: 2,
        largeWorkspaceMultiplier: 1
    };
    return new CooperativeScheduler(config, getWorkspaceSize(fileCount));
}

/**
 * Creates a scheduler tuned for provider operations (hover, completion, etc.).
 * Uses smaller time budget for UI responsiveness.
 */
export function createProviderScheduler(fileCount: number): CooperativeScheduler {
    const config: SchedulerConfig = {
        baseChunkSize: 200, // More items since providers do lighter work
        maxTimeBeforeYield: 8, // Tighter time budget for responsiveness
        smallWorkspaceMultiplier: 4,
        mediumWorkspaceMultiplier: 2,
        largeWorkspaceMultiplier: 1
    };
    return new CooperativeScheduler(config, getWorkspaceSize(fileCount));
}
