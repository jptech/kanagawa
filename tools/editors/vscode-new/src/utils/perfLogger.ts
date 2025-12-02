import * as vscode from 'vscode';

/**
 * Performance logging levels
 */
export enum PerfLogLevel {
    Off = 0,
    Summary = 1,  // Only slow operations (>threshold)
    Verbose = 2   // All operations
}

/**
 * Configuration for performance logging
 */
interface PerfLogConfig {
    level: PerfLogLevel;
    slowThresholdMs: number;
    outputChannel: vscode.OutputChannel | undefined;
}

/**
 * Aggregated stats for an operation type
 */
interface OperationStats {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    slowCount: number;  // Count of operations exceeding threshold
}

/**
 * Performance logger for tracking expensive operations.
 * 
 * Usage:
 * ```typescript
 * // Simple timing
 * const end = perfLogger.start('parse', document.uri.toString());
 * // ... do work ...
 * end();  // Logs elapsed time
 * 
 * // Or with async operations
 * const result = await perfLogger.measure('parse', uri, async () => {
 *     return await expensiveOperation();
 * });
 * ```
 */
class PerfLogger implements vscode.Disposable {
    private config: PerfLogConfig = {
        level: PerfLogLevel.Off,
        slowThresholdMs: 100,
        outputChannel: undefined
    };

    private stats: Map<string, OperationStats> = new Map();
    private sessionStartTime: number = Date.now();

    /**
     * Initializes the performance logger with an output channel.
     */
    init(context: vscode.ExtensionContext): void {
        this.config.outputChannel = vscode.window.createOutputChannel('Kanagawa Performance');
        context.subscriptions.push(this.config.outputChannel);
        this.sessionStartTime = Date.now();
    }

    /**
     * Sets the logging level.
     */
    setLevel(level: PerfLogLevel): void {
        this.config.level = level;
        if (level !== PerfLogLevel.Off && this.config.outputChannel) {
            this.config.outputChannel.appendLine(`[Perf] Logging enabled at level: ${PerfLogLevel[level]}`);
            this.config.outputChannel.appendLine(`[Perf] Slow threshold: ${this.config.slowThresholdMs}ms`);
        }
    }

    /**
     * Gets the current logging level.
     */
    getLevel(): PerfLogLevel {
        return this.config.level;
    }

    /**
     * Sets the threshold for "slow" operations (default: 100ms).
     */
    setSlowThreshold(ms: number): void {
        this.config.slowThresholdMs = ms;
    }

    /**
     * Starts timing an operation. Returns a function to call when done.
     * 
     * @param operation The operation type (e.g., 'parse', 'index', 'hover')
     * @param context Additional context (e.g., file URI)
     * @returns A function to call when the operation completes
     */
    start(operation: string, context?: string): () => void {
        if (this.config.level === PerfLogLevel.Off) {
            return () => {}; // No-op
        }

        const startTime = performance.now();

        return () => {
            const elapsed = performance.now() - startTime;
            this.record(operation, elapsed, context);
        };
    }

    /**
     * Measures an async operation.
     * 
     * @param operation The operation type
     * @param context Additional context
     * @param fn The async function to measure
     * @returns The result of the function
     */
    async measure<T>(operation: string, context: string | undefined, fn: () => Promise<T>): Promise<T> {
        if (this.config.level === PerfLogLevel.Off) {
            return fn();
        }

        const startTime = performance.now();
        try {
            return await fn();
        } finally {
            const elapsed = performance.now() - startTime;
            this.record(operation, elapsed, context);
        }
    }

    /**
     * Measures a sync operation.
     */
    measureSync<T>(operation: string, context: string | undefined, fn: () => T): T {
        if (this.config.level === PerfLogLevel.Off) {
            return fn();
        }

        const startTime = performance.now();
        try {
            return fn();
        } finally {
            const elapsed = performance.now() - startTime;
            this.record(operation, elapsed, context);
        }
    }

    /**
     * Records an operation's timing.
     */
    private record(operation: string, elapsedMs: number, context?: string): void {
        // Update aggregated stats
        const stats = this.stats.get(operation) ?? {
            count: 0,
            totalMs: 0,
            minMs: Infinity,
            maxMs: 0,
            slowCount: 0
        };

        stats.count++;
        stats.totalMs += elapsedMs;
        stats.minMs = Math.min(stats.minMs, elapsedMs);
        stats.maxMs = Math.max(stats.maxMs, elapsedMs);
        
        const isSlow = elapsedMs > this.config.slowThresholdMs;
        if (isSlow) {
            stats.slowCount++;
        }

        this.stats.set(operation, stats);

        // Log if appropriate
        if (this.config.level === PerfLogLevel.Verbose || 
            (this.config.level === PerfLogLevel.Summary && isSlow)) {
            this.log(operation, elapsedMs, context, isSlow);
        }
    }

    /**
     * Logs a single operation.
     */
    private log(operation: string, elapsedMs: number, context?: string, isSlow?: boolean): void {
        if (!this.config.outputChannel) { return; }

        const slowMarker = isSlow ? ' [SLOW]' : '';
        const contextStr = context ? ` (${this.truncateContext(context)})` : '';
        const timeStr = elapsedMs.toFixed(2);

        this.config.outputChannel.appendLine(
            `[${this.timestamp()}] ${operation}${contextStr}: ${timeStr}ms${slowMarker}`
        );
    }

    /**
     * Truncates long context strings (like URIs) for readability.
     */
    private truncateContext(context: string): string {
        // Extract just the filename from URIs
        const match = context.match(/([^/\\]+)$/);
        if (match) {
            return match[1];
        }
        if (context.length > 50) {
            return '...' + context.slice(-47);
        }
        return context;
    }

    /**
     * Returns a timestamp string for log entries.
     */
    private timestamp(): string {
        const now = new Date();
        return now.toISOString().slice(11, 23); // HH:mm:ss.SSS
    }

    /**
     * Gets aggregated statistics for all operations.
     */
    getStats(): Map<string, OperationStats> {
        return new Map(this.stats);
    }

    /**
     * Prints a summary of all recorded operations to the output channel.
     */
    printSummary(): void {
        if (!this.config.outputChannel) { return; }

        const output = this.config.outputChannel;
        const sessionDuration = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);

        output.appendLine('');
        output.appendLine('═══════════════════════════════════════════════════════════');
        output.appendLine(`  Kanagawa Performance Summary (session: ${sessionDuration}s)`);
        output.appendLine('═══════════════════════════════════════════════════════════');

        if (this.stats.size === 0) {
            output.appendLine('  No operations recorded.');
            output.appendLine('  Enable verbose logging with: Kanagawa: Toggle Performance Logging');
            output.appendLine('═══════════════════════════════════════════════════════════');
            return;
        }

        // Sort by total time descending
        const sorted = [...this.stats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);

        output.appendLine('');
        output.appendLine(`  ${'Operation'.padEnd(25)} ${'Count'.padStart(8)} ${'Total'.padStart(10)} ${'Avg'.padStart(10)} ${'Max'.padStart(10)} ${'Slow'.padStart(6)}`);
        output.appendLine('  ' + '─'.repeat(73));

        for (const [operation, stats] of sorted) {
            const avg = stats.count > 0 ? stats.totalMs / stats.count : 0;
            output.appendLine(
                `  ${operation.padEnd(25)} ` +
                `${stats.count.toString().padStart(8)} ` +
                `${stats.totalMs.toFixed(1).padStart(9)}ms ` +
                `${avg.toFixed(1).padStart(9)}ms ` +
                `${stats.maxMs.toFixed(1).padStart(9)}ms ` +
                `${stats.slowCount.toString().padStart(6)}`
            );
        }

        output.appendLine('');
        output.appendLine(`  Slow threshold: >${this.config.slowThresholdMs}ms`);
        output.appendLine('═══════════════════════════════════════════════════════════');
        output.show(true);
    }

    /**
     * Clears all recorded statistics.
     */
    clearStats(): void {
        this.stats.clear();
        this.sessionStartTime = Date.now();
        if (this.config.outputChannel) {
            this.config.outputChannel.appendLine('[Perf] Statistics cleared.');
        }
    }

    dispose(): void {
        // Output channel is disposed via context.subscriptions
    }
}

/**
 * Singleton instance of the performance logger.
 */
export const perfLogger = new PerfLogger();

/**
 * Common operation names for consistency.
 */
export const PerfOps = {
    // Parsing
    PARSE: 'parse',
    PARSE_INCREMENTAL: 'parse.incremental',
    PARSE_FULL: 'parse.full',
    
    // Indexing
    INDEX_SCAN: 'index.scan',
    INDEX_PRELOAD: 'index.preload',
    INDEX_FILE: 'index.file',
    INDEX_RESOLVE: 'index.resolve',
    
    // Providers
    HOVER: 'provider.hover',
    DEFINITION: 'provider.definition',
    REFERENCES: 'provider.references',
    COMPLETION: 'provider.completion',
    SEMANTIC_TOKENS: 'provider.semanticTokens',
    DOCUMENT_SYMBOLS: 'provider.documentSymbols',
    FOLDING: 'provider.folding',
    SIGNATURE_HELP: 'provider.signatureHelp',
    DIAGNOSTICS: 'provider.diagnostics',
    
    // Queries
    QUERY_EXECUTE: 'query.execute',
    QUERY_LOAD: 'query.load',
    
    // Type inference
    INFER_TYPE: 'type.infer',
    RESOLVE_MEMBER: 'type.resolveMember',
} as const;
