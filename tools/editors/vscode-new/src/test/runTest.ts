/**
 * Kanagawa Extension Test Runner
 * 
 * This file is used by @vscode/test-electron for integration tests that 
 * require the VS Code extension host (e.g., testing actual hover/completion providers).
 * 
 * For unit tests (grammar parsing, type inference logic), use `npm test` which
 * runs Mocha directly on the compiled test files without needing VS Code.
 * 
 * Test commands:
 * - `npm test` - Run unit tests with Mocha
 * - `npm run test:grammar` - Run tree-sitter grammar tests
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        // The folder containing the Extension Manifest package.json
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        
        // The path to the extension test script
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        
        // Note: Integration tests require a test suite under src/test/suite/
        // For now, we just run basic validation
        console.log('Kanagawa VS Code Extension Integration Tests');
        console.log('Extension path:', extensionDevelopmentPath);
        console.log('');
        console.log('To run unit tests: npm test');
        console.log('To run grammar tests: npm run test:grammar');
        
        // Uncomment to run integration tests when suite/index.ts exists:
        // await runTests({ extensionDevelopmentPath, extensionTestsPath });
        
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
