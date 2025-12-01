/**
 * Mock implementations of VS Code API for unit testing.
 * These mocks provide minimal implementations sufficient for testing
 * Kanagawa extension services without a full VS Code environment.
 */

// ============================================================================
// Core Types
// ============================================================================

export class Position {
    constructor(
        public readonly line: number,
        public readonly character: number
    ) {}

    isEqual(other: Position): boolean {
        return this.line === other.line && this.character === other.character;
    }

    isBefore(other: Position): boolean {
        if (this.line < other.line) { return true; }
        if (this.line > other.line) { return false; }
        return this.character < other.character;
    }

    isAfter(other: Position): boolean {
        return other.isBefore(this);
    }

    translate(lineDelta?: number, characterDelta?: number): Position {
        return new Position(
            this.line + (lineDelta ?? 0),
            this.character + (characterDelta ?? 0)
        );
    }

    with(line?: number, character?: number): Position {
        return new Position(line ?? this.line, character ?? this.character);
    }

    compareTo(other: Position): number {
        if (this.line < other.line) { return -1; }
        if (this.line > other.line) { return 1; }
        if (this.character < other.character) { return -1; }
        if (this.character > other.character) { return 1; }
        return 0;
    }
}

export class Range {
    public readonly start: Position;
    public readonly end: Position;

    constructor(start: Position, end: Position);
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    constructor(
        startOrStartLine: Position | number,
        endOrStartCharacter: Position | number,
        endLine?: number,
        endCharacter?: number
    ) {
        if (typeof startOrStartLine === 'number') {
            this.start = new Position(startOrStartLine, endOrStartCharacter as number);
            this.end = new Position(endLine!, endCharacter!);
        } else {
            this.start = startOrStartLine;
            this.end = endOrStartCharacter as Position;
        }
    }

    get isEmpty(): boolean {
        return this.start.isEqual(this.end);
    }

    get isSingleLine(): boolean {
        return this.start.line === this.end.line;
    }

    contains(positionOrRange: Position | Range): boolean {
        if (positionOrRange instanceof Position) {
            return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
        }
        return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }

    isEqual(other: Range): boolean {
        return this.start.isEqual(other.start) && this.end.isEqual(other.end);
    }

    intersection(range: Range): Range | undefined {
        const start = this.start.isBefore(range.start) ? range.start : this.start;
        const end = this.end.isAfter(range.end) ? range.end : this.end;
        if (start.isAfter(end)) { return undefined; }
        return new Range(start, end);
    }

    union(other: Range): Range {
        const start = this.start.isBefore(other.start) ? this.start : other.start;
        const end = this.end.isAfter(other.end) ? this.end : other.end;
        return new Range(start, end);
    }

    with(start?: Position, end?: Position): Range {
        return new Range(start ?? this.start, end ?? this.end);
    }
}

export class Uri {
    private constructor(
        public readonly scheme: string,
        public readonly authority: string,
        public readonly path: string,
        public readonly query: string,
        public readonly fragment: string
    ) {}

    static file(path: string): Uri {
        // Normalize path separators for consistency
        const normalized = path.replace(/\\/g, '/');
        return new Uri('file', '', normalized, '', '');
    }

    static parse(value: string): Uri {
        // Simple URI parsing
        const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (schemeMatch) {
            const scheme = schemeMatch[1];
            const rest = value.slice(schemeMatch[0].length);
            const pathStart = rest.indexOf('/');
            const authority = pathStart >= 0 ? rest.slice(0, pathStart) : rest;
            const pathAndRest = pathStart >= 0 ? rest.slice(pathStart) : '';
            
            const queryStart = pathAndRest.indexOf('?');
            const fragmentStart = pathAndRest.indexOf('#');
            
            let path = pathAndRest;
            let query = '';
            let fragment = '';
            
            if (fragmentStart >= 0) {
                fragment = pathAndRest.slice(fragmentStart + 1);
                path = pathAndRest.slice(0, fragmentStart);
            }
            if (queryStart >= 0 && queryStart < (fragmentStart >= 0 ? fragmentStart : pathAndRest.length)) {
                query = path.slice(queryStart + 1);
                path = pathAndRest.slice(0, queryStart);
            }
            
            return new Uri(scheme, authority, path, query, fragment);
        }
        
        // Assume file path
        return Uri.file(value);
    }

    static joinPath(base: Uri, ...pathSegments: string[]): Uri {
        const joined = [base.path, ...pathSegments].join('/').replace(/\/+/g, '/');
        return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
    }

    get fsPath(): string {
        // Convert to OS-appropriate path
        if (process.platform === 'win32' && this.path.match(/^\/[a-zA-Z]:/)) {
            return this.path.slice(1).replace(/\//g, '\\');
        }
        return this.path;
    }

    toString(): string {
        let result = `${this.scheme}://${this.authority}${this.path}`;
        if (this.query) { result += `?${this.query}`; }
        if (this.fragment) { result += `#${this.fragment}`; }
        return result;
    }

    toJSON(): any {
        return {
            scheme: this.scheme,
            authority: this.authority,
            path: this.path,
            query: this.query,
            fragment: this.fragment,
            fsPath: this.fsPath
        };
    }

    with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
        return new Uri(
            change.scheme ?? this.scheme,
            change.authority ?? this.authority,
            change.path ?? this.path,
            change.query ?? this.query,
            change.fragment ?? this.fragment
        );
    }
}

export class Location {
    constructor(
        public readonly uri: Uri,
        public readonly range: Range
    ) {}
}

// ============================================================================
// Symbol Kinds
// ============================================================================

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
    TypeParameter = 25
}

// ============================================================================
// File System Types
// ============================================================================

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64
}

// ============================================================================
// Text Document
// ============================================================================

export class MockTextDocument {
    private lines: string[];
    
    constructor(
        public readonly uri: Uri,
        private content: string,
        public readonly languageId: string = 'kanagawa',
        public readonly version: number = 1
    ) {
        this.lines = content.split(/\r?\n/);
    }

    get fileName(): string {
        return this.uri.fsPath;
    }

    get lineCount(): number {
        return this.lines.length;
    }

    getText(range?: Range): string {
        if (!range) { return this.content; }
        
        const startOffset = this.offsetAt(range.start);
        const endOffset = this.offsetAt(range.end);
        return this.content.slice(startOffset, endOffset);
    }

    lineAt(lineOrPosition: number | Position): { text: string; lineNumber: number; range: Range; rangeIncludingLineBreak: Range; firstNonWhitespaceCharacterIndex: number; isEmptyOrWhitespace: boolean } {
        const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
        const text = this.lines[lineNumber] ?? '';
        const firstNonWs = text.search(/\S/);
        
        return {
            text,
            lineNumber,
            range: new Range(lineNumber, 0, lineNumber, text.length),
            rangeIncludingLineBreak: new Range(lineNumber, 0, lineNumber + 1, 0),
            firstNonWhitespaceCharacterIndex: firstNonWs >= 0 ? firstNonWs : text.length,
            isEmptyOrWhitespace: text.trim().length === 0
        };
    }

    offsetAt(position: Position): number {
        let offset = 0;
        for (let i = 0; i < position.line && i < this.lines.length; i++) {
            offset += this.lines[i].length + 1; // +1 for newline
        }
        offset += Math.min(position.character, (this.lines[position.line] ?? '').length);
        return offset;
    }

    positionAt(offset: number): Position {
        let remaining = offset;
        for (let line = 0; line < this.lines.length; line++) {
            const lineLength = this.lines[line].length + 1; // +1 for newline
            if (remaining < lineLength) {
                return new Position(line, remaining);
            }
            remaining -= lineLength;
        }
        const lastLine = this.lines.length - 1;
        return new Position(lastLine, (this.lines[lastLine] ?? '').length);
    }

    getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
        const line = this.lines[position.line] ?? '';
        const pattern = regex ?? /\w+/g;
        let match: RegExpExecArray | null;
        
        // Reset regex
        pattern.lastIndex = 0;
        
        while ((match = pattern.exec(line)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (position.character >= start && position.character <= end) {
                return new Range(position.line, start, position.line, end);
            }
            if (start > position.character) { break; }
        }
        return undefined;
    }

    validateRange(range: Range): Range {
        const start = this.validatePosition(range.start);
        const end = this.validatePosition(range.end);
        return new Range(start, end);
    }

    validatePosition(position: Position): Position {
        const line = Math.max(0, Math.min(position.line, this.lineCount - 1));
        const maxChar = (this.lines[line] ?? '').length;
        const character = Math.max(0, Math.min(position.character, maxChar));
        return new Position(line, character);
    }

    // For testing: update content
    _setContent(content: string): void {
        this.content = content;
        this.lines = content.split(/\r?\n/);
    }
}

// ============================================================================
// Workspace Edit
// ============================================================================

export class WorkspaceEdit {
    private edits: Map<string, Array<{ range: Range; newText: string }>> = new Map();

    replace(uri: Uri, range: Range, newText: string): void {
        const key = uri.toString();
        const fileEdits = this.edits.get(key) ?? [];
        fileEdits.push({ range, newText });
        this.edits.set(key, fileEdits);
    }

    insert(uri: Uri, position: Position, newText: string): void {
        this.replace(uri, new Range(position, position), newText);
    }

    delete(uri: Uri, range: Range): void {
        this.replace(uri, range, '');
    }

    has(uri: Uri): boolean {
        return this.edits.has(uri.toString());
    }

    get size(): number {
        let count = 0;
        for (const edits of this.edits.values()) {
            count += edits.length;
        }
        return count;
    }

    entries(): [Uri, Array<{ range: Range; newText: string }>][] {
        return Array.from(this.edits.entries()).map(([key, edits]) => [
            Uri.parse(key),
            edits
        ]);
    }

    // For testing: get all edits for a URI
    get(uri: Uri): Array<{ range: Range; newText: string }> {
        return this.edits.get(uri.toString()) ?? [];
    }
}

// ============================================================================
// Cancellation Token
// ============================================================================

export class CancellationTokenSource {
    private _token: CancellationToken;
    private _isCancelled = false;
    private _listeners: (() => void)[] = [];

    constructor() {
        this._token = {
            isCancellationRequested: false,
            onCancellationRequested: (listener: () => void) => {
                this._listeners.push(listener);
                return { dispose: () => {
                    const index = this._listeners.indexOf(listener);
                    if (index >= 0) { this._listeners.splice(index, 1); }
                }};
            }
        };
    }

    get token(): CancellationToken {
        return this._token;
    }

    cancel(): void {
        if (this._isCancelled) { return; }
        this._isCancelled = true;
        (this._token as any).isCancellationRequested = true;
        for (const listener of this._listeners) {
            listener();
        }
    }

    dispose(): void {
        this._listeners = [];
    }
}

export interface CancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

// ============================================================================
// Events
// ============================================================================

export type Event<T> = (listener: (e: T) => void) => { dispose: () => void };

export class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];

    get event(): Event<T> {
        return (listener) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    const index = this.listeners.indexOf(listener);
                    if (index >= 0) { this.listeners.splice(index, 1); }
                }
            };
        };
    }

    fire(data: T): void {
        for (const listener of this.listeners) {
            listener(data);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

// ============================================================================
// Workspace Folder
// ============================================================================

export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
}

// ============================================================================
// Mock Workspace
// ============================================================================

export class MockWorkspace {
    private documents: Map<string, MockTextDocument> = new Map();
    private _workspaceFolders: WorkspaceFolder[] = [];

    private _onDidOpenTextDocument = new EventEmitter<MockTextDocument>();
    private _onDidCloseTextDocument = new EventEmitter<MockTextDocument>();
    private _onDidChangeTextDocument = new EventEmitter<{ document: MockTextDocument; contentChanges: any[] }>();

    get onDidOpenTextDocument(): Event<MockTextDocument> {
        return this._onDidOpenTextDocument.event;
    }

    get onDidCloseTextDocument(): Event<MockTextDocument> {
        return this._onDidCloseTextDocument.event;
    }

    get onDidChangeTextDocument(): Event<{ document: MockTextDocument; contentChanges: any[] }> {
        return this._onDidChangeTextDocument.event;
    }

    get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
        return this._workspaceFolders.length > 0 ? this._workspaceFolders : undefined;
    }

    setWorkspaceFolders(folders: WorkspaceFolder[]): void {
        this._workspaceFolders = folders;
    }

    async openTextDocument(uriOrPath: Uri | string): Promise<MockTextDocument> {
        const uri = typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath;
        const key = uri.toString();
        
        const existing = this.documents.get(key);
        if (existing) { return existing; }
        
        throw new Error(`Document not found: ${key}`);
    }

    getTextDocument(uri: Uri): MockTextDocument | undefined {
        return this.documents.get(uri.toString());
    }

    // For testing: add a document to the mock workspace
    addDocument(uri: Uri, content: string, languageId = 'kanagawa'): MockTextDocument {
        const doc = new MockTextDocument(uri, content, languageId);
        this.documents.set(uri.toString(), doc);
        this._onDidOpenTextDocument.fire(doc);
        return doc;
    }

    // For testing: remove a document
    removeDocument(uri: Uri): void {
        const doc = this.documents.get(uri.toString());
        if (doc) {
            this.documents.delete(uri.toString());
            this._onDidCloseTextDocument.fire(doc);
        }
    }

    // For testing: simulate document change
    changeDocument(uri: Uri, content: string): void {
        const doc = this.documents.get(uri.toString());
        if (doc) {
            doc._setContent(content);
            this._onDidChangeTextDocument.fire({ document: doc, contentChanges: [] });
        }
    }

    async findFiles(include: string, exclude?: string): Promise<Uri[]> {
        // Return documents matching the pattern
        const results: Uri[] = [];
        for (const [key, _] of this.documents) {
            if (this.matchesGlob(key, include) && (!exclude || !this.matchesGlob(key, exclude))) {
                results.push(Uri.parse(key));
            }
        }
        return results;
    }

    private matchesGlob(path: string, pattern: string): boolean {
        // Simple glob matching for common patterns
        if (pattern === '**/*.k') {
            return path.endsWith('.k');
        }
        if (pattern === '**/*.{k,pd}') {
            return path.endsWith('.k') || path.endsWith('.pd');
        }
        if (pattern.includes('**/')) {
            const suffix = pattern.replace('**/', '');
            return path.includes(suffix);
        }
        return path.includes(pattern);
    }

    asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
        const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        if (this._workspaceFolders.length > 0) {
            const wsPath = this._workspaceFolders[0].uri.fsPath;
            if (path.startsWith(wsPath)) {
                return path.slice(wsPath.length + 1);
            }
        }
        return path;
    }

    // File system operations (mocked)
    fs = {
        stat: async (uri: Uri): Promise<{ type: FileType }> => {
            if (this.documents.has(uri.toString())) {
                return { type: FileType.File };
            }
            throw new Error(`File not found: ${uri.toString()}`);
        },
        readFile: async (uri: Uri): Promise<Uint8Array> => {
            const doc = this.documents.get(uri.toString());
            if (doc) {
                return new TextEncoder().encode(doc.getText());
            }
            throw new Error(`File not found: ${uri.toString()}`);
        },
        readDirectory: async (uri: Uri): Promise<[string, FileType][]> => {
            return [];
        }
    };
}

// ============================================================================
// Mock Window
// ============================================================================

export class MockWindow {
    private _activeTextEditor: { document: MockTextDocument } | undefined;
    
    get activeTextEditor(): { document: MockTextDocument } | undefined {
        return this._activeTextEditor;
    }

    setActiveEditor(document: MockTextDocument | undefined): void {
        this._activeTextEditor = document ? { document } : undefined;
    }

    async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return undefined;
    }

    async showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return undefined;
    }

    async showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return undefined;
    }

    async showQuickPick<T extends { label: string }>(items: T[], options?: any): Promise<T | undefined> {
        return items[0];
    }

    async showInputBox(options?: any): Promise<string | undefined> {
        return undefined;
    }

    createOutputChannel(name: string): { appendLine: (value: string) => void; show: () => void; dispose: () => void } {
        return {
            appendLine: () => {},
            show: () => {},
            dispose: () => {}
        };
    }
}

// ============================================================================
// Extension Context
// ============================================================================

export class MockExtensionContext {
    subscriptions: { dispose: () => void }[] = [];
    extensionPath: string = '/mock/extension/path';
    extensionUri: Uri = Uri.file(this.extensionPath);
    storageUri: Uri | undefined = Uri.file('/mock/storage');
    globalStorageUri: Uri = Uri.file('/mock/global-storage');

    globalState = {
        get: <T>(key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (key: string, value: any): Promise<void> => {},
        keys: (): readonly string[] => []
    };

    workspaceState = {
        get: <T>(key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (key: string, value: any): Promise<void> => {},
        keys: (): readonly string[] => []
    };

    asAbsolutePath(relativePath: string): string {
        return `${this.extensionPath}/${relativePath}`;
    }
}

// ============================================================================
// Diagnostic Severity
// ============================================================================

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3
}

export class Diagnostic {
    constructor(
        public range: Range,
        public message: string,
        public severity: DiagnosticSeverity = DiagnosticSeverity.Error
    ) {}

    source?: string;
    code?: string | number;
    relatedInformation?: any[];
}

// ============================================================================
// Global Mock Setup
// ============================================================================

export const workspace = new MockWorkspace();
export const window = new MockWindow();

/**
 * Creates a fresh set of mocks for isolated testing.
 */
export function createMocks(): {
    workspace: MockWorkspace;
    window: MockWindow;
    context: MockExtensionContext;
} {
    return {
        workspace: new MockWorkspace(),
        window: new MockWindow(),
        context: new MockExtensionContext()
    };
}

/**
 * Helper to create a test document with common defaults.
 */
export function createTestDocument(
    content: string,
    options?: {
        uri?: Uri;
        languageId?: string;
        version?: number;
    }
): MockTextDocument {
    const uri = options?.uri ?? Uri.file('/test/file.k');
    return new MockTextDocument(
        uri,
        content,
        options?.languageId ?? 'kanagawa',
        options?.version ?? 1
    );
}
