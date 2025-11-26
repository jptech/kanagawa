import * as vscode from 'vscode';

export type IndexingState = 'idle' | 'indexing' | 'error';

export interface IndexStats {
    symbolCount: number;
    fileCount: number;
    state: IndexingState;
    errorMessage?: string;
}

/**
 * Manages a status bar item showing the current state of the Kanagawa index.
 */
export class IndexStatusBar implements vscode.Disposable {
    private readonly statusBarItem: vscode.StatusBarItem;
    private currentStats: IndexStats = {
        symbolCount: 0,
        fileCount: 0,
        state: 'idle'
    };
    private animationInterval: ReturnType<typeof setInterval> | undefined;
    private animationFrame = 0;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            50 // Priority - lower numbers are further right
        );
        this.statusBarItem.name = 'Kanagawa Index Status';
        this.statusBarItem.command = 'kanagawa.index.showStats';
        this.update(this.currentStats);
        this.statusBarItem.show();
    }

    /**
     * Updates the status bar with new index statistics.
     */
    update(stats: IndexStats): void {
        this.currentStats = stats;
        this.render();
    }

    /**
     * Sets the indexing state and optionally an error message.
     */
    setState(state: IndexingState, errorMessage?: string): void {
        this.currentStats.state = state;
        this.currentStats.errorMessage = errorMessage;
        
        if (state === 'indexing') {
            this.startAnimation();
        } else {
            this.stopAnimation();
        }
        
        this.render();
    }

    /**
     * Updates symbol and file counts.
     */
    setCounts(symbolCount: number, fileCount: number): void {
        this.currentStats.symbolCount = symbolCount;
        this.currentStats.fileCount = fileCount;
        this.render();
    }

    private render(): void {
        const { symbolCount, fileCount, state, errorMessage } = this.currentStats;

        switch (state) {
            case 'indexing': {
                const spinnerFrames = ['$(sync~spin)', '$(sync~spin)', '$(sync~spin)', '$(sync~spin)'];
                const frame = spinnerFrames[this.animationFrame % spinnerFrames.length];
                this.statusBarItem.text = `${frame} Kanagawa: Indexing...`;
                this.statusBarItem.tooltip = 'Indexing Kanagawa workspace files...';
                this.statusBarItem.backgroundColor = undefined;
                break;
            }
            case 'error': {
                this.statusBarItem.text = `$(error) Kanagawa: Error`;
                this.statusBarItem.tooltip = errorMessage ?? 'An error occurred during indexing';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            }
            case 'idle':
            default: {
                const symbolText = symbolCount === 1 ? 'symbol' : 'symbols';
                const fileText = fileCount === 1 ? 'file' : 'files';
                this.statusBarItem.text = `$(database) Kanagawa: ${symbolCount} ${symbolText}`;
                this.statusBarItem.tooltip = `Kanagawa Index: ${symbolCount} symbols from ${fileCount} ${fileText}\nClick to show details`;
                this.statusBarItem.backgroundColor = undefined;
                break;
            }
        }
    }

    private startAnimation(): void {
        if (this.animationInterval) { return; }
        this.animationFrame = 0;
        this.animationInterval = setInterval(() => {
            this.animationFrame++;
            this.render();
        }, 200);
    }

    private stopAnimation(): void {
        if (this.animationInterval) {
            clearInterval(this.animationInterval);
            this.animationInterval = undefined;
        }
    }

    dispose(): void {
        this.stopAnimation();
        this.statusBarItem.dispose();
    }
}
