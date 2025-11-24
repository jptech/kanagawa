import * as vscode from 'vscode';
import { SymbolCategory } from './indexer';

export interface OutlineFilterSnapshot {
    categories: Set<SymbolCategory>;
    modulePrefix?: string;
}

export interface OutlineCategoryOption {
    readonly label: string;
    readonly value: SymbolCategory;
    readonly description: string;
}

const CATEGORY_LABELS: Record<SymbolCategory, { label: string; description: string }> = {
    module: { label: 'Modules', description: 'module declarations' },
    class: { label: 'Classes', description: 'class declarations' },
    struct: { label: 'Structs', description: 'struct declarations' },
    union: { label: 'Unions', description: 'union declarations' },
    enum: { label: 'Enums', description: 'enum declarations' },
    function: { label: 'Functions', description: 'free functions' },
    method: { label: 'Methods', description: 'class/struct methods' },
    variable: { label: 'Variables', description: 'top-level variables' },
    member: { label: 'Members', description: 'class/struct fields' },
    constant: { label: 'Constants', description: 'enum members/constants' },
    alias: { label: 'Aliases', description: 'type aliases' },
    other: { label: 'Other', description: 'miscellaneous symbols' }
};

const EMPTY_SET = new Set<SymbolCategory>();

export class OutlineFilterManager implements vscode.Disposable {
    private categories: Set<SymbolCategory> = EMPTY_SET;
    private modulePrefix?: string;
    private readonly emitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.loadConfiguration();
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('kanagawa.outline')) {
                    this.loadConfiguration();
                }
            })
        );
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.emitter.dispose();
    }

    onDidChange(listener: () => void): vscode.Disposable {
        return this.emitter.event(listener);
    }

    getFilters(): OutlineFilterSnapshot {
        return {
            categories: new Set(this.categories),
            modulePrefix: this.modulePrefix
        };
    }

    getCategoryOptions(): OutlineCategoryOption[] {
        return (Object.keys(CATEGORY_LABELS) as SymbolCategory[]).map(value => {
            const meta = CATEGORY_LABELS[value];
            return {
                label: meta.label,
                value,
                description: meta.description
            };
        });
    }

    async setCategories(categories: SymbolCategory[]): Promise<void> {
        const config = vscode.workspace.getConfiguration('kanagawa.outline');
        await config.update('categoryFilter', categories, vscode.ConfigurationTarget.Workspace);
    }

    async setModulePrefix(prefix: string | undefined): Promise<void> {
        const config = vscode.workspace.getConfiguration('kanagawa.outline');
        await config.update('modulePrefix', prefix ?? '', vscode.ConfigurationTarget.Workspace);
    }

    private loadConfiguration(): void {
        const config = vscode.workspace.getConfiguration('kanagawa.outline');
        const categoryList = config.get<SymbolCategory[]>('categoryFilter', []) ?? [];
        const filtered = categoryList.filter(Boolean) as SymbolCategory[];
        this.categories = filtered.length > 0 ? new Set(filtered) : EMPTY_SET;

        const prefix = (config.get<string>('modulePrefix', '') ?? '').trim();
        this.modulePrefix = prefix.length > 0 ? prefix : undefined;

        this.emitter.fire();
    }
}

export function snapshotContainsCategory(snapshot: OutlineFilterSnapshot, category: SymbolCategory): boolean {
    return snapshot.categories.size === 0 || snapshot.categories.has(category);
}

export function snapshotMatchesPrefix(snapshot: OutlineFilterSnapshot, modulePath?: string): boolean {
    if (!snapshot.modulePrefix || snapshot.modulePrefix.length === 0) {
        return true;
    }
    if (!modulePath) {
        return false;
    }
    return modulePath.startsWith(snapshot.modulePrefix);
}
