import { expect } from 'chai';
import {
    isTemplatedType,
    parseTemplateType,
    findMatchingCloseBracket,
    parseTemplateArguments,
    extractBaseType,
    createInstantiation,
    substituteParameters,
    instantiateMethodSignature,
    extractReturnTypeFromSignature,
    getInstantiatedReturnType,
    parseTemplateParameters,
    buildInstantiationKey,
    normalizeTemplateType,
    hasUnresolvedTemplateParams,
    applyTemplateContext,
    createEmptyContext,
    TemplateParameter
} from '../../src/utils/templateUtils';

describe('Template Utilities', () => {
    describe('isTemplatedType', () => {
        it('returns true for simple template types', () => {
            expect(isTemplatedType('FIFO<int>')).to.be.true;
            expect(isTemplatedType('Map<string, int>')).to.be.true;
            expect(isTemplatedType('List<uint32>')).to.be.true;
        });

        it('returns true for templates with value arguments', () => {
            expect(isTemplatedType('FIFO<int, 32>')).to.be.true;
            expect(isTemplatedType('Array<byte, 256>')).to.be.true;
        });

        it('returns true for nested templates', () => {
            expect(isTemplatedType('Map<string, List<int>>')).to.be.true;
            expect(isTemplatedType('Optional<Pair<A, B>>')).to.be.true;
        });

        it('returns false for non-template types', () => {
            expect(isTemplatedType('FIFO')).to.be.false;
            expect(isTemplatedType('SimpleClass')).to.be.false;
            expect(isTemplatedType('int')).to.be.false;
        });

        it('returns false for invalid angle bracket placement', () => {
            expect(isTemplatedType('<int>')).to.be.false;
            expect(isTemplatedType('>')).to.be.false;
            expect(isTemplatedType('')).to.be.false;
        });

        it('handles whitespace correctly', () => {
            expect(isTemplatedType('  FIFO<int>  ')).to.be.true;
            expect(isTemplatedType('FIFO< int, 32 >')).to.be.true;
        });
    });

    describe('parseTemplateType', () => {
        it('parses simple template type', () => {
            const result = parseTemplateType('FIFO<int>');
            expect(result).to.not.be.undefined;
            expect(result!.baseName).to.equal('FIFO');
            expect(result!.arguments).to.deep.equal(['int']);
            expect(result!.fullType).to.equal('FIFO<int>');
        });

        it('parses template with multiple arguments', () => {
            const result = parseTemplateType('FIFO<uint32, 32>');
            expect(result).to.not.be.undefined;
            expect(result!.baseName).to.equal('FIFO');
            expect(result!.arguments).to.deep.equal(['uint32', '32']);
        });

        it('parses nested template type', () => {
            const result = parseTemplateType('Map<string, List<int>>');
            expect(result).to.not.be.undefined;
            expect(result!.baseName).to.equal('Map');
            expect(result!.arguments).to.deep.equal(['string', 'List<int>']);
        });

        it('parses deeply nested templates', () => {
            const result = parseTemplateType('Outer<Inner<Deep<T>>>');
            expect(result).to.not.be.undefined;
            expect(result!.baseName).to.equal('Outer');
            expect(result!.arguments).to.deep.equal(['Inner<Deep<T>>']);
        });

        it('returns undefined for non-template types', () => {
            expect(parseTemplateType('FIFO')).to.be.undefined;
            expect(parseTemplateType('SimpleClass')).to.be.undefined;
        });

        it('returns undefined for invalid templates', () => {
            expect(parseTemplateType('<int>')).to.be.undefined;
            expect(parseTemplateType('FIFO<')).to.be.undefined;
        });

        it('handles whitespace in arguments', () => {
            const result = parseTemplateType('FIFO< int , 32 >');
            expect(result).to.not.be.undefined;
            expect(result!.arguments).to.deep.equal(['int', '32']);
        });
    });

    describe('findMatchingCloseBracket', () => {
        it('finds closing bracket for simple case', () => {
            expect(findMatchingCloseBracket('FIFO<int>', 4)).to.equal(8);
        });

        it('finds closing bracket with nested templates', () => {
            expect(findMatchingCloseBracket('Map<K, List<V>>', 3)).to.equal(14);
        });

        it('finds closing bracket for inner template', () => {
            expect(findMatchingCloseBracket('Map<K, List<V>>', 11)).to.equal(13);
        });

        it('returns -1 for unmatched bracket', () => {
            expect(findMatchingCloseBracket('FIFO<int', 4)).to.equal(-1);
        });

        it('handles scan starting before angle bracket', () => {
            // When starting before the '<', it finds the first '<' and matches it
            expect(findMatchingCloseBracket('FIFO<int>', 0)).to.equal(8);
        });
    });

    describe('parseTemplateArguments', () => {
        it('parses simple arguments', () => {
            expect(parseTemplateArguments('int, string')).to.deep.equal(['int', 'string']);
        });

        it('parses single argument', () => {
            expect(parseTemplateArguments('uint32')).to.deep.equal(['uint32']);
        });

        it('parses arguments with nested templates', () => {
            expect(parseTemplateArguments('string, List<int>')).to.deep.equal(['string', 'List<int>']);
        });

        it('parses complex nested templates', () => {
            expect(parseTemplateArguments('A, B<C, D>, E')).to.deep.equal(['A', 'B<C, D>', 'E']);
        });

        it('handles whitespace', () => {
            expect(parseTemplateArguments('  int  ,  string  ')).to.deep.equal(['int', 'string']);
        });

        it('handles empty input', () => {
            expect(parseTemplateArguments('')).to.deep.equal([]);
        });

        it('handles value arguments', () => {
            expect(parseTemplateArguments('uint32, 32, true')).to.deep.equal(['uint32', '32', 'true']);
        });
    });

    describe('extractBaseType', () => {
        it('extracts base from simple template', () => {
            expect(extractBaseType('FIFO<int>')).to.equal('FIFO');
        });

        it('extracts base from template with multiple args', () => {
            expect(extractBaseType('Map<K, V>')).to.equal('Map');
        });

        it('returns input for non-template', () => {
            expect(extractBaseType('SimpleType')).to.equal('SimpleType');
        });

        it('handles whitespace', () => {
            expect(extractBaseType('  FIFO<int>  ')).to.equal('FIFO');
        });

        it('extracts base from nested templates', () => {
            expect(extractBaseType('Outer<Inner<T>>')).to.equal('Outer');
        });
    });

    describe('createInstantiation', () => {
        it('creates instantiation with simple type parameter', () => {
            const params: TemplateParameter[] = [
                { name: 'T', kind: 'type' }
            ];
            const result = createInstantiation('FIFO', params, ['uint32']);
            
            expect(result.baseType).to.equal('FIFO');
            expect(result.substitutions.get('T')).to.equal('uint32');
            expect(result.instantiatedType).to.equal('FIFO<uint32>');
        });

        it('creates instantiation with multiple parameters', () => {
            const params: TemplateParameter[] = [
                { name: 'K', kind: 'type' },
                { name: 'V', kind: 'type' }
            ];
            const result = createInstantiation('Map', params, ['string', 'int']);
            
            expect(result.substitutions.get('K')).to.equal('string');
            expect(result.substitutions.get('V')).to.equal('int');
            expect(result.instantiatedType).to.equal('Map<string, int>');
        });

        it('creates instantiation with type and value parameters', () => {
            const params: TemplateParameter[] = [
                { name: 'T', kind: 'type' },
                { name: 'N', kind: 'value' }
            ];
            const result = createInstantiation('FIFO', params, ['byte', '32']);
            
            expect(result.substitutions.get('T')).to.equal('byte');
            expect(result.substitutions.get('N')).to.equal('32');
            expect(result.instantiatedType).to.equal('FIFO<byte, 32>');
        });

        it('uses default values when arguments missing', () => {
            const params: TemplateParameter[] = [
                { name: 'T', kind: 'type' },
                { name: 'N', kind: 'value', defaultValue: '16' }
            ];
            const result = createInstantiation('FIFO', params, ['int']);
            
            expect(result.substitutions.get('T')).to.equal('int');
            expect(result.substitutions.get('N')).to.equal('16');
        });

        it('handles empty parameters', () => {
            const result = createInstantiation('SimpleType', [], []);
            expect(result.instantiatedType).to.equal('SimpleType');
        });
    });

    describe('substituteParameters', () => {
        it('substitutes single parameter', () => {
            const subs = new Map([['T', 'uint32']]);
            expect(substituteParameters('T', subs)).to.equal('uint32');
        });

        it('substitutes parameter in complex type', () => {
            const subs = new Map([['T', 'uint32']]);
            expect(substituteParameters('optional<T>', subs)).to.equal('optional<uint32>');
        });

        it('substitutes multiple parameters', () => {
            const subs = new Map([['K', 'string'], ['V', 'int']]);
            expect(substituteParameters('Pair<K, V>', subs)).to.equal('Pair<string, int>');
        });

        it('handles word boundaries correctly', () => {
            const subs = new Map([['T', 'int']]);
            // Should not replace T in "Token"
            expect(substituteParameters('Token', subs)).to.equal('Token');
            expect(substituteParameters('T', subs)).to.equal('int');
        });

        it('handles longer parameter names first', () => {
            const subs = new Map([['T', 'int'], ['TValue', 'string']]);
            expect(substituteParameters('TValue', subs)).to.equal('string');
            expect(substituteParameters('T', subs)).to.equal('int');
        });

        it('returns original if no substitutions', () => {
            expect(substituteParameters('SomeType', new Map())).to.equal('SomeType');
        });

        it('handles nested templates', () => {
            const subs = new Map([['T', 'uint32']]);
            expect(substituteParameters('List<List<T>>', subs)).to.equal('List<List<uint32>>');
        });
    });

    describe('instantiateMethodSignature', () => {
        it('instantiates method return type', () => {
            const instantiation = {
                baseType: 'FIFO',
                substitutions: new Map([['T', 'uint32']]),
                instantiatedType: 'FIFO<uint32>'
            };
            expect(instantiateMethodSignature('T pop()', instantiation))
                .to.equal('uint32 pop()');
        });

        it('instantiates method parameter types', () => {
            const instantiation = {
                baseType: 'FIFO',
                substitutions: new Map([['T', 'uint32']]),
                instantiatedType: 'FIFO<uint32>'
            };
            expect(instantiateMethodSignature('void push(T value)', instantiation))
                .to.equal('void push(uint32 value)');
        });

        it('instantiates both return and parameter types', () => {
            const instantiation = {
                baseType: 'Container',
                substitutions: new Map([['T', 'string']]),
                instantiatedType: 'Container<string>'
            };
            expect(instantiateMethodSignature('T transform(T input)', instantiation))
                .to.equal('string transform(string input)');
        });

        it('handles complex method signatures', () => {
            const instantiation = {
                baseType: 'Map',
                substitutions: new Map([['K', 'string'], ['V', 'int']]),
                instantiatedType: 'Map<string, int>'
            };
            expect(instantiateMethodSignature('optional<V> get(K key)', instantiation))
                .to.equal('optional<int> get(string key)');
        });
    });

    describe('extractReturnTypeFromSignature', () => {
        it('extracts simple return type', () => {
            expect(extractReturnTypeFromSignature('T pop()')).to.equal('T');
            expect(extractReturnTypeFromSignature('void push(T value)')).to.equal('void');
            expect(extractReturnTypeFromSignature('int size()')).to.equal('int');
        });

        it('extracts template return type', () => {
            expect(extractReturnTypeFromSignature('optional<T> tryPop()')).to.equal('optional<T>');
            expect(extractReturnTypeFromSignature('List<T> getAll()')).to.equal('List<T>');
        });

        it('extracts qualified return type', () => {
            expect(extractReturnTypeFromSignature('data.types::Result process()'))
                .to.equal('data.types::Result');
        });

        it('returns undefined for signatures without return type', () => {
            expect(extractReturnTypeFromSignature('constructor()')).to.be.undefined;
            expect(extractReturnTypeFromSignature('()')).to.be.undefined;
        });

        it('returns undefined for invalid signatures', () => {
            expect(extractReturnTypeFromSignature('not a signature')).to.be.undefined;
            expect(extractReturnTypeFromSignature('')).to.be.undefined;
        });

        it('handles multi-word return types', () => {
            expect(extractReturnTypeFromSignature('unsigned int getValue()')).to.equal('unsigned int');
        });
    });

    describe('getInstantiatedReturnType', () => {
        it('gets instantiated return type', () => {
            const instantiation = {
                baseType: 'FIFO',
                substitutions: new Map([['T', 'uint32']]),
                instantiatedType: 'FIFO<uint32>'
            };
            expect(getInstantiatedReturnType('T pop()', instantiation)).to.equal('uint32');
        });

        it('handles template return types', () => {
            const instantiation = {
                baseType: 'FIFO',
                substitutions: new Map([['T', 'uint32']]),
                instantiatedType: 'FIFO<uint32>'
            };
            expect(getInstantiatedReturnType('optional<T> tryPop()', instantiation))
                .to.equal('optional<uint32>');
        });

        it('handles void return type', () => {
            const instantiation = {
                baseType: 'FIFO',
                substitutions: new Map([['T', 'uint32']]),
                instantiatedType: 'FIFO<uint32>'
            };
            expect(getInstantiatedReturnType('void push(T value)', instantiation)).to.equal('void');
        });

        it('returns undefined for constructors', () => {
            const instantiation = {
                baseType: 'FIFO',
                substitutions: new Map([['T', 'uint32']]),
                instantiatedType: 'FIFO<uint32>'
            };
            expect(getInstantiatedReturnType('FIFO()', instantiation)).to.be.undefined;
        });
    });

    describe('parseTemplateParameters', () => {
        it('parses simple type parameter', () => {
            const params = parseTemplateParameters('<T>');
            expect(params).to.have.lengthOf(1);
            expect(params[0].name).to.equal('T');
            expect(params[0].kind).to.equal('type');
        });

        it('parses multiple type parameters', () => {
            const params = parseTemplateParameters('<K, V>');
            expect(params).to.have.lengthOf(2);
            expect(params[0].name).to.equal('K');
            expect(params[1].name).to.equal('V');
        });

        it('parses value parameter', () => {
            const params = parseTemplateParameters('<T, uint32 N>');
            expect(params).to.have.lengthOf(2);
            expect(params[0].name).to.equal('T');
            expect(params[0].kind).to.equal('type');
            expect(params[1].name).to.equal('N');
            expect(params[1].kind).to.equal('value');
            expect(params[1].constraint).to.equal('uint32');
        });

        it('parses parameter with default value', () => {
            const params = parseTemplateParameters('<T, uint32 N = 16>');
            expect(params).to.have.lengthOf(2);
            expect(params[1].name).to.equal('N');
            expect(params[1].defaultValue).to.equal('16');
        });

        it('parses without angle brackets', () => {
            const params = parseTemplateParameters('T, V');
            expect(params).to.have.lengthOf(2);
            expect(params[0].name).to.equal('T');
            expect(params[1].name).to.equal('V');
        });

        it('handles empty input', () => {
            expect(parseTemplateParameters('')).to.deep.equal([]);
            expect(parseTemplateParameters('<>')).to.deep.equal([]);
        });

        it('recognizes various value types', () => {
            const params = parseTemplateParameters('<int8 A, uint16 B, bool C, size_t D>');
            expect(params.every(p => p.kind === 'value')).to.be.true;
        });
    });

    describe('buildInstantiationKey', () => {
        it('builds key for simple instantiation', () => {
            expect(buildInstantiationKey('FIFO', ['int'])).to.equal('FIFO<int>');
        });

        it('builds key for multiple arguments', () => {
            expect(buildInstantiationKey('Map', ['string', 'int'])).to.equal('Map<string,int>');
        });

        it('builds key for empty arguments', () => {
            expect(buildInstantiationKey('Type', [])).to.equal('Type<>');
        });
    });

    describe('normalizeTemplateType', () => {
        it('normalizes spacing in template types', () => {
            expect(normalizeTemplateType('FIFO<  int  ,  32  >')).to.equal('FIFO<int, 32>');
        });

        it('normalizes nested templates', () => {
            expect(normalizeTemplateType('Map<string,  List< int >>')).to.equal('Map<string, List<int>>');
        });

        it('returns trimmed non-template types', () => {
            expect(normalizeTemplateType('  SimpleType  ')).to.equal('SimpleType');
        });

        it('handles empty string', () => {
            expect(normalizeTemplateType('')).to.equal('');
        });
    });

    describe('Integration scenarios', () => {
        describe('FIFO<uint32, 32> member instantiation', () => {
            it('resolves pop() return type to uint32', () => {
                const parsed = parseTemplateType('FIFO<uint32, 32>');
                expect(parsed).to.not.be.undefined;
                
                const params: TemplateParameter[] = [
                    { name: 'T', kind: 'type' },
                    { name: 'N', kind: 'value' }
                ];
                
                const instantiation = createInstantiation('FIFO', params, parsed!.arguments);
                expect(instantiation.substitutions.get('T')).to.equal('uint32');
                expect(instantiation.substitutions.get('N')).to.equal('32');
                
                const returnType = getInstantiatedReturnType('T pop()', instantiation);
                expect(returnType).to.equal('uint32');
            });

            it('resolves push() parameter type to uint32', () => {
                const parsed = parseTemplateType('FIFO<uint32, 32>');
                const params: TemplateParameter[] = [
                    { name: 'T', kind: 'type' },
                    { name: 'N', kind: 'value' }
                ];
                
                const instantiation = createInstantiation('FIFO', params, parsed!.arguments);
                const signature = instantiateMethodSignature('void push(T value)', instantiation);
                expect(signature).to.equal('void push(uint32 value)');
            });
        });

        describe('Map<string, List<int>> member instantiation', () => {
            it('resolves get() return type with nested template', () => {
                const parsed = parseTemplateType('Map<string, List<int>>');
                expect(parsed).to.not.be.undefined;
                
                const params: TemplateParameter[] = [
                    { name: 'K', kind: 'type' },
                    { name: 'V', kind: 'type' }
                ];
                
                const instantiation = createInstantiation('Map', params, parsed!.arguments);
                
                const returnType = getInstantiatedReturnType('optional<V> get(K key)', instantiation);
                expect(returnType).to.equal('optional<List<int>>');
            });

            it('resolves put() parameter types', () => {
                const parsed = parseTemplateType('Map<string, List<int>>');
                const params: TemplateParameter[] = [
                    { name: 'K', kind: 'type' },
                    { name: 'V', kind: 'type' }
                ];
                
                const instantiation = createInstantiation('Map', params, parsed!.arguments);
                const signature = instantiateMethodSignature('void put(K key, V value)', instantiation);
                expect(signature).to.equal('void put(string key, List<int> value)');
            });
        });

        describe('Full type chain resolution', () => {
            it('handles chained template instantiation', () => {
                // Scenario: Container<FIFO<int>>.get() returns FIFO<int>
                const params: TemplateParameter[] = [
                    { name: 'T', kind: 'type' }
                ];
                
                const instantiation = createInstantiation('Container', params, ['FIFO<int>']);
                const returnType = getInstantiatedReturnType('T get()', instantiation);
                expect(returnType).to.equal('FIFO<int>');
                
                // Now we can further resolve FIFO<int>.pop()
                const fifoParams: TemplateParameter[] = [
                    { name: 'T', kind: 'type' }
                ];
                const fifoInstantiation = createInstantiation('FIFO', fifoParams, ['int']);
                const popReturn = getInstantiatedReturnType('T pop()', fifoInstantiation);
                expect(popReturn).to.equal('int');
            });
        });

        describe('Nested template parameter propagation', () => {
            it('propagates T through nested template', () => {
                // Scenario: template<typename T> class Parent { FIFO<T, 32> fifo; }
                // fifo.dequeue() should return T (not resolved until Parent is instantiated)
                const fifoParams: TemplateParameter[] = [
                    { name: 'U', kind: 'type' },
                    { name: 'Size', kind: 'value' }
                ];
                
                // FIFO<T, 32> instantiation where T is still a parameter
                const instantiation = createInstantiation('FIFO', fifoParams, ['T', '32']);
                expect(instantiation.substitutions.get('U')).to.equal('T');
                expect(instantiation.substitutions.get('Size')).to.equal('32');
                
                // dequeue() returns U, which is T
                const returnType = getInstantiatedReturnType('U dequeue()', instantiation);
                expect(returnType).to.equal('T');
            });

            it('fully resolves when outer template is instantiated', () => {
                // Scenario: Parent<uint32> where Parent has FIFO<T, 32> fifo
                // First: Parent<uint32> means T = uint32
                // Then: FIFO<T, 32> becomes FIFO<uint32, 32>
                // Finally: fifo.dequeue() returns uint32
                
                // Step 1: Resolve Parent's T to uint32
                const parentContext = new Map([['T', 'uint32']]);
                const fifoType = substituteParameters('FIFO<T, 32>', parentContext);
                expect(fifoType).to.equal('FIFO<uint32, 32>');
                
                // Step 2: Now resolve FIFO<uint32, 32>.dequeue()
                const parsed = parseTemplateType(fifoType);
                expect(parsed).to.not.be.undefined;
                
                const fifoParams: TemplateParameter[] = [
                    { name: 'U', kind: 'type' },
                    { name: 'Size', kind: 'value' }
                ];
                const fifoInstantiation = createInstantiation('FIFO', fifoParams, parsed!.arguments);
                const returnType = getInstantiatedReturnType('U dequeue()', fifoInstantiation);
                expect(returnType).to.equal('uint32');
            });
        });
    });
});
