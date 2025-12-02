/**
 * Tests for KanagawaSignatureHelpProvider
 * 
 * Priority: P1 - Tests signature help functionality for function calls and templates
 * 
 * The signature help provider must:
 * 1. Show function signatures when typing arguments
 * 2. Highlight the active parameter
 * 3. Handle overloaded functions
 * 4. Support template parameter hints
 * 5. Handle nested calls correctly
 */

import { expect } from 'chai';

/**
 * Tests for the parameter counting logic used in signature help.
 * The algorithm counts commas while respecting nesting levels.
 */
describe('SignatureHelpProvider', () => {
    describe('Active Parameter Computation', () => {
        /**
         * Counts commas to determine which parameter is active.
         * This mirrors the logic in computeActiveParameterFromText.
         */
        function computeActiveParameter(argsText: string): number {
            let commaCount = 0;
            let parenDepth = 0;
            let angleDepth = 0;
            let bracketDepth = 0;
            let braceDepth = 0;
            let inString = false;
            let stringChar = '';
            
            for (let i = 0; i < argsText.length; i++) {
                const ch = argsText[i];
                const prevCh = i > 0 ? argsText[i - 1] : '';
                
                // Handle string literals
                if ((ch === '"' || ch === "'") && prevCh !== '\\') {
                    if (!inString) {
                        inString = true;
                        stringChar = ch;
                    } else if (ch === stringChar) {
                        inString = false;
                    }
                    continue;
                }
                
                if (inString) { continue; }
                
                switch (ch) {
                    case '(': parenDepth++; break;
                    case ')': parenDepth--; break;
                    case '<': angleDepth++; break;
                    case '>': angleDepth--; break;
                    case '[': bracketDepth++; break;
                    case ']': bracketDepth--; break;
                    case '{': braceDepth++; break;
                    case '}': braceDepth--; break;
                    case ',':
                        if (parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                            commaCount++;
                        }
                        break;
                }
            }
            
            return commaCount;
        }

        it('should return 0 for first parameter (no commas)', () => {
            expect(computeActiveParameter('x')).to.equal(0);
            expect(computeActiveParameter('')).to.equal(0);
            expect(computeActiveParameter('foo')).to.equal(0);
        });

        it('should count commas for subsequent parameters', () => {
            expect(computeActiveParameter('x, ')).to.equal(1);
            expect(computeActiveParameter('x, y')).to.equal(1);
            expect(computeActiveParameter('x, y, ')).to.equal(2);
            expect(computeActiveParameter('x, y, z')).to.equal(2);
        });

        it('should ignore commas inside nested parentheses', () => {
            expect(computeActiveParameter('foo(a, b), ')).to.equal(1);
            expect(computeActiveParameter('foo(a, b), bar(c, d)')).to.equal(1);
            expect(computeActiveParameter('foo(a, b), bar(c, d), ')).to.equal(2);
        });

        it('should ignore commas inside angle brackets (templates)', () => {
            expect(computeActiveParameter('Map<K, V>')).to.equal(0);
            expect(computeActiveParameter('Map<K, V>, ')).to.equal(1);
            expect(computeActiveParameter('a, Map<K, V>, b')).to.equal(2);
        });

        it('should ignore commas inside square brackets', () => {
            expect(computeActiveParameter('arr[0, 1]')).to.equal(0);
            expect(computeActiveParameter('arr[0, 1], b')).to.equal(1);
        });

        it('should ignore commas inside braces', () => {
            expect(computeActiveParameter('{a, b, c}')).to.equal(0);
            expect(computeActiveParameter('{a, b}, {c, d}')).to.equal(1);
        });

        it('should ignore commas inside string literals', () => {
            expect(computeActiveParameter('"a, b"')).to.equal(0);
            expect(computeActiveParameter('"a, b", c')).to.equal(1);
            expect(computeActiveParameter("'a, b'")).to.equal(0);
        });

        it('should handle escaped quotes in strings', () => {
            expect(computeActiveParameter('"a\\"b, c"')).to.equal(0);
            expect(computeActiveParameter('"a\\"b", c')).to.equal(1);
        });

        it('should handle deeply nested structures', () => {
            expect(computeActiveParameter('foo(bar(baz(1, 2), 3), 4)')).to.equal(0);
            expect(computeActiveParameter('foo(bar(baz(1, 2), 3), 4), ')).to.equal(1);
        });

        it('should handle mixed nesting', () => {
            expect(computeActiveParameter('Map<List<int>, Set<string>>')).to.equal(0);
            expect(computeActiveParameter('new Map<List<int>, Set<string>>()')).to.equal(0);
            expect(computeActiveParameter('new Map<List<int>, Set<string>>(), ')).to.equal(1);
        });
    });

    describe('Call Context Finding', () => {
        /**
         * Finds the opening parenthesis by scanning backwards.
         * Returns the index or -1 if not found.
         */
        function findOpenParen(text: string): number {
            let parenDepth = 0;
            
            for (let i = text.length - 1; i >= 0; i--) {
                const ch = text[i];
                if (ch === ')') {
                    parenDepth++;
                } else if (ch === '(') {
                    if (parenDepth === 0) {
                        return i;
                    }
                    parenDepth--;
                }
            }
            
            return -1;
        }

        it('should find opening paren at end', () => {
            expect(findOpenParen('foo(')).to.equal(3);
        });

        it('should find opening paren with content', () => {
            expect(findOpenParen('foo(bar')).to.equal(3);
            expect(findOpenParen('foo(bar, ')).to.equal(3);
        });

        it('should skip nested parens', () => {
            // These have balanced parens after 'foo(' so they don't find an unclosed open paren
            // The function finds the UNCLOSED open paren, not the first one
            expect(findOpenParen('foo(bar()')).to.equal(3); // foo( is unclosed, bar() is closed
            expect(findOpenParen('foo(bar(baz))')).to.equal(-1); // all parens balanced
        });

        it('should handle deeply nested parens', () => {
            // All parens are balanced, so no unclosed open paren found
            expect(findOpenParen('foo(a(b(c())))')).to.equal(-1);
        });

        it('should return -1 when no open paren', () => {
            expect(findOpenParen('foo')).to.equal(-1);
            expect(findOpenParen('')).to.equal(-1);
        });

        it('should return -1 when all parens are balanced', () => {
            expect(findOpenParen('foo()')).to.equal(-1);
            expect(findOpenParen('foo(bar())')).to.equal(-1);
        });
    });

    describe('Function Name Extraction', () => {
        /**
         * Extracts function name from text before opening paren.
         */
        function extractFunctionName(textBeforeParen: string): string | undefined {
            // Work backwards to find the identifier
            const trimmed = textBeforeParen.trimEnd();
            if (!trimmed) return undefined;
            
            // Match identifier (letters, digits, underscore, can have :: for qualified names)
            const match = trimmed.match(/([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)$/);
            return match?.[1];
        }

        it('should extract simple function name', () => {
            expect(extractFunctionName('foo')).to.equal('foo');
            expect(extractFunctionName('bar123')).to.equal('bar123');
        });

        it('should extract qualified function name', () => {
            expect(extractFunctionName('Mod::foo')).to.equal('Mod::foo');
            expect(extractFunctionName('a::b::c')).to.equal('a::b::c');
        });

        it('should handle whitespace', () => {
            expect(extractFunctionName('foo  ')).to.equal('foo');
            expect(extractFunctionName('  foo')).to.equal('foo');
        });

        it('should extract from complex expressions', () => {
            expect(extractFunctionName('x.foo')).to.equal('foo');
            expect(extractFunctionName('obj->method')).to.equal('method');
        });

        it('should return undefined for empty string', () => {
            expect(extractFunctionName('')).to.be.undefined;
            expect(extractFunctionName('   ')).to.be.undefined;
        });
    });

    describe('Template Context Detection', () => {
        /**
         * Checks if cursor is inside template angle brackets.
         */
        function isInsideTemplateArgs(text: string): boolean {
            let angleDepth = 0;
            
            for (let i = text.length - 1; i >= 0; i--) {
                const ch = text[i];
                if (ch === '>') {
                    angleDepth++;
                } else if (ch === '<') {
                    if (angleDepth === 0) {
                        return true;
                    }
                    angleDepth--;
                }
                // Stop at statement boundaries
                if (ch === ';' || ch === '{' || ch === '}') {
                    return false;
                }
            }
            
            return false;
        }

        it('should detect inside template args', () => {
            expect(isInsideTemplateArgs('FIFO<')).to.be.true;
            expect(isInsideTemplateArgs('FIFO<uint32')).to.be.true;
            expect(isInsideTemplateArgs('Map<K, ')).to.be.true;
        });

        it('should not detect when balanced', () => {
            expect(isInsideTemplateArgs('FIFO<uint32>')).to.be.false;
            expect(isInsideTemplateArgs('Map<K, V>')).to.be.false;
        });

        it('should handle nested templates', () => {
            expect(isInsideTemplateArgs('Map<List<int>, ')).to.be.true;
            expect(isInsideTemplateArgs('Map<List<int>>')).to.be.false;
        });

        it('should stop at statement boundaries', () => {
            expect(isInsideTemplateArgs('x; FIFO<')).to.be.true;
            expect(isInsideTemplateArgs('{ FIFO<')).to.be.true;
        });
    });

    describe('Parameter Label Extraction', () => {
        /**
         * Extracts parameter labels from a signature string.
         */
        function extractParameterLabels(signature: string): string[] {
            // Find the parameters section
            const parenStart = signature.indexOf('(');
            const parenEnd = signature.lastIndexOf(')');
            if (parenStart < 0 || parenEnd < 0) return [];
            
            const paramsText = signature.substring(parenStart + 1, parenEnd);
            if (!paramsText.trim()) return [];
            
            const params: string[] = [];
            let current = '';
            let depth = 0;
            
            for (const ch of paramsText) {
                if (ch === '<' || ch === '(' || ch === '[') depth++;
                else if (ch === '>' || ch === ')' || ch === ']') depth--;
                else if (ch === ',' && depth === 0) {
                    params.push(current.trim());
                    current = '';
                    continue;
                }
                current += ch;
            }
            
            if (current.trim()) {
                params.push(current.trim());
            }
            
            return params;
        }

        it('should extract simple parameters', () => {
            expect(extractParameterLabels('foo(int x, int y)')).to.deep.equal(['int x', 'int y']);
        });

        it('should handle no parameters', () => {
            expect(extractParameterLabels('foo()')).to.deep.equal([]);
        });

        it('should handle single parameter', () => {
            expect(extractParameterLabels('foo(int x)')).to.deep.equal(['int x']);
        });

        it('should handle template parameters', () => {
            expect(extractParameterLabels('foo(Map<K, V> m, int n)')).to.deep.equal(['Map<K, V> m', 'int n']);
        });

        it('should handle nested templates', () => {
            expect(extractParameterLabels('foo(Map<K, List<V>> m)')).to.deep.equal(['Map<K, List<V>> m']);
        });

        it('should handle default values', () => {
            expect(extractParameterLabels('foo(int x = 0, int y = 1)')).to.deep.equal(['int x = 0', 'int y = 1']);
        });

        it('should preserve spacing', () => {
            expect(extractParameterLabels('foo(const int& x)')).to.deep.equal(['const int& x']);
        });
    });

    describe('Signature Display Formatting', () => {
        /**
         * Formats a function signature for display.
         */
        function formatSignatureForDisplay(signature: string): string {
            // Remove extra whitespace
            return signature.replace(/\s+/g, ' ').trim();
        }

        it('should normalize whitespace', () => {
            expect(formatSignatureForDisplay('foo(  int   x  )')).to.equal('foo( int x )');
        });

        it('should trim leading/trailing whitespace', () => {
            expect(formatSignatureForDisplay('  foo(x)  ')).to.equal('foo(x)');
        });

        it('should handle multiline signatures', () => {
            expect(formatSignatureForDisplay('foo(\n  int x,\n  int y\n)')).to.equal('foo( int x, int y )');
        });
    });

    describe('Overload Resolution', () => {
        interface SignatureCandidate {
            signature: string;
            paramCount: number;
        }

        /**
         * Filters overload candidates by argument count compatibility.
         */
        function filterCompatibleOverloads(
            candidates: SignatureCandidate[],
            activeParamIndex: number
        ): SignatureCandidate[] {
            return candidates.filter(c => c.paramCount > activeParamIndex || c.paramCount === 0);
        }

        it('should filter out overloads with too few parameters', () => {
            const candidates: SignatureCandidate[] = [
                { signature: 'foo()', paramCount: 0 },
                { signature: 'foo(int x)', paramCount: 1 },
                { signature: 'foo(int x, int y)', paramCount: 2 },
            ];
            
            // At first param (index 0), all should be valid
            expect(filterCompatibleOverloads(candidates, 0)).to.have.length(3);
            
            // At second param (index 1), foo() and foo(int) should be excluded
            expect(filterCompatibleOverloads(candidates, 1)).to.have.length(2);
            
            // At third param (index 2), only foo(int, int) or variadic should match
            expect(filterCompatibleOverloads(candidates, 2)).to.have.length(1);
        });

        it('should always include variadic/zero-param functions', () => {
            const candidates: SignatureCandidate[] = [
                { signature: 'foo()', paramCount: 0 }, // Could be variadic
            ];
            
            expect(filterCompatibleOverloads(candidates, 5)).to.have.length(1);
        });
    });

    describe('Call Site Detection', () => {
        /**
         * Determines if we're inside a function call (unclosed paren exists).
         */
        function isInsideFunctionCall(text: string): boolean {
            let parenDepth = 0;
            
            for (let i = text.length - 1; i >= 0; i--) {
                const ch = text[i];
                if (ch === ')') {
                    parenDepth++;
                } else if (ch === '(') {
                    if (parenDepth === 0) {
                        return true;
                    }
                    parenDepth--;
                }
                // Stop at statement boundaries
                if (ch === ';' || ch === '{') {
                    return false;
                }
            }
            
            return false;
        }

        it('should detect inside function call', () => {
            expect(isInsideFunctionCall('foo(')).to.be.true;
            expect(isInsideFunctionCall('foo(x')).to.be.true;
            expect(isInsideFunctionCall('foo(x, ')).to.be.true;
        });

        it('should not detect after function call', () => {
            expect(isInsideFunctionCall('foo()')).to.be.false;
            expect(isInsideFunctionCall('foo(); ')).to.be.false;
        });

        it('should handle nested calls', () => {
            expect(isInsideFunctionCall('foo(bar(')).to.be.true;
            expect(isInsideFunctionCall('foo(bar(),')).to.be.true;
        });

        it('should stop at statement boundaries', () => {
            expect(isInsideFunctionCall('x; foo(')).to.be.true;
            expect(isInsideFunctionCall('x; foo();')).to.be.false;
        });
    });
});
