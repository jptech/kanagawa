/**
 * Mock VS Code API for unit testing outside of VS Code environment
 */

export class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;

    private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
        this.fsPath = path;
    }

    static file(path: string): Uri {
        return new Uri('file', '', path, '', '');
    }

    static parse(value: string): Uri {
        // Simple parsing for tests
        if (value.startsWith('file://')) {
            return new Uri('file', '', value.slice(7), '', '');
        }
        return new Uri('file', '', value, '', '');
    }

    toString(): string {
        return `${this.scheme}://${this.path}`;
    }

    static joinPath(base: Uri, ...pathSegments: string[]): Uri {
        const joined = [base.path, ...pathSegments].join('/');
        return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
    }
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(
        public readonly start: Position,
        public readonly end: Position
    ) {}

    static fromPositions(start: Position, end: Position): Range {
        return new Range(start, end);
    }
}

export class Location {
    constructor(public readonly uri: Uri, public readonly range: Range) {}
}

export enum SymbolKind {
    File = 0,
    Module = 1,
    Namespace = 2,
    Package = 3,
    Class = 4,
    Method = 5,
    Property = 6,
    Field = 7,
    Constructor = 8,
    Enum = 9,
    Interface = 10,
    Function = 11,
    Variable = 12,
    Constant = 13,
    String = 14,
    Number = 15,
    Boolean = 16,
    Array = 17,
    Object = 18,
    Key = 19,
    Null = 20,
    EnumMember = 21,
    Struct = 22,
    Event = 23,
    Operator = 24,
    TypeParameter = 25,
}

export class MarkdownString {
    value: string = '';
    
    constructor(value?: string) {
        this.value = value ?? '';
    }

    appendCodeblock(code: string, language?: string): this {
        this.value += `\n\`\`\`${language ?? ''}\n${code}\n\`\`\`\n`;
        return this;
    }

    appendMarkdown(markdown: string): this {
        this.value += markdown;
        return this;
    }

    appendText(text: string): this {
        this.value += text;
        return this;
    }
}

export class Hover {
    constructor(
        public readonly contents: MarkdownString | MarkdownString[],
        public readonly range?: Range
    ) {}
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export class Diagnostic {
    constructor(
        public readonly range: Range,
        public readonly message: string,
        public readonly severity?: DiagnosticSeverity
    ) {}
}

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
}

// Mock workspace namespace
export const workspace = {
    workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
    
    findFiles: async (_include: string, _exclude?: string): Promise<Uri[]> => {
        return [];
    },
    
    openTextDocument: async (uri: Uri): Promise<MockTextDocument> => {
        return new MockTextDocument(uri, '');
    },
    
    fs: {
        readFile: async (_uri: Uri): Promise<Uint8Array> => {
            return new Uint8Array();
        },
        readDirectory: async (_uri: Uri): Promise<[string, FileType][]> => {
            return [];
        },
    },
    
    asRelativePath: (uri: Uri): string => {
        return uri.path;
    },
    
    getConfiguration: (_section?: string) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
    
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
};

// Mock window namespace
export const window = {
    activeTextEditor: undefined,
    
    showInformationMessage: async (_message: string): Promise<undefined> => undefined,
    showWarningMessage: async (_message: string): Promise<undefined> => undefined,
    showErrorMessage: async (_message: string): Promise<undefined> => undefined,
    
    createOutputChannel: (_name: string) => ({
        append: () => {},
        appendLine: () => {},
        clear: () => {},
        show: () => {},
        dispose: () => {},
    }),
    
    withProgress: async <T>(_options: unknown, task: () => Promise<T>): Promise<T> => {
        return task();
    },
    
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
};

// Mock languages namespace
export const languages = {
    createDiagnosticCollection: (_name: string) => ({
        set: () => {},
        delete: () => {},
        clear: () => {},
        dispose: () => {},
    }),
    
    registerHoverProvider: () => ({ dispose: () => {} }),
    registerDefinitionProvider: () => ({ dispose: () => {} }),
    registerCompletionItemProvider: () => ({ dispose: () => {} }),
    registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
    registerWorkspaceSymbolProvider: () => ({ dispose: () => {} }),
    registerFoldingRangeProvider: () => ({ dispose: () => {} }),
    registerSignatureHelpProvider: () => ({ dispose: () => {} }),
    registerReferenceProvider: () => ({ dispose: () => {} }),
    registerCallHierarchyProvider: () => ({ dispose: () => {} }),
    registerCodeLensProvider: () => ({ dispose: () => {} }),
    registerDocumentSemanticTokensProvider: () => ({ dispose: () => {} }),
};

export const commands = {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => undefined,
};

export enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15,
}

/**
 * Mock TextDocument for testing
 */
export class MockTextDocument {
    readonly uri: Uri;
    readonly languageId: string = 'kanagawa';
    readonly version: number = 1;
    readonly lineCount: number;
    private lines: string[];

    constructor(uri: Uri, content: string) {
        this.uri = uri;
        this.lines = content.split('\n');
        this.lineCount = this.lines.length;
    }

    getText(range?: Range): string {
        if (!range) {
            return this.lines.join('\n');
        }
        
        if (range.start.line === range.end.line) {
            return this.lines[range.start.line]?.slice(range.start.character, range.end.character) ?? '';
        }
        
        const result: string[] = [];
        for (let i = range.start.line; i <= range.end.line; i++) {
            if (i === range.start.line) {
                result.push(this.lines[i]?.slice(range.start.character) ?? '');
            } else if (i === range.end.line) {
                result.push(this.lines[i]?.slice(0, range.end.character) ?? '');
            } else {
                result.push(this.lines[i] ?? '');
            }
        }
        return result.join('\n');
    }

    lineAt(line: number): { text: string; range: Range } {
        const text = this.lines[line] ?? '';
        return {
            text,
            range: new Range(
                new Position(line, 0),
                new Position(line, text.length)
            ),
        };
    }

    offsetAt(position: Position): number {
        let offset = 0;
        for (let i = 0; i < position.line; i++) {
            offset += (this.lines[i]?.length ?? 0) + 1; // +1 for newline
        }
        offset += position.character;
        return offset;
    }

    positionAt(offset: number): Position {
        let remaining = offset;
        for (let i = 0; i < this.lines.length; i++) {
            const lineLength = (this.lines[i]?.length ?? 0) + 1;
            if (remaining < lineLength) {
                return new Position(i, remaining);
            }
            remaining -= lineLength;
        }
        return new Position(this.lines.length - 1, this.lines[this.lines.length - 1]?.length ?? 0);
    }
}

/**
 * Create a mock text document from source code
 */
export function createMockDocument(content: string, filename: string = 'test.k'): MockTextDocument {
    return new MockTextDocument(Uri.file(filename), content);
}
