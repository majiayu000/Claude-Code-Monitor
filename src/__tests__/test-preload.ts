import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, sep } from 'path';

const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'keepline-test-')));
const canonicalTmp = realpathSync(tmpdir());

if (!testHome.startsWith(`${canonicalTmp}${sep}`) ||
    !basename(testHome).startsWith('keepline-test-')) {
  throw new Error(`Refusing unsafe Keepline test home: ${testHome}`);
}

// Bun loads this file before every test module, including direct `bun test file` runs.
// Always replace inherited/default storage so a test can never open the user's database.
process.env.KEEPLINE_HOME = testHome;
process.env.KEEPLINE_TEST_HOME = testHome;
process.env.KEEPLINE_TEST_ISOLATED = '1';

process.once('exit', () => {
  rmSync(testHome, { recursive: true, force: true });
});

