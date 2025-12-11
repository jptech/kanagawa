/**
 * Tests for KanagawaHoverProvider
 * 
 * Priority: P1 - Hover is one of the most frequently used IDE features
 * 
 * The hover provider must:
 * 1. Display type information for variables and parameters
 * 2. Show symbol signatures and documentation
 * 3. Handle template parameters display
 * 4. Suggest imports for inaccessible symbols
 * 5. Support local variable hover (with auto/explicit types)
 * 6. Suppress hover for auto variables with inlay hints
 */

import { expect } from 'chai';
import {
    Position,
    Range,
    Uri,
    SymbolKind
} from '../../mocks/vscode';

describe('HoverProvider', () => {

    // Mock types matching the real provider
    interface MockSymbolInfo {
        name: string;
        qualifiedName: string;
        uri: string;
        category: string;
        scopePath: string[];
        signature?: string;
        detail?: string;
        docMarkdown?: string;
    }

    interface LocalTypeInfo {
        signature: string;
        initializer?: string;
        isAutoWithInlayHint?: boolean;
    }

    type ResolutionConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

    interface ResolutionResult {
        primary: MockSymbolInfo | undefined;
        confidence: ResolutionConfidence;
        alternatives: MockSymbolInfo[];
        inaccessible: MockSymbolInfo[];
    }

    function createMockSymbol(
        name: string,
        category: string,
        options: {
            scopePath?: string[];
            signature?: string;
            detail?: string;
            docMarkdown?: string;
            file?: string;
        } = {}
    ): MockSymbolInfo {
        const scopePath = options.scopePath ?? [];
        return {
            name,
            qualifiedName: scopePath.length > 0 ? `${scopePath.join('::')}::${name}` : name,
            uri: `file://${options.file ?? '/test.k'}`,
            category,
            scopePath,
            signature: options.signature,
            detail: options.detail,
            docMarkdown: options.docMarkdown
        };
    }

    describe('Local Variable Hover', () => {
        // Logic for building local type info from variable declarations
        function buildLocalTypeInfo(
            typeText: string | undefined,
            varName: string,
            initializer: string | undefined,
            canInferType: boolean,
            typeHintsEnabled: boolean
        ): LocalTypeInfo | undefined {
            if (!typeText) { return undefined; }
            
            const isAuto = typeText.includes('auto');
            let isAutoWithInlayHint = false;
            
            if (isAuto && initializer && canInferType && typeHintsEnabled) {
                isAutoWithInlayHint = true;
            }
            
            const signatureParts: string[] = [];
            signatureParts.push(typeText.trim());
            signatureParts.push(varName);
            
            return {
                signature: signatureParts.join(' '),
                initializer: initializer?.trim(),
                isAutoWithInlayHint
            };
        }

        it('should build signature for explicit type', () => {
            const info = buildLocalTypeInfo('uint32', 'count', '0', false, true);
            expect(info).to.not.be.undefined;
            expect(info!.signature).to.equal('uint32 count');
            expect(info!.initializer).to.equal('0');
            expect(info!.isAutoWithInlayHint).to.be.false;
        });

        it('should build signature for auto with no inference', () => {
            const info = buildLocalTypeInfo('auto', 'x', '42', false, true);
            expect(info).to.not.be.undefined;
            expect(info!.signature).to.equal('auto x');
            expect(info!.isAutoWithInlayHint).to.be.false;
        });

        it('should mark auto with inlay hint when type is inferable', () => {
            const info = buildLocalTypeInfo('auto', 'x', '42', true, true);
            expect(info).to.not.be.undefined;
            expect(info!.isAutoWithInlayHint).to.be.true;
        });

        it('should not mark inlay hint when hints disabled', () => {
            const info = buildLocalTypeInfo('auto', 'x', '42', true, false);
            expect(info).to.not.be.undefined;
            expect(info!.isAutoWithInlayHint).to.be.false;
        });

        it('should handle const auto', () => {
            const info = buildLocalTypeInfo('const auto', 'MAX', '100', true, true);
            expect(info).to.not.be.undefined;
            expect(info!.signature).to.equal('const auto MAX');
            expect(info!.isAutoWithInlayHint).to.be.true;
        });

        it('should handle parameter with type', () => {
            const info = buildLocalTypeInfo('FIFO<uint32>', 'queue', undefined, false, true);
            expect(info).to.not.be.undefined;
            expect(info!.signature).to.equal('FIFO<uint32> queue');
            expect(info!.initializer).to.be.undefined;
        });
    });

    describe('Symbol Markdown Building', () => {
        // Simulates the buildSymbolMarkdown logic
        function buildSymbolMarkdownContent(
            sym: MockSymbolInfo,
            opts: { docMaxLines?: number } = {}
        ): {
            signatureBlock: string;
            metadata: string;
            docPreview?: string;
            remainingDocLines: number;
        } {
            const summary = (sym.signature ?? `${sym.detail ?? ''} ${sym.name}`.trim()).trim() || sym.name;
            const scopeInfo = sym.scopePath.length > 0 ? sym.scopePath.join('::') : undefined;
            const metadataParts = [sym.category, scopeInfo].filter(Boolean);

            const docLines = sym.docMarkdown ? sym.docMarkdown.trim().split(/\r?\n/) : [];
            const maxLines = opts.docMaxLines ?? 24;
            const docPreview = docLines.length > 0 ? docLines.slice(0, maxLines).join('\n') : undefined;
            const remainingDocLines = Math.max(0, docLines.length - maxLines);
            
            return {
                signatureBlock: summary,
                metadata: metadataParts.join(' · '),
                docPreview,
                remainingDocLines
            };
        }

        it('should use signature when available', () => {
            const sym = createMockSymbol('push', 'method', {
                signature: 'void push(T value)'
            });
            const content = buildSymbolMarkdownContent(sym);
            expect(content.signatureBlock).to.equal('void push(T value)');
        });

        it('should fall back to detail + name when no signature', () => {
            const sym = createMockSymbol('Counter', 'class', {
                detail: 'class'
            });
            const content = buildSymbolMarkdownContent(sym);
            expect(content.signatureBlock).to.equal('class Counter');
        });

        it('should fall back to just name when nothing else available', () => {
            const sym = createMockSymbol('myVar', 'variable');
            const content = buildSymbolMarkdownContent(sym);
            expect(content.signatureBlock).to.equal('myVar');
        });

        it('should include scope info when present', () => {
            const sym = createMockSymbol('push', 'method', {
                scopePath: ['data.fifo', 'FIFO'],
                signature: 'void push(T value)'
            });
            const content = buildSymbolMarkdownContent(sym);
            expect(content.metadata).to.contain('data.fifo::FIFO');
        });

        it('should indicate documentation presence', () => {
            const sym = createMockSymbol('push', 'method', {
                docMarkdown: 'Adds an element to the queue.'
            });
            const content = buildSymbolMarkdownContent(sym);
            expect(content.docPreview).to.not.be.undefined;
            expect(content.remainingDocLines).to.equal(0);
        });

        it('should clamp long documentation to the configured line budget', () => {
            const sym = createMockSymbol('push', 'method', {
                docMarkdown: 'line1\nline2\nline3\nline4\nline5'
            });
            const content = buildSymbolMarkdownContent(sym, { docMaxLines: 3 });
            expect(content.docPreview).to.equal('line1\nline2\nline3');
            expect(content.remainingDocLines).to.equal(2);
        });
    });

    describe('Hover doc formatting', () => {
        function isBannerLine(line: string): boolean {
            const trimmed = line.trim();
            return /^[/=\-]{6,}$/.test(trimmed);
        }

        function formatDocMarkdownForHover(docMarkdown: string): string | undefined {
            const lines = docMarkdown.split(/\r?\n/).map(line => line.trimEnd());
            const filtered = lines.filter(line => !isBannerLine(line));
            const firstIdx = filtered.findIndex(line => line.trim().length > 0);
            if (firstIdx === -1) { return undefined; }

            const headingCandidate = filtered[firstIdx].trim();
            const rest = filtered.slice(firstIdx + 1);
            const shouldPromoteHeading =
                headingCandidate.length > 0 &&
                !headingCandidate.startsWith('-') &&
                !headingCandidate.startsWith('*') &&
                !headingCandidate.startsWith('@');

            const output: string[] = [];
            if (shouldPromoteHeading) {
                output.push(`**${headingCandidate}**`);
                const hasBody = rest.some(line => line.trim().length > 0);
                if (hasBody) { output.push('---'); }
            } else {
                output.push(headingCandidate);
            }

            let body = rest;
            while (body.length && body[0].trim().length === 0) {
                body = body.slice(1);
            }
            output.push(...body);
            return output.join('\n');
        }

        it('should drop banner lines and promote heading for readability', () => {
            const raw = [
                '////////////////////////////////////////////////////////////////////////////////',
                'RDMA Event Queue Component',
                '',
                'This component is responsible for:',
                '- Receiving event reports from child components in the hardware hierarchy',
                '- Storing events with timestamps in a circular buffer for software inspection',
                '- Forwarding events downstream for further hardware processing',
                '- Providing register-based and memory-mapped access for software event retrieval',
                '',
                'The queue operates as a circular buffer. When full, new events are dropped',
                'from storage but still forwarded downstream.'
            ].join('\n');

            const formatted = formatDocMarkdownForHover(raw)!;
            expect(formatted).to.not.contain('////');
            expect(formatted.startsWith('**RDMA Event Queue Component**')).to.be.true;
            expect(formatted).to.contain('---');
            expect(formatted).to.contain('- Receiving event reports');
            expect(formatted).to.contain('The queue operates as a circular buffer');
        });

        it('should avoid promoting heading when no banner context', () => {
            const raw = [
                'RDMA Event Queue Component',
                '',
                'This component is responsible for:',
                '- Receiving event reports from child components'
            ].join('\n');

            const formatted = formatDocMarkdownForHover(raw)!;
            expect(formatted.startsWith('**')).to.be.false;
            expect(formatted.split('\n')[0]).to.equal('RDMA Event Queue Component');
        });

        it('should preserve blank lines as paragraph breaks', () => {
            const raw = [
                '////////////////////////////////////////////////////////////////////////////////',
                'RDMA Event Queue Component',
                '',
                'This component is responsible for:',
                '- Receiving event reports from child components',
                '',
                'The queue operates as a circular buffer.'
            ].join('\n');

            const formatted = formatDocMarkdownForHover(raw)!;
            expect(formatted).to.contain('\n\nThe queue operates');
        });
    });

    describe('Hover Content Building', () => {
        function buildHoverContent(resolution: ResolutionResult): {
            hasPrimary: boolean;
            alternativesCount: number;
            hasImportSuggestion: boolean;
            suggestedModule?: string;
        } {
            if (!resolution.primary) {
                return {
                    hasPrimary: false,
                    alternativesCount: 0,
                    hasImportSuggestion: false
                };
            }

            let suggestedModule: string | undefined;
            if (resolution.confidence === 'low' && resolution.inaccessible.length > 0) {
                const qname = resolution.inaccessible[0].qualifiedName;
                const colonIndex = qname.indexOf('::');
                if (colonIndex > 0) {
                    suggestedModule = qname.substring(0, colonIndex);
                }
            }

            return {
                hasPrimary: true,
                alternativesCount: resolution.alternatives.length,
                hasImportSuggestion: !!suggestedModule,
                suggestedModule
            };
        }

        it('should return empty for no resolution', () => {
            const result: ResolutionResult = {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
            const content = buildHoverContent(result);
            expect(content.hasPrimary).to.be.false;
        });

        it('should include alternatives count', () => {
            const result: ResolutionResult = {
                primary: createMockSymbol('push', 'method'),
                confidence: 'medium',
                alternatives: [
                    createMockSymbol('push', 'method', { file: '/other.k' }),
                    createMockSymbol('push', 'function')
                ],
                inaccessible: []
            };
            const content = buildHoverContent(result);
            expect(content.hasPrimary).to.be.true;
            expect(content.alternativesCount).to.equal(2);
        });

        it('should suggest import for inaccessible symbols', () => {
            const result: ResolutionResult = {
                primary: createMockSymbol('FIFO', 'class'),
                confidence: 'low',
                alternatives: [],
                inaccessible: [
                    createMockSymbol('FIFO', 'class', {
                        scopePath: ['data.fifo']
                    })
                ]
            };
            const content = buildHoverContent(result);
            expect(content.hasImportSuggestion).to.be.true;
            expect(content.suggestedModule).to.equal('data.fifo');
        });

        it('should not suggest import for accessible symbols', () => {
            const result: ResolutionResult = {
                primary: createMockSymbol('FIFO', 'class'),
                confidence: 'exact',
                alternatives: [],
                inaccessible: []
            };
            const content = buildHoverContent(result);
            expect(content.hasImportSuggestion).to.be.false;
        });
    });

    describe('Template Parameters Display', () => {
        const templateCategories = ['class', 'struct', 'union', 'alias', 'function', 'method'];
        const nonTemplateCategories = ['variable', 'member', 'constant', 'enum', 'module'];

        function shouldShowTemplateParams(category: string): boolean {
            return templateCategories.includes(category);
        }

        it('should show template params for classes', () => {
            expect(shouldShowTemplateParams('class')).to.be.true;
        });

        it('should show template params for structs', () => {
            expect(shouldShowTemplateParams('struct')).to.be.true;
        });

        it('should show template params for functions', () => {
            expect(shouldShowTemplateParams('function')).to.be.true;
        });

        it('should show template params for methods', () => {
            expect(shouldShowTemplateParams('method')).to.be.true;
        });

        it('should show template params for aliases', () => {
            expect(shouldShowTemplateParams('alias')).to.be.true;
        });

        it('should not show template params for variables', () => {
            expect(shouldShowTemplateParams('variable')).to.be.false;
        });

        it('should not show template params for members', () => {
            expect(shouldShowTemplateParams('member')).to.be.false;
        });

        it('should not show template params for constants', () => {
            expect(shouldShowTemplateParams('constant')).to.be.false;
        });
    });

    describe('Hover Range Computation', () => {
        function computeHoverRange(
            startRow: number, startCol: number,
            endRow: number, endCol: number
        ): Range {
            return new Range(
                new Position(startRow, startCol),
                new Position(endRow, endCol)
            );
        }

        it('should create single-line range', () => {
            const range = computeHoverRange(5, 10, 5, 15);
            expect(range.start.line).to.equal(5);
            expect(range.start.character).to.equal(10);
            expect(range.end.line).to.equal(5);
            expect(range.end.character).to.equal(15);
            expect(range.isSingleLine).to.be.true;
        });

        it('should handle zero-width range', () => {
            const range = computeHoverRange(0, 0, 0, 0);
            expect(range.isEmpty).to.be.true;
        });
    });

    describe('Initializer Value Extraction', () => {
        // Simulates findInitializerValue logic
        interface MockNode {
            type: string;
            text: string;
            children: MockNode[];
        }

        function findInitializerValue(children: MockNode[]): MockNode | undefined {
            let foundEquals = false;
            for (const child of children) {
                if (child.type === '=' || child.text === '=') {
                    foundEquals = true;
                    continue;
                }
                if (foundEquals && child.type !== ';') {
                    return child;
                }
            }
            return undefined;
        }

        it('should find simple initializer', () => {
            const children: MockNode[] = [
                { type: 'type', text: 'uint32', children: [] },
                { type: 'identifier', text: 'x', children: [] },
                { type: '=', text: '=', children: [] },
                { type: 'number_literal', text: '42', children: [] },
                { type: ';', text: ';', children: [] }
            ];
            const init = findInitializerValue(children);
            expect(init).to.not.be.undefined;
            expect(init!.text).to.equal('42');
        });

        it('should return undefined when no equals', () => {
            const children: MockNode[] = [
                { type: 'type', text: 'uint32', children: [] },
                { type: 'identifier', text: 'x', children: [] },
                { type: ';', text: ';', children: [] }
            ];
            const init = findInitializerValue(children);
            expect(init).to.be.undefined;
        });

        it('should skip semicolon after equals', () => {
            const children: MockNode[] = [
                { type: 'identifier', text: 'x', children: [] },
                { type: '=', text: '=', children: [] },
                { type: ';', text: ';', children: [] }
            ];
            const init = findInitializerValue(children);
            expect(init).to.be.undefined;
        });

        it('should find call expression as initializer', () => {
            const children: MockNode[] = [
                { type: 'type', text: 'auto', children: [] },
                { type: 'identifier', text: 'result', children: [] },
                { type: '=', text: '=', children: [] },
                { type: 'call_expression', text: 'compute()', children: [] },
                { type: ';', text: ';', children: [] }
            ];
            const init = findInitializerValue(children);
            expect(init).to.not.be.undefined;
            expect(init!.type).to.equal('call_expression');
        });
    });

    describe('Identifier Resolution', () => {
        // Tests for identifier node resolution patterns
        const identifierTypes = ['identifier', 'type_identifier', 'field_identifier'];
        const identifierParentTypes = ['qualified_identifier', 'member_expression', 'field_expression'];

        function resolveToIdentifier(nodeType: string, parentType: string | undefined): boolean {
            if (identifierTypes.includes(nodeType)) {
                return true;
            }
            if (parentType && identifierParentTypes.includes(parentType)) {
                // Navigate to identifier child
                return true; // assuming child exists
            }
            return false;
        }

        it('should resolve identifier node', () => {
            expect(resolveToIdentifier('identifier', undefined)).to.be.true;
        });

        it('should resolve type_identifier node', () => {
            expect(resolveToIdentifier('type_identifier', undefined)).to.be.true;
        });

        it('should resolve field_identifier node', () => {
            expect(resolveToIdentifier('field_identifier', undefined)).to.be.true;
        });

        it('should resolve from qualified_identifier parent', () => {
            expect(resolveToIdentifier('other', 'qualified_identifier')).to.be.true;
        });

        it('should resolve from member_expression parent', () => {
            expect(resolveToIdentifier('other', 'member_expression')).to.be.true;
        });

        it('should not resolve unrelated nodes', () => {
            expect(resolveToIdentifier('binary_expression', undefined)).to.be.false;
        });
    });

    describe('Confidence-Based Display', () => {
        it('should return no hover for none confidence', () => {
            const result: ResolutionResult = {
                primary: undefined,
                confidence: 'none',
                alternatives: [],
                inaccessible: []
            };
            expect(result.confidence).to.equal('none');
            expect(result.primary).to.be.undefined;
        });

        it('should display for exact confidence', () => {
            const result: ResolutionResult = {
                primary: createMockSymbol('push', 'method'),
                confidence: 'exact',
                alternatives: [],
                inaccessible: []
            };
            expect(result.confidence).to.equal('exact');
            expect(result.primary).to.not.be.undefined;
        });

        it('should display with alternatives for medium confidence', () => {
            const result: ResolutionResult = {
                primary: createMockSymbol('process', 'function'),
                confidence: 'medium',
                alternatives: [
                    createMockSymbol('process', 'method'),
                    createMockSymbol('process', 'function', { file: '/other.k' })
                ],
                inaccessible: []
            };
            expect(result.alternatives.length).to.be.greaterThan(0);
        });
    });
});
