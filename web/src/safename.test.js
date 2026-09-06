// The sender chooses these filenames and the receiver has handed us a folder
// handle, so a name must never be able to point outside the folder they chose.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const probe = new URL('./__sn.gen.js', import.meta.url);
const src = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
writeFileSync(probe, src.match(/export function safeName[\s\S]*?\n}/)[0]);
const { safeName } = await import(probe.href);
unlinkSync(probe);

// Traversal, in both slash styles and mixed.
assert.equal(safeName('../../etc/passwd'), 'passwd');
assert.equal(safeName('..\\..\\Windows\\System32\\a.dll'), 'a.dll');
assert.equal(safeName('/absolute/path/photo.jpg'), 'photo.jpg');
assert.equal(safeName('a/b/../c.txt'), 'c.txt');

// A name made only of dots must not survive as one.
assert.equal(safeName('..'), '_');
assert.equal(safeName('.'), '_');
assert.notEqual(safeName('.hidden'), '.hidden');

// Characters filesystems reject, and control characters.
assert.equal(safeName('a:b|c?d*e.txt'), 'a_b_c_d_e.txt');
assert.equal(safeName('tab' + String.fromCharCode(9) + 'here.txt'), 'tab_here.txt');
assert.equal(safeName('null' + String.fromCharCode(0) + 'byte.txt'), 'null_byte.txt');

// Ordinary names pass through untouched.
assert.equal(safeName('DSC_0001.RAW'), 'DSC_0001.RAW');
assert.equal(safeName('holiday photo (2).jpeg'), 'holiday photo (2).jpeg');

// Nothing usable still yields something writable.
assert.equal(safeName(''), 'file');
assert.equal(safeName('///'), 'file');
assert.ok(safeName('x'.repeat(500)).length <= 180);

console.log('safeName: traversal and bad characters are stripped');
