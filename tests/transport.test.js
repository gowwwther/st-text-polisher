import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompletion } from '../core.js';
import { readCompletionStream, requestProxy } from '../transport.js';

const encoder = new TextEncoder();
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const stop = event({}, 'stop');
const done = 'data: [DONE]\n\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function response(chunks, delay = 0) {
    let index = 0, cancelled = false;
    return new Response(new ReadableStream({
        async pull(controller) {
            if (delay) await sleep(delay);
            if (cancelled) return;
            if (index === chunks.length) controller.close();
            else {
                const chunk = chunks[index++];
                controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            }
        },
        cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
}
const read = async (chunks, options = {}) => parseCompletion(await readCompletionStream(response(chunks), {
    signal: new AbortController().signal, ...options,
}));

test('SSE handles every UTF-8 byte boundary and split CRLF without damaging formatting', async () => {
    const text = '  <font color="#00BFFF">«Привет»</font>\n*Он улыбнулся.*\n';
    const wire = (': heartbeat\n\n' + event({ role: 'assistant' }) + event({ content: text }) + stop + done).replaceAll('\n', '\r\n');
    const chunks = [...encoder.encode(wire)].map(byte => Uint8Array.of(byte));
    assert.equal(await read(chunks), text);
});

test('SSE combines multiple data lines and processes multiple events in one network chunk', async () => {
    const multiline = 'event: message\ndata: {"choices":\ndata: [{"index":0,"delta":{"content":"Начало. "}}]}\n\n';
    assert.equal(await read([multiline + event({ content: 'Конец.' }) + stop + done]), 'Начало. Конец.');
});

test('reasoning, keepalives and usage count as activity but never enter visible text', async () => {
    const updates = []; let activity = 0;
    const chunks = [': keepalive\n\n', event({ reasoning_content: 'PRIVATE', reasoning: 'SECRET' }),
        event({ content: 'Ответ.' }), stop, 'data: {"choices":[],"usage":{"total_tokens":30}}\n\n', done];
    assert.equal(await read(chunks, { onActivity: () => activity++, onProgress: p => updates.push(p) }), 'Ответ.');
    assert.equal(activity, chunks.length);
    assert.ok(updates.every(p => !JSON.stringify(p).includes('PRIVATE') && !JSON.stringify(p).includes('SECRET')));
});

test('accepts explicit DONE or stop at clean EOF, including an unterminated final SSE line', async () => {
    assert.equal(await read([event({ content: 'Полный ответ.' }), done]), 'Полный ответ.');
    assert.equal(await read([event({ content: 'Полный ответ.' }), stop.trimEnd()]), 'Полный ответ.');
});

test('rejects broken EOF, malformed JSON, late content and unknown finish reasons', async () => {
    for (const chunks of [[event({ content: 'Частичный' })], ['data: {broken}\n\n'],
        [event({ content: 'Текст' }), stop, event({ content: 'После завершения' }), done],
        [event({ content: 'Текст' }, 'unexpected'), done]]) {
        await assert.rejects(read(chunks));
    }
});

test('rejects truncation, provider errors, refusals, tools, empty text and visible reasoning', async () => {
    for (const chunks of [[event({ content: 'Обрезано' }, 'length'), done],
        [event({ content: 'Обрезано' }, 'max_tokens'), done],
        ['data: {"error":{"message":"bad key"}}\n\n'],
        ['event: error\ndata: {"message":"failure"}\n\n'],
        [event({ refusal: 'no' }), done], [event({ content: 'Текст' }, 'content_filter'), done],
        [event({ tool_calls: [{ id: 'call' }] }), done], [event({ content: ['unsupported'] }), done],
        [event({ reasoning_content: 'private' }), stop, done],
        [event({ content: '<think>reason</think>answer' }), stop, done]]) await assert.rejects(read(chunks));
});

test('stream inactivity timeout resets on reasoning and heartbeats; total time may exceed timeout', async () => {
    const chunks = [': ping\n\n', event({ reasoning_content: 'private' }), ': ping\n\n',
        event({ content: 'Готово.' }), stop, done];
    const started = Date.now();
    const result = await requestProxy('generate', { stream: true }, new AbortController(), 0.12, {}, undefined,
        async () => response(chunks, 35));
    assert.equal(parseCompletion(result), 'Готово.');
    assert.ok(Date.now() - started > 120);
});

test('stalled initial fetch and stalled stream both time out without returning partial results', async () => {
    await assert.rejects(requestProxy('generate', { stream: true }, new AbortController(), 0.02, {}, undefined,
        () => new Promise(() => {})), /таймаута/);
    await assert.rejects(requestProxy('generate', { stream: true }, new AbortController(), 0.03, {}, undefined,
        async () => response([event({ content: 'partial' }), done], 80)), /таймаута/);
});

test('explicit cancellation interrupts reading and cancels the stream', async () => {
    const controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(event({ content: 'partial' }))); },
        cancel() { cancelled = true; } });
    const promise = requestProxy('generate', { stream: true }, controller, 1, {},
        () => controller.abort('cancel'), async () => new Response(body));
    await assert.rejects(promise, /отменён/);
    assert.equal(cancelled, true);
});

test('JSON fallback and non-stream requests preserve the request and independent authorization', async () => {
    for (const stream of [true, false]) {
        let captured;
        const result = await requestProxy('generate', { stream, custom_include_headers: '{"Authorization":"Bearer fake"}' },
            new AbortController(), 1, { 'X-CSRF-Token': 'csrf' }, undefined, async (url, init) => {
                captured = { url, ...init };
                return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'JSON ответ' } }] });
            });
        assert.equal(parseCompletion(result), 'JSON ответ');
        assert.equal(captured.url, '/api/backends/chat-completions/generate');
        assert.equal(JSON.parse(captured.body).stream, stream);
        assert.equal(captured.headers['X-CSRF-Token'], 'csrf');
        assert.equal(JSON.parse(JSON.parse(captured.body).custom_include_headers).Authorization, 'Bearer fake');
    }
});

test('HTTP and JSON error responses stay errors instead of becoming editable text', async () => {
    await assert.rejects(requestProxy('generate', { stream: true }, new AbortController(), 1, {}, undefined,
        async () => new Response('bad', { status: 502 })), /502/);
    await assert.rejects(requestProxy('generate', { stream: true }, new AbortController(), 1, {}, undefined,
        async () => Response.json({ error: true })), /ошибку/);
});
