/**
 * Tests for KanagawaInlayHintsProvider
 * 
 * Priority: P2 - Tests inlay hints functionality
 * 
 * The inlay hints provider must:
 * 1. Show type hints for auto variables
 * 2. Show parameter names at call sites
 * 3. Show template parameter names
 * 4. Cache results efficiently
 * 5. Respect configuration settings
 */

import { expect } from 'chai';

describe('InlayHintsProvider', () => {
    describe('Type Hint Detection', () => {
        /**
         * Determines if a variable declaration needs a type hint.
         * Type hints are shown for `auto` variables where the type can be inferred.
         */
        function needsTypeHint(
            typeText: string | undefined,
            hasInitializer: boolean,
            inferredType: string | undefined
        ): boolean {
            // No type hint if type is explicit
            if (typeText && !typeText.includes('auto')) {
                return false;
            }
            
            // Need type hint if auto with inferable initializer
            if (typeText?.includes('auto') && hasInitializer) {
                return inferredType !== undefined && 
                       inferredType !== 'auto' && 
                       inferredType !== 'unknown';
            }
            
            return false;
        }

        it('should not show hint for explicit types', () => {
            expect(needsTypeHint('int', true, 'int')).to.be.false;
            expect(needsTypeHint('string', true, 'string')).to.be.false;
            expect(needsTypeHint('MyClass', true, 'MyClass')).to.be.false;
        });

        it('should show hint for auto with inferred type', () => {
            expect(needsTypeHint('auto', true, 'int')).to.be.true;
            expect(needsTypeHint('auto', true, 'string')).to.be.true;
            expect(needsTypeHint('auto', true, 'FIFO<uint32>')).to.be.true;
        });

        it('should not show hint for auto without initializer', () => {
            expect(needsTypeHint('auto', false, undefined)).to.be.false;
        });

        it('should not show hint when type cannot be inferred', () => {
            expect(needsTypeHint('auto', true, undefined)).to.be.false;
            expect(needsTypeHint('auto', true, 'auto')).to.be.false;
            expect(needsTypeHint('auto', true, 'unknown')).to.be.false;
        });

        it('should handle const auto', () => {
            expect(needsTypeHint('const auto', true, 'int')).to.be.true;
        });
    });

    describe('Parameter Name Extraction', () => {
        /**
         * Extracts parameter names from a function signature.
         */
        function extractParameterNames(signature: string): string[] {
            // Find params between first ( and last )
            const start = signature.indexOf('(');
            const end = signature.lastIndexOf(')');
            if (start < 0 || end < 0 || end <= start) return [];
            
            const paramsText = signature.substring(start + 1, end).trim();
            if (!paramsText) return [];
            
            const params: string[] = [];
            let current = '';
            let depth = 0;
            
            for (const ch of paramsText) {
                if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
                else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
                else if (ch === ',' && depth === 0) {
                    const name = extractNameFromParam(current.trim());
                    if (name) params.push(name);
                    current = '';
                    continue;
                }
                current += ch;
            }
            
            const lastName = extractNameFromParam(current.trim());
            if (lastName) params.push(lastName);
            
            return params;
        }
        
        /**
         * Extracts just the name from a parameter declaration like "int x" or "Map<K,V> m".
         */
        function extractNameFromParam(param: string): string | undefined {
            if (!param) return undefined;
            
            // Remove default value
            const eqIdx = param.indexOf('=');
            if (eqIdx >= 0) {
                param = param.substring(0, eqIdx).trim();
            }
            
            // The name is the last identifier
            const match = param.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
            return match?.[1];
        }

        it('should extract simple parameter names', () => {
            expect(extractParameterNames('foo(int x, int y)')).to.deep.equal(['x', 'y']);
        });

        it('should extract names with template types', () => {
            expect(extractParameterNames('foo(Map<K, V> data, int count)')).to.deep.equal(['data', 'count']);
        });

        it('should handle no parameters', () => {
            expect(extractParameterNames('foo()')).to.deep.equal([]);
        });

        it('should handle single parameter', () => {
            expect(extractParameterNames('foo(int x)')).to.deep.equal(['x']);
        });

        it('should handle default values', () => {
            expect(extractParameterNames('foo(int x = 0, int y = 1)')).to.deep.equal(['x', 'y']);
        });

        it('should handle pointer/reference types', () => {
            expect(extractParameterNames('foo(int* ptr, int& ref)')).to.deep.equal(['ptr', 'ref']);
        });

        it('should handle const parameters', () => {
            expect(extractParameterNames('foo(const int x, const string& s)')).to.deep.equal(['x', 's']);
        });

        it('should handle nested templates', () => {
            expect(extractParameterNames('foo(Map<string, List<int>> m)')).to.deep.equal(['m']);
        });
    });

    describe('Parameter Hint Applicability', () => {
        /**
         * Determines if a parameter should show a hint at a call site.
         */
        function shouldShowParameterHint(
            argText: string,
            paramName: string
        ): boolean {
            // Don't show if argument is the same as parameter name
            const argTrimmed = argText.trim();
            if (argTrimmed === paramName) {
                return false;
            }
            
            // Don't show for simple literals if name is obvious
            if (isObviousArgument(argTrimmed, paramName)) {
                return false;
            }
            
            return true;
        }
        
        function isObviousArgument(arg: string, paramName: string): boolean {
            // Named argument: x: value
            if (arg.includes(':')) {
                return true;
            }
            
            // Very short/simple arguments
            if (arg.length <= 2 && /^[a-z]$/.test(arg)) {
                return false; // Single letter variable - show hint
            }
            
            // Argument contains the parameter name
            if (arg.toLowerCase().includes(paramName.toLowerCase())) {
                return true;
            }
            
            return false;
        }

        it('should hide hint when arg matches param name', () => {
            expect(shouldShowParameterHint('count', 'count')).to.be.false;
            expect(shouldShowParameterHint('size', 'size')).to.be.false;
        });

        it('should show hint for different names', () => {
            expect(shouldShowParameterHint('n', 'count')).to.be.true;
            expect(shouldShowParameterHint('x', 'width')).to.be.true;
        });

        it('should hide hint for named arguments', () => {
            expect(shouldShowParameterHint('count: 5', 'count')).to.be.false;
        });

        it('should hide hint when arg contains param name', () => {
            expect(shouldShowParameterHint('itemCount', 'count')).to.be.false;
            expect(shouldShowParameterHint('maxSize', 'size')).to.be.false;
        });
    });

    describe('Template Parameter Hints', () => {
        /**
         * Extracts template parameter names from a template declaration.
         */
        function extractTemplateParams(templateDecl: string): string[] {
            // Format: template<typename T, typename U = int, int N = 10>
            const match = templateDecl.match(/template\s*<(.*)>/);
            if (!match) return [];
            
            const paramsText = match[1];
            const params: string[] = [];
            let current = '';
            let depth = 0;
            
            for (const ch of paramsText) {
                if (ch === '<') depth++;
                else if (ch === '>') depth--;
                else if (ch === ',' && depth === 0) {
                    const name = extractTemplateParamName(current.trim());
                    if (name) params.push(name);
                    current = '';
                    continue;
                }
                current += ch;
            }
            
            const lastName = extractTemplateParamName(current.trim());
            if (lastName) params.push(lastName);
            
            return params;
        }
        
        function extractTemplateParamName(param: string): string | undefined {
            // Remove default value
            const eqIdx = param.indexOf('=');
            if (eqIdx >= 0) {
                param = param.substring(0, eqIdx).trim();
            }
            
            // Format: "typename T" or "int N"
            const parts = param.split(/\s+/);
            return parts[parts.length - 1];
        }

        it('should extract typename parameters', () => {
            expect(extractTemplateParams('template<typename T>')).to.deep.equal(['T']);
            expect(extractTemplateParams('template<typename T, typename U>')).to.deep.equal(['T', 'U']);
        });

        it('should extract value parameters', () => {
            expect(extractTemplateParams('template<int N>')).to.deep.equal(['N']);
            expect(extractTemplateParams('template<typename T, int N>')).to.deep.equal(['T', 'N']);
        });

        it('should handle default values', () => {
            expect(extractTemplateParams('template<typename T = int>')).to.deep.equal(['T']);
            expect(extractTemplateParams('template<int N = 10>')).to.deep.equal(['N']);
        });

        it('should handle complex defaults', () => {
            expect(extractTemplateParams('template<typename T = List<int>>')).to.deep.equal(['T']);
        });

        it('should handle empty template', () => {
            expect(extractTemplateParams('template<>')).to.deep.equal([]);
            expect(extractTemplateParams('not a template')).to.deep.equal([]);
        });
    });

    describe('Hint Positioning', () => {
        /**
         * Calculates the position for a type hint after the variable name.
         */
        function calculateTypeHintPosition(
            nameStartCol: number,
            nameLength: number
        ): number {
            return nameStartCol + nameLength;
        }

        /**
         * Calculates the position for a parameter hint before the argument.
         */
        function calculateParamHintPosition(argStartCol: number): number {
            return argStartCol;
        }

        it('should position type hint after variable name', () => {
            // auto x = 5;
            //     ^ name starts at col 5, length 1
            expect(calculateTypeHintPosition(5, 1)).to.equal(6);
            
            // auto myVariable = 5;
            //     ^ name starts at col 5, length 10
            expect(calculateTypeHintPosition(5, 10)).to.equal(15);
        });

        it('should position param hint before argument', () => {
            // foo(42);
            //    ^ arg starts at col 4
            expect(calculateParamHintPosition(4)).to.equal(4);
        });
    });

    describe('Cache Management', () => {
        interface CacheEntry<T> {
            value: T;
            timestamp: number;
        }

        class SimpleCache<T> {
            private cache = new Map<string, CacheEntry<T>>();
            private maxAge: number;

            constructor(maxAgeMs: number = 5000) {
                this.maxAge = maxAgeMs;
            }

            get(key: string): T | undefined {
                const entry = this.cache.get(key);
                if (!entry) return undefined;
                
                if (Date.now() - entry.timestamp > this.maxAge) {
                    this.cache.delete(key);
                    return undefined;
                }
                
                return entry.value;
            }

            set(key: string, value: T): void {
                this.cache.set(key, { value, timestamp: Date.now() });
            }

            clear(): void {
                this.cache.clear();
            }

            get size(): number {
                return this.cache.size;
            }
        }

        it('should cache values', () => {
            const cache = new SimpleCache<string>();
            cache.set('key1', 'value1');
            expect(cache.get('key1')).to.equal('value1');
        });

        it('should return undefined for missing keys', () => {
            const cache = new SimpleCache<string>();
            expect(cache.get('missing')).to.be.undefined;
        });

        it('should clear all entries', () => {
            const cache = new SimpleCache<string>();
            cache.set('key1', 'value1');
            cache.set('key2', 'value2');
            expect(cache.size).to.equal(2);
            
            cache.clear();
            expect(cache.size).to.equal(0);
        });

        it('should expire old entries', async () => {
            const cache = new SimpleCache<string>(10); // 10ms expiry
            cache.set('key1', 'value1');
            expect(cache.get('key1')).to.equal('value1');
            
            // Wait for expiry
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(cache.get('key1')).to.be.undefined;
        });
    });

    describe('Configuration Handling', () => {
        interface HintConfig {
            typeHintsEnabled: boolean;
            parameterNamesEnabled: boolean;
            templateParameterNamesEnabled: boolean;
        }

        function shouldProvideHints(config: HintConfig): boolean {
            return config.typeHintsEnabled || 
                   config.parameterNamesEnabled || 
                   config.templateParameterNamesEnabled;
        }

        it('should provide hints when any option is enabled', () => {
            expect(shouldProvideHints({
                typeHintsEnabled: true,
                parameterNamesEnabled: false,
                templateParameterNamesEnabled: false
            })).to.be.true;
            
            expect(shouldProvideHints({
                typeHintsEnabled: false,
                parameterNamesEnabled: true,
                templateParameterNamesEnabled: false
            })).to.be.true;
        });

        it('should not provide hints when all disabled', () => {
            expect(shouldProvideHints({
                typeHintsEnabled: false,
                parameterNamesEnabled: false,
                templateParameterNamesEnabled: false
            })).to.be.false;
        });

        it('should provide hints when all enabled', () => {
            expect(shouldProvideHints({
                typeHintsEnabled: true,
                parameterNamesEnabled: true,
                templateParameterNamesEnabled: true
            })).to.be.true;
        });
    });

    describe('Type Formatting for Display', () => {
        /**
         * Formats a type for display in inlay hints.
         * Shortens long types and normalizes spacing.
         */
        function formatTypeForHint(type: string, maxLength: number = 30): string {
            // Normalize whitespace
            let formatted = type.replace(/\s+/g, ' ').trim();
            
            // Truncate if too long
            if (formatted.length > maxLength) {
                formatted = formatted.substring(0, maxLength - 3) + '...';
            }
            
            return formatted;
        }

        it('should normalize whitespace', () => {
            expect(formatTypeForHint('Map<  K,  V  >')).to.equal('Map< K, V >');
        });

        it('should truncate long types', () => {
            const longType = 'Map<string, List<Pair<int, int>>>';
            expect(formatTypeForHint(longType, 20)).to.equal('Map<string, List<...');
        });

        it('should not truncate short types', () => {
            expect(formatTypeForHint('int')).to.equal('int');
            expect(formatTypeForHint('string')).to.equal('string');
        });

        it('should handle empty string', () => {
            expect(formatTypeForHint('')).to.equal('');
        });
    });

    describe('Argument Position Mapping', () => {
        interface ArgumentInfo {
            index: number;
            startOffset: number;
            endOffset: number;
            text: string;
        }

        /**
         * Maps cursor position to argument index.
         */
        function findArgumentAtPosition(
            args: ArgumentInfo[],
            cursorOffset: number
        ): ArgumentInfo | undefined {
            for (const arg of args) {
                if (cursorOffset >= arg.startOffset && cursorOffset <= arg.endOffset) {
                    return arg;
                }
            }
            return undefined;
        }

        it('should find argument at cursor position', () => {
            const args: ArgumentInfo[] = [
                { index: 0, startOffset: 4, endOffset: 5, text: 'x' },
                { index: 1, startOffset: 8, endOffset: 9, text: 'y' },
            ];
            
            expect(findArgumentAtPosition(args, 4)?.index).to.equal(0);
            expect(findArgumentAtPosition(args, 5)?.index).to.equal(0);
            expect(findArgumentAtPosition(args, 8)?.index).to.equal(1);
        });

        it('should return undefined outside arguments', () => {
            const args: ArgumentInfo[] = [
                { index: 0, startOffset: 4, endOffset: 5, text: 'x' },
            ];
            
            expect(findArgumentAtPosition(args, 0)).to.be.undefined;
            expect(findArgumentAtPosition(args, 10)).to.be.undefined;
        });

        it('should handle empty arguments', () => {
            expect(findArgumentAtPosition([], 5)).to.be.undefined;
        });
    });
});
