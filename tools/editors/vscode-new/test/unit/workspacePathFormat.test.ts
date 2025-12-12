import { expect } from 'chai';
import { formatWorkspacePathForTool, WorkspaceFolderLike } from '../../src/utils/workspacePathFormat';

describe('workspacePathFormat', () => {
    it('returns workspace-relative path for single-root', () => {
        const folders: WorkspaceFolderLike[] = [
            { name: 'root', uri: { fsPath: 'C:\\repo' } }
        ];

        const result = formatWorkspacePathForTool('C:\\repo\\src\\main.k', folders);
        expect(result).to.equal('src/main.k');
    });

    it('prefixes workspace folder name for multi-root', () => {
        const folders: WorkspaceFolderLike[] = [
            { name: 'rootA', uri: { fsPath: 'C:\\repoA' } },
            { name: 'rootB', uri: { fsPath: 'C:\\repoB' } }
        ];

        const result = formatWorkspacePathForTool('C:\\repoB\\lib\\util.k', folders);
        expect(result).to.equal('rootB/lib/util.k');
    });

    it('falls back to absolute path for external files', () => {
        const folders: WorkspaceFolderLike[] = [
            { name: 'root', uri: { fsPath: 'C:\\repo' } }
        ];

        const result = formatWorkspacePathForTool('D:\\stdlib\\base.k', folders);
        expect(result).to.equal('D:/stdlib/base.k');
    });

    it('handles nested workspace folders by choosing the longest match', () => {
        const folders: WorkspaceFolderLike[] = [
            { name: 'root', uri: { fsPath: 'C:\\repo' } },
            { name: 'nested', uri: { fsPath: 'C:\\repo\\sub' } }
        ];

        const result = formatWorkspacePathForTool('C:\\repo\\sub\\x\\a.k', folders);
        // multi-root => prefix with folder name
        expect(result).to.equal('nested/x/a.k');
    });
});
