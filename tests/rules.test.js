import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DEFAULTS, buildMessages } from '../core.js';

test('all rule files match the recorded full source fingerprints', async () => {
    const root = new URL('../rules/', import.meta.url);
    const integrity = JSON.parse(await readFile(new URL('integrity.json', root)));
    for (const record of integrity.attachments) {
        const bytes = await readFile(new URL(record.rule_file, root));
        assert.equal(bytes.length, record.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    }
    const basic = await readFile(new URL('basic.txt', root));
    assert.equal(createHash('sha256').update(basic).digest('hex'), integrity.basic.sha256);
});

test('enabled rule files are included in the outgoing prompt in full', async () => {
    const rules = {};
    for (const name of ['basic', 'extended', 'agency']) rules[name] = await readFile(new URL(`../rules/${name}.txt`, import.meta.url), 'utf8');
    const system = buildMessages(DEFAULTS, rules, 'Reply', {})[0].content;
    for (const name of Object.keys(rules)) assert.ok(system.includes(rules[name]), `${name} must remain complete`);
    assert.ok(rules.extended.includes('eighteen independent cleanup passes'));
    assert.ok(rules.basic.includes('This is NOT a ban on ordinary negation.'));
    assert.ok(rules.basic.includes('professional work;'));
    assert.ok(rules.basic.includes('Do not turn every emotion into a physical reaction.'));
});
