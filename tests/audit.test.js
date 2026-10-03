import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULTS, buildMessages, buildReviewMessages } from '../core.js';
import { auditCandidate, auditText, surfaceBans } from '../audit.js';

const rules = { extended: await readFile(new URL('../rules/extended.txt', import.meta.url), 'utf8') };
const audit = (text, original = text, settings = DEFAULTS) => auditCandidate(original, text, settings, rules);
const metric = data => `<rs_metrics><!-- ${JSON.stringify(data)} --></rs_metrics>`;
const metrics = { characters: [{ name: 'Лена', color: '#00BFFF', mood: 'Спокойна', thoughts: 'Пора идти.',
    relationship: 70, respect: 90, intention: 'Открыть дверь', feeling: 'Доверие', insight: 'У двери есть замок', secret: 'Забыла ключ', active: true }] };

test('detects supplied absolute bans and selected grammatical forms in neutral sentences', () => {
    for (const text of ['Густая краска высохла.', 'Густыми мазками покрыта стена.', 'Она зафиксировала положение.',
        'Он сказал: «Дыши».', 'В голосе прозвучала сталь.', 'Он говорил будничным тоном.']) {
        assert.ok(audit(text).some(i => i.kind === 'surface'), text);
    }
});

test('normalizes Hangul fillers, zero-width characters, entities, punctuation and ё/е for audit only', () => {
    const text = 'Гус\u200bтаяㅤкраска.ㅤХолодный&#x3164;расчёт. Челюсть&nbsp;сжалась.';
    const before = text;
    const terms = audit(text).filter(i => i.kind === 'surface').map(i => i.term);
    assert.ok(terms.includes('густая'));
    assert.ok(terms.includes('холодный расчет'));
    assert.ok(terms.includes('челюсть сжалась'));
    assert.equal(text, before);
    assert.equal(auditText('ГолосㅤСТАЛ—жёстче'), 'голос стал жестче');
});

test('word boundaries preserve innocent words, normal negation and concrete expressive details', () => {
    for (const text of ['На столе лежала бумага. Она не нашла ключ.', 'Он играл на гитаре.',
        'Красная куртка промокла у плеч. Он долго возился с застёжкой.', 'Она посмотрела на дверь и усмехнулась.']) {
        assert.deepEqual(audit(text), [], text);
    }
});

test('extended switch disables surface guard and keeps basic anchor exceptions out of mechanical matching', () => {
    assert.deepEqual(surfaceBans({ ...DEFAULTS, extended: false }, rules), []);
    assert.deepEqual(audit('Он поднял якорь.', undefined, { ...DEFAULTS, extended: false }), []);
    assert.ok(audit('Он поднял якорь.').some(i => i.term === 'якорь'));
});

test('surface forms come from current rules rather than an unrelated hard-coded list', () => {
    const settings = { extended: true };
    const source = { extended: '<blocked_strings>\n## Example\nForbidden: «пустая витрина».\n</blocked_strings>' };
    assert.deepEqual(surfaceBans(settings, source), ['пустая витрина']);
    assert.equal(auditCandidate('Оригинал', 'Пустаяㅤвитрина.', settings, source)[0].term, 'пустая витрина');
});

test('protects tag attributes/order and FOCUS markers while allowing prose changes', () => {
    const original = '<font color="#00BFFF">Привет.</font>\n⟦FOCUS: Дверь⟧Она открыла дверь.⟦/FOCUS⟧';
    assert.deepEqual(audit(original.replace('Привет.', 'Добрый день.'), original), []);
    assert.ok(audit(original.replace('#00BFFF', '#ffffff'), original).some(i => i.kind === 'structure'));
    assert.ok(audit(original.replace('FOCUS: Дверь', 'FOCUS: Окно'), original).some(i => i.kind === 'structure'));
    assert.ok(audit(original.replace('</font>', ''), original).some(i => i.kind === 'structure'));
});

test('allows editorial metric prose changes but protects names, numbers, colors, booleans, keys and order', () => {
    const original = metric(metrics);
    const copy = structuredClone(metrics); copy.characters[0].thoughts = 'Ключ остался дома.';
    assert.deepEqual(audit(metric(copy), original), []);
    for (const [key, value] of [['name', 'Маша'], ['respect', 50], ['color', '#ffffff'], ['active', false]]) {
        const changed = structuredClone(metrics); changed.characters[0][key] = value;
        assert.ok(audit(metric(changed), original).some(i => i.kind === 'metadata'), key);
    }
    const added = structuredClone(metrics); added.characters[0].extra = 'new';
    assert.ok(audit(metric(added), original).some(i => i.kind === 'metadata'));
    assert.ok(audit('', original).some(i => i.kind === 'metadata'));
    assert.ok(audit('<rs_metrics><!-- broken --></rs_metrics>', original).some(i => i.kind === 'metadata'));
    assert.ok(audit(`<rs_metrics>${JSON.stringify(metrics)}</rs_metrics>`, original).some(i => i.kind === 'metadata'));
});

test('audits editable metric prose while ignoring protected field names and identities', () => {
    const copy = structuredClone(metrics); copy.characters[0].thoughts = 'Он говорил будничным тоном.';
    assert.ok(audit(metric(copy)).some(i => i.term === 'будничным тоном'));
    copy.characters[0].thoughts = 'Пора идти.'; copy.characters[0].name = 'Хищник';
    assert.deepEqual(audit(metric(copy)), []);
});

test('review supplies original and candidate separately with findings and same reference evidence', () => {
    const evidence = { previous_messages: [{ text: 'Я у двери.' }] };
    const original = 'Она открыла дверь.';
    const candidate = 'Она зафиксировала положение двери.';
    const messages = buildReviewMessages(DEFAULTS, rules, original, candidate, evidence);
    const input = JSON.parse(messages[1].content);
    assert.equal(input.original_for_fidelity_check, original);
    assert.equal(input.reply_to_edit, candidate);
    assert.deepEqual(input.context_for_reference_only, evidence);
    assert.ok(input.detected_issues_to_repair.some(i => i.term === 'зафиксировала'));
    assert.ok(messages[0].content.includes(rules.extended));
    assert.deepEqual(JSON.parse(buildMessages(DEFAULTS, rules, candidate, evidence)[1].content)
        .surface_hints_not_an_exhaustive_audit, ['зафиксировала']);
});
