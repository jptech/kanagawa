/**
 * Health monitoring service for the Kanagawa extension.
 * 
 * Tracks provider success/failure rates and can notify users when
 * the extension appears to be malfunctioning (e.g., all requests failing).
 */

import * as vscode from 'vscode';

/**
 * Tracked operation types for health monitoring.
 */
export type HealthOperation = 
    | 'parse'
    | 'semantic_tokens'
    | 'hover'
    | 'definition'
    | 'completion'
    | 'references'
    | 'inlay_hints'
    | 'documentSymbols'
    | 'workspaceSymbols'
    | 'folding'
    | 'codeLens'
    | 'callHierarchy';

/**
 * Statistics for a single operation type.
 */
interface OperationStats {
    /** Total successful operations */
    successes: number;
    /** Total failed operations */
    failures: number;
    /** Consecutive failures (reset on success) */
    consecutiveFailures: number;
    /** Timestamp of last success */
    lastSuccess: number;
    /** Timestamp of last failure */
    lastFailure: number;
    /** Last error message (for diagnostics) */
    lastError?: string;
}

/**
 * Configuration for health monitoring thresholds.
 */
interface HealthConfig {
    /** Number of consecutive failures before showing warning */
    consecutiveFailureThreshold: number;
    /** Time in ms without success before showing warning */
    noSuccessTimeoutMs: number;
    /** Minimum operations before computing failure rate */
    minOperationsForRateCheck: number;
    /** Failure rate threshold (0-1) to trigger warning */
    failureRateThreshold: number;
}

const DEFAULT_CONFIG: HealthConfig = {
    consecutiveFailureThreshold: 10,
    noSuccessTimeoutMs: 60000, // 1 minute
    minOperationsForRateCheck: 20,
    failureRateThreshold: 0.8 // 80% failures
};

/**
 * Health monitoring service for the extension.
 * 
 * Usage:
 * ```
 * healthMonitor.recordSuccess('hover');
 * healthMonitor.recordFailure('hover', 'Parse tree unavailable');
 * ```
 */
export class HealthMonitor implements vscode.Disposable {
    private stats: Map<HealthOperation, OperationStats> = new Map();
    private config: HealthConfig = DEFAULT_CONFIG;
    private warningShown = false;
    private checkInterval: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor() {
        // Initialize stats for all operations
        const operations: HealthOperation[] = [
            'parse', 'semantic_tokens', 'hover', 'definition', 
            'completion', 'references', 'inlay_hints',
            'documentSymbols', 'workspaceSymbols', 'folding', 
            'codeLens', 'callHierarchy'
        ];
        
        for (const op of operations) {
            this.stats.set(op, {
                successes: 0,
                failures: 0,
                consecutiveFailures: 0,
                lastSuccess: Date.now(),
                lastFailure: 0
            });
        }
    }

    /**
     * Starts periodic health checks.
     */
    start(): void {
        // Check health every 30 seconds
        this.checkInterval = setInterval(() => {
            this.checkHealth();
        }, 30000);
    }

    /**
     * Records a successful operation.
     */
    recordSuccess(operation: HealthOperation): void {
        const stats = this.stats.get(operation);
        if (!stats) return;

        stats.successes++;
        stats.consecutiveFailures = 0;
        stats.lastSuccess = Date.now();

        // Reset warning state if we're recovering
        if (this.warningShown) {
            this.checkRecovery();
        }
    }

    /**
     * Records a failed operation.
     */
    recordFailure(operation: HealthOperation, error?: unknown): void {
        const stats = this.stats.get(operation);
        if (!stats) return;

        stats.failures++;
        stats.consecutiveFailures++;
        stats.lastFailure = Date.now();
        
        // Convert error to string for logging
        if (error !== undefined) {
            if (error instanceof Error) {
                stats.lastError = error.message;
            } else if (typeof error === 'string') {
                stats.lastError = error;
            } else {
                stats.lastError = String(error);
            }
        }

        // Immediate check for severe failures
        if (stats.consecutiveFailures >= this.config.consecutiveFailureThreshold) {
            this.showHealthWarning(operation, stats);
        }
    }

    /**
     * Checks overall extension health.
     */
    private checkHealth(): void {
        if (this.disposed) return;

        const now = Date.now();
        const unhealthyOps: string[] = [];

        for (const [op, stats] of this.stats) {
            // Skip operations with no activity
            if (stats.successes === 0 && stats.failures === 0) {
                continue;
            }

            // Check consecutive failures
            if (stats.consecutiveFailures >= this.config.consecutiveFailureThreshold) {
                unhealthyOps.push(`${op} (${stats.consecutiveFailures} consecutive failures)`);
                continue;
            }

            // Check failure rate
            const total = stats.successes + stats.failures;
            if (total >= this.config.minOperationsForRateCheck) {
                const failureRate = stats.failures / total;
                if (failureRate >= this.config.failureRateThreshold) {
                    unhealthyOps.push(`${op} (${Math.round(failureRate * 100)}% failure rate)`);
                    continue;
                }
            }

            // Check for no recent successes (but there have been failures)
            if (stats.failures > 0 && 
                (now - stats.lastSuccess) > this.config.noSuccessTimeoutMs &&
                stats.lastFailure > stats.lastSuccess) {
                unhealthyOps.push(`${op} (no success in ${Math.round((now - stats.lastSuccess) / 1000)}s)`);
            }
        }

        if (unhealthyOps.length > 0 && !this.warningShown) {
            this.showOverallWarning(unhealthyOps);
        }
    }

    /**
     * Checks if the extension has recovered and clears the warning state.
     */
    private checkRecovery(): void {
        let allHealthy = true;

        for (const stats of this.stats.values()) {
            if (stats.consecutiveFailures >= this.config.consecutiveFailureThreshold / 2) {
                allHealthy = false;
                break;
            }
        }

        if (allHealthy) {
            this.warningShown = false;
            console.log('Kanagawa: Extension health recovered');
        }
    }

    /**
     * Shows a warning for a specific operation's failures.
     */
    private showHealthWarning(operation: HealthOperation, stats: OperationStats): void {
        if (this.warningShown || this.disposed) return;
        this.warningShown = true;

        const errorInfo = stats.lastError ? `: ${stats.lastError}` : '';
        console.error(`Kanagawa: Health warning - ${operation} has failed ${stats.consecutiveFailures} times${errorInfo}`);

        vscode.window.showWarningMessage(
            `Kanagawa: ${operation} feature is experiencing issues. Some functionality may not work.`,
            'Restart Extension',
            'Show Diagnostics',
            'Dismiss'
        ).then(choice => {
            if (choice === 'Restart Extension') {
                vscode.commands.executeCommand('kanagawa.restart');
            } else if (choice === 'Show Diagnostics') {
                vscode.commands.executeCommand('kanagawa.diagnostics');
            }
        });
    }

    /**
     * Shows a warning about overall extension health.
     */
    private showOverallWarning(unhealthyOps: string[]): void {
        if (this.warningShown || this.disposed) return;
        this.warningShown = true;

        console.error('Kanagawa: Health warning - multiple features unhealthy:', unhealthyOps);

        vscode.window.showWarningMessage(
            `Kanagawa: Extension features may not be working properly. Consider restarting.`,
            'Restart Extension',
            'Show Diagnostics',
            'Dismiss'
        ).then(choice => {
            if (choice === 'Restart Extension') {
                vscode.commands.executeCommand('kanagawa.restart');
            } else if (choice === 'Show Diagnostics') {
                vscode.commands.executeCommand('kanagawa.diagnostics');
            }
        });
    }

    /**
     * Gets current health statistics for diagnostics.
     */
    getStats(): Map<HealthOperation, Readonly<OperationStats>> {
        return new Map(this.stats);
    }

    /**
     * Resets all statistics. Called when extension is restarted.
     */
    reset(): void {
        for (const stats of this.stats.values()) {
            stats.successes = 0;
            stats.failures = 0;
            stats.consecutiveFailures = 0;
            stats.lastSuccess = Date.now();
            stats.lastFailure = 0;
            stats.lastError = undefined;
        }
        this.warningShown = false;
    }

    /**
     * Disposes the health monitor.
     */
    dispose(): void {
        this.disposed = true;
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = undefined;
        }
    }
}

/**
 * Global health monitor instance.
 */
export const healthMonitor = new HealthMonitor();
