import { expect } from 'chai';
import {
    getContainerFromMember,
    isMemberOfContainer,
    filterDirectMembers,
    getMemberCategory,
    filterMembersByOptions,
    sortMembers,
    computeContainerMatchScore,
    groupMembersByContainer,
    formatMemberSignature,
    isTemplateInstantiation,
    extractTemplateBaseType
} from '../../src/utils/memberUtils';
import { SymbolInfo, SymbolCategory } from '../../src/service/indexer';

// Create minimal mock for SymbolInfo to avoid vscode dependency
function createMockSymbol(overrides: {
    name?: string;
    qualifiedName?: string;
    category?: SymbolCategory;
    signature?: string;
    scopePath?: string[];
}): SymbolInfo {
    return {
        name: overrides.name ?? 'testSymbol',
        qualifiedName: overrides.qualifiedName ?? 'TestClass::testSymbol',
        uri: { toString: () => 'file:///test.k' } as any,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } as any,
        kind: 6, // Method
        scopePath: overrides.scopePath ?? ['TestClass'],
        category: overrides.category ?? 'method',
        signature: overrides.signature
    };
}

describe('Member Utilities', () => {
    describe('getContainerFromMember', () => {
        it('extracts container from method qualified name', () => {
            expect(getContainerFromMember('data.fifo::FIFO::push')).to.equal('data.fifo::FIFO');
        });

        it('extracts container from simple nesting', () => {
            expect(getContainerFromMember('FIFO::push')).to.equal('FIFO');
        });

        it('returns undefined for top-level names', () => {
            expect(getContainerFromMember('globalFunc')).to.be.undefined;
        });

        it('handles deeply nested members', () => {
            expect(getContainerFromMember('a::b::c::d')).to.equal('a::b::c');
        });
    });

    describe('isMemberOfContainer', () => {
        it('returns true for direct members', () => {
            const symbol = createMockSymbol({ qualifiedName: 'FIFO::push' });
            expect(isMemberOfContainer(symbol, 'FIFO')).to.be.true;
        });

        it('returns false for non-members', () => {
            const symbol = createMockSymbol({ qualifiedName: 'Stack::push' });
            expect(isMemberOfContainer(symbol, 'FIFO')).to.be.false;
        });

        it('handles module-qualified containers', () => {
            const symbol = createMockSymbol({ qualifiedName: 'data.fifo::FIFO::push' });
            expect(isMemberOfContainer(symbol, 'data.fifo::FIFO')).to.be.true;
        });
    });

    describe('filterDirectMembers', () => {
        it('filters to only direct members', () => {
            const symbols = [
                createMockSymbol({ qualifiedName: 'FIFO::push', name: 'push' }),
                createMockSymbol({ qualifiedName: 'FIFO::pop', name: 'pop' }),
                createMockSymbol({ qualifiedName: 'Stack::push', name: 'push' }),
                createMockSymbol({ qualifiedName: 'FIFO::Inner::method', name: 'method' })
            ];
            
            const result = filterDirectMembers(symbols, 'FIFO');
            expect(result).to.have.lengthOf(2);
            expect(result.map(s => s.name)).to.deep.equal(['push', 'pop']);
        });
    });

    describe('getMemberCategory', () => {
        it('categorizes methods correctly', () => {
            expect(getMemberCategory('method')).to.equal('method');
            expect(getMemberCategory('function')).to.equal('method');
        });

        it('categorizes fields correctly', () => {
            expect(getMemberCategory('member')).to.equal('field');
            expect(getMemberCategory('variable')).to.equal('field');
        });

        it('categorizes constants correctly', () => {
            expect(getMemberCategory('constant')).to.equal('constant');
        });

        it('categorizes types correctly', () => {
            expect(getMemberCategory('class')).to.equal('type');
            expect(getMemberCategory('struct')).to.equal('type');
            expect(getMemberCategory('enum')).to.equal('type');
            expect(getMemberCategory('alias')).to.equal('type');
        });
    });

    describe('filterMembersByOptions', () => {
        const members = [
            createMockSymbol({ name: 'push', category: 'method' }),
            createMockSymbol({ name: 'pop', category: 'method' }),
            createMockSymbol({ name: 'size', category: 'member' }),
            createMockSymbol({ name: 'MAX_SIZE', category: 'constant' }),
            createMockSymbol({ name: 'Iterator', category: 'class' })
        ];

        it('filters by includeMethods', () => {
            const result = filterMembersByOptions(members, { includeMethods: true, includeFields: false });
            expect(result).to.have.lengthOf(2);
            expect(result.every(m => m.category === 'method')).to.be.true;
        });

        it('filters by includeFields', () => {
            const result = filterMembersByOptions(members, { includeMethods: false, includeFields: true });
            expect(result).to.have.lengthOf(1);
            expect(result[0].name).to.equal('size');
        });

        it('filters by includeConstants', () => {
            const result = filterMembersByOptions(members, { 
                includeMethods: false, 
                includeFields: false,
                includeConstants: true 
            });
            expect(result).to.have.lengthOf(1);
            expect(result[0].name).to.equal('MAX_SIZE');
        });

        it('filters by includeTypes', () => {
            const result = filterMembersByOptions(members, { 
                includeMethods: false, 
                includeFields: false,
                includeTypes: true 
            });
            expect(result).to.have.lengthOf(1);
            expect(result[0].name).to.equal('Iterator');
        });

        it('filters by namePrefix', () => {
            const result = filterMembersByOptions(members, { 
                includeMethods: true,
                includeFields: true,
                namePrefix: 'p' 
            });
            expect(result).to.have.lengthOf(2);
            expect(result.map(m => m.name)).to.include.members(['push', 'pop']);
        });
    });

    describe('sortMembers', () => {
        it('sorts methods before fields', () => {
            const members = [
                createMockSymbol({ name: 'size', category: 'member' }),
                createMockSymbol({ name: 'push', category: 'method' })
            ];
            const sorted = sortMembers(members);
            expect(sorted[0].name).to.equal('push');
            expect(sorted[1].name).to.equal('size');
        });

        it('sorts alphabetically within category', () => {
            const members = [
                createMockSymbol({ name: 'zebra', category: 'method' }),
                createMockSymbol({ name: 'alpha', category: 'method' }),
                createMockSymbol({ name: 'beta', category: 'method' })
            ];
            const sorted = sortMembers(members);
            expect(sorted.map(m => m.name)).to.deep.equal(['alpha', 'beta', 'zebra']);
        });

        it('maintains category order: method, field, constant, type', () => {
            const members = [
                createMockSymbol({ name: 'MyType', category: 'class' }),
                createMockSymbol({ name: 'MAX', category: 'constant' }),
                createMockSymbol({ name: 'value', category: 'member' }),
                createMockSymbol({ name: 'run', category: 'method' })
            ];
            const sorted = sortMembers(members);
            expect(sorted.map(m => m.category)).to.deep.equal(['method', 'member', 'constant', 'class']);
        });
    });

    describe('computeContainerMatchScore', () => {
        it('gives highest score for exact match', () => {
            const score = computeContainerMatchScore('FIFO', 'FIFO', 'data.fifo::FIFO');
            expect(score).to.equal(100);
        });

        it('gives high score for qualified name match', () => {
            const score = computeContainerMatchScore('FIFO', 'FIFO', 'data.fifo::FIFO');
            expect(score).to.be.greaterThan(50);
        });

        it('gives partial score for substring match', () => {
            const score = computeContainerMatchScore('FIF', 'FIFO', 'data.fifo::FIFO');
            expect(score).to.be.greaterThan(0);
        });

        it('gives zero for no match', () => {
            const score = computeContainerMatchScore('Stack', 'FIFO', 'data.fifo::FIFO');
            expect(score).to.equal(0);
        });
    });

    describe('groupMembersByContainer', () => {
        it('groups members by their container', () => {
            const members = [
                createMockSymbol({ qualifiedName: 'FIFO::push', name: 'push' }),
                createMockSymbol({ qualifiedName: 'FIFO::pop', name: 'pop' }),
                createMockSymbol({ qualifiedName: 'Stack::push', name: 'push' })
            ];
            
            const groups = groupMembersByContainer(members);
            expect(groups.size).to.equal(2);
            expect(groups.get('FIFO')).to.have.lengthOf(2);
            expect(groups.get('Stack')).to.have.lengthOf(1);
        });

        it('handles global members', () => {
            const members = [
                createMockSymbol({ qualifiedName: 'globalFunc', name: 'globalFunc' })
            ];
            
            const groups = groupMembersByContainer(members);
            expect(groups.has('(global)')).to.be.true;
        });
    });

    describe('formatMemberSignature', () => {
        it('includes container in signature', () => {
            const member = createMockSymbol({ 
                qualifiedName: 'FIFO::push',
                name: 'push',
                signature: 'void push(T value)'
            });
            expect(formatMemberSignature(member)).to.equal('FIFO::void push(T value)');
        });

        it('falls back to name if no signature', () => {
            const member = createMockSymbol({ 
                qualifiedName: 'FIFO::size',
                name: 'size',
                signature: undefined
            });
            expect(formatMemberSignature(member)).to.equal('FIFO::size');
        });

        it('handles global members', () => {
            const member = createMockSymbol({ 
                qualifiedName: 'helper',
                name: 'helper',
                signature: 'int helper()'
            });
            expect(formatMemberSignature(member)).to.equal('int helper()');
        });
    });

    describe('isTemplateInstantiation', () => {
        it('detects template instantiations', () => {
            expect(isTemplateInstantiation('FIFO<int, 32>')).to.be.true;
            expect(isTemplateInstantiation('Map<string, int>')).to.be.true;
        });

        it('returns false for non-templates', () => {
            expect(isTemplateInstantiation('FIFO')).to.be.false;
            expect(isTemplateInstantiation('SimpleClass')).to.be.false;
        });
    });

    describe('extractTemplateBaseType', () => {
        it('extracts base type from template instantiation', () => {
            expect(extractTemplateBaseType('FIFO<int, 32>')).to.equal('FIFO');
            expect(extractTemplateBaseType('Map<string, int>')).to.equal('Map');
        });

        it('returns input for non-templates', () => {
            expect(extractTemplateBaseType('FIFO')).to.equal('FIFO');
        });

        it('handles nested templates', () => {
            expect(extractTemplateBaseType('Map<string, List<int>>')).to.equal('Map');
        });
    });
});
