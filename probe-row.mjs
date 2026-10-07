/**
 * Add or remove the temporary PROBE loader row in the desktop profile's patch.
 *
 * Written because editing a UTF-8 file with the wrong tool destroys it: the
 * profile patch carries Chinese model names, and `Set-Content` under Windows
 * PowerShell 5.1 re-encodes the whole file to ANSI, turning every CJK string
 * into mojibake and breaking the YAML. Everything here goes through Node's
 * UTF-8 fs API.
 *
 * Usage: node probe-row.mjs add|remove
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PATCH = process.env.DSH_PROFILE_DIR
  ? `${process.env.DSH_PROFILE_DIR}\\cordis.patch.yml`
  : 'C:/Users/30458/.dsh/profiles/desktop/cordis.patch.yml';

const START = '# --- dsh-update-plus PROBE (temporary, remove after verification) ---';
const END = '# --- end dsh-update-plus probe ---';
const BLOCK = [
  START,
  '- insert:',
  '    - id: dsh-update-plus-probe',
  '      name: dsh-update-plus-probe',
  '      config: {}',
  END,
].join('\n');

const action = process.argv[2] ?? 'add';
const before = readFileSync(PATCH, 'utf8');

const guard = text => {
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (replacement > 0) throw new Error(`refusing to write: ${replacement} replacement characters present`);
  if (!/[\u4e00-\u9fff]/u.test(text)) throw new Error('refusing to write: the document lost its CJK text');
  return text;
};

let after;
if (action === 'add') {
  if (before.includes(START)) {
    console.log('probe row already present');
    process.exit(0);
  }
  after = `${guard(before).replace(/\s+$/u, '')}\n\n${BLOCK}\n`;
} else if (action === 'remove') {
  if (!before.includes(START)) {
    console.log('no probe row to remove');
    process.exit(0);
  }
  const start = before.indexOf(START);
  const end = before.indexOf(END);
  after = `${before.slice(0, start).replace(/\s+$/u, '')}\n${before.slice(end + END.length).replace(/^\s+/u, '')}`;
} else {
  console.error('usage: node probe-row.mjs add|remove');
  process.exit(2);
}

writeFileSync(PATCH, guard(after), 'utf8');
const written = readFileSync(PATCH, 'utf8');
console.log(`${action}: len ${before.length} -> ${written.length}; CJK ok: ${/[\u4e00-\u9fff]/u.test(written)}; replacement chars: ${(written.match(/\uFFFD/g) ?? []).length}`);
