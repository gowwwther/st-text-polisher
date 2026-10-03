// This is a surface/structure guard, not a semantic editor. It never deletes words from prose.
const SPACING = /[\s\u115f\u1160\u3164\uffa0\u2800]+/gu;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const ENTITIES = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };

export function auditText(value) {
    return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity.startsWith('#')) {
            const n = parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10);
            return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
        }
        return ENTITIES[entity.toLowerCase()] ?? match;
    }).replace(/<\/?[a-z][^>]*>/gi, ' ').normalize('NFKC').replace(INVISIBLE, '')
        .replace(SPACING, ' ').toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function forms(term) {
    const result = [term];
    const word = auditText(term);
    const adjectives = new Set(['густой', 'хищный', 'звериный', 'одержимый', 'собственнический', 'доминантный', 'властный', 'животный', 'стерильный', 'освежающий']);
    if (adjectives.has(word)) {
        const stem = word.slice(0, -2);
        result.push(...['ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ого', 'его', 'ому', 'ему', 'ым', 'им', 'ом', 'ем', 'ую', 'юю', 'ых', 'их', 'ыми', 'ими', 'ою', 'ею'].map(end => stem + end));
    }
    if (/^[а-я]+(?:овал|ировал|нул)$/.test(word)) result.push(word + 'а', word + 'о', word + 'и');
    if (word === 'густой') result.push('гуще', 'густейший', 'густейшая', 'густейшее', 'густейшие');
    if (word === 'хищник') result.push('хищника', 'хищнику', 'хищником', 'хищнике', 'хищники', 'хищников', 'хищникам', 'хищниками', 'хищниках');
    if (word === 'якорь') result.push('якоря', 'якорю', 'якорем', 'якоре', 'якорей', 'якорям', 'якорями', 'якорях');
    return result;
}

export function surfaceBans(settings, rules) {
    // The supplied extended list declares explicitly listed surface forms absolute.
    // Context-dependent basic exceptions and semantic equivalents are left to the model.
    if (!settings.extended || !rules.extended) return [];
    const section = rules.extended.split('<blocked_strings>')[1]?.split('</blocked_strings>')[0] ?? '';
    const paragraphs = section.replace(/^##[^\r\n]*/gm, '').split(/\r?\n\s*\r?\n/);
    const terms = new Set();
    for (const paragraph of paragraphs) {
        const start = paragraph.search(/Forbidden|Absolute (?:visible-output|body-reading) bans|Explicit banned relational comparison forms include/);
        if (start < 0) continue;
        for (const match of paragraph.slice(start).matchAll(/«([^»]+)»/g)) {
            if (/[XY{}]|\//.test(match[1])) continue; // Templates need interpretation, not literal substring matching.
            for (const form of forms(match[1])) if (auditText(form)) terms.add(auditText(form));
        }
    }
    return [...terms];
}

const editableMetricFields = new Set(['mood', 'thoughts', 'feeling', 'intention', 'secret', 'insight']);
function sameMetricStructure(before, after, key = '') {
    if (typeof before !== typeof after || Array.isArray(before) !== Array.isArray(after)) return false;
    if (before === null || after === null) return before === after;
    if (typeof before === 'string') return editableMetricFields.has(key) || before === after;
    if (typeof before !== 'object') return before === after;
    const keys = Object.keys(before).sort();
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(after).sort())) return false;
    return keys.every(k => sameMetricStructure(before[k], after[k], k));
}

function metricBlocks(text) {
    return [...text.matchAll(/<rs_metrics\b[^>]*>([\s\S]*?)<\/rs_metrics\s*>/gi)].map(m => m[1]);
}

function metricJson(s) {
    return JSON.parse(s.trim().replace(/^<!--\s*([\s\S]*?)\s*-->$/, '$1'));
}

function proseToAudit(text) {
    return text.replace(/<rs_metrics\b[^>]*>([\s\S]*?)<\/rs_metrics\s*>/gi, (whole, block) => {
        const strings = [];
        const visit = (value, key = '') => {
            if (typeof value === 'string' && editableMetricFields.has(key)) strings.push(value);
            else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
        };
        try { visit(metricJson(block)); return strings.join('\n'); }
        catch { return whole; }
    });
}

export function auditCandidate(original, candidate, settings, rules) {
    const issues = [];
    const text = ` ${auditText(proseToAudit(candidate))} `;
    for (const term of surfaceBans(settings, rules)) {
        if (text.includes(` ${term} `)) issues.push({ kind: 'surface', term, message: `Остался явный бан: «${term}».` });
    }
    const tags = s => [...s.matchAll(/<\/?[a-z][^>]*>/gi)].map(m => m[0]);
    const markers = s => [...s.matchAll(/⟦[^⟧]*⟧/g)].map(m => m[0]);
    if (JSON.stringify(tags(original)) !== JSON.stringify(tags(candidate))) {
        issues.push({ kind: 'structure', message: 'Изменены HTML-теги, их атрибуты или порядок.' });
    }
    if (JSON.stringify(markers(original)) !== JSON.stringify(markers(candidate))) {
        issues.push({ kind: 'structure', message: 'Изменены структурные маркеры текста.' });
    }
    const before = metricBlocks(original), after = metricBlocks(candidate);
    if (before.length !== after.length) issues.push({ kind: 'metadata', message: 'Изменено количество блоков rs_metrics.' });
    else before.forEach((block, i) => {
        const wrapped = value => /^<!--[\s\S]*-->$/.test(value.trim());
        if (wrapped(block) !== wrapped(after[i])) {
            issues.push({ kind: 'metadata', message: 'Изменена обёртка комментария rs_metrics.' });
        }
        try {
            if (!sameMetricStructure(metricJson(block), metricJson(after[i]))) {
                issues.push({ kind: 'metadata', message: 'Изменены числа, имена, цвета, ключи или структура rs_metrics.' });
            }
        } catch {
            if (block !== after[i]) issues.push({ kind: 'metadata', message: 'Изменён непарсируемый блок rs_metrics; проверь JSON.' });
        }
    });
    return issues;
}

export function issueSummary(issues) {
    return issues.slice(0, 8).map(i => i.message).join(' ') + (issues.length > 8 ? ` Ещё замечаний: ${issues.length - 8}.` : '');
}
