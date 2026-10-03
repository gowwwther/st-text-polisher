import { parseCompletion } from './core.js';

function abortError(signal) {
    return new Error(signal.reason === 'timeout'
        ? 'Редактор не присылал данные дольше таймаута. Исходник сохранён.' : 'Запрос отменён.');
}

function withAbort(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError(signal));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

// Decode SSE ourselves: UTF-8 characters, lines and JSON can cross arbitrary network chunks.
export async function readCompletionStream(response, { signal, onActivity = () => {}, onProgress = () => {} }) {
    if (!response.body?.getReader) throw new Error('Сервер не предоставил поток ответа. Отключи стриминг для этого API.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', dataLines = [], eventType = '', text = '', finishReason = null;
    let doneMarker = false, events = 0, bytes = 0;
    const dispatch = () => {
        const payload = dataLines.join('\n');
        const type = eventType;
        dataLines = []; eventType = '';
        if (!payload.trim()) return;
        if (payload.trim() === '[DONE]') { doneMarker = true; return; }
        let data;
        try { data = JSON.parse(payload); }
        catch { throw new Error('Повреждённый поток API. Незавершённая редактура не применена.'); }
        if (type === 'error' || data?.error) throw new Error('Провайдер вернул ошибку в потоке. Исходник сохранён.');
        const choice = data?.choices?.find(c => c.index === 0 || c.index === undefined);
        if (!choice) return; // Usage-only and provider metadata events.
        const delta = choice.delta ?? {};
        if (delta.refusal || choice.finish_reason === 'content_filter') {
            throw new Error('Модель отказалась редактировать этот ответ. Исходник сохранён.');
        }
        if (delta.tool_calls?.length || delta.function_call || choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
            throw new Error('Модель вернула вызов инструмента вместо текста. Исходник сохранён.');
        }
        if (delta.content != null && typeof delta.content !== 'string') throw new Error('Неподдерживаемый формат текста в потоке.');
        if (delta.content) {
            if (finishReason !== null) throw new Error('API прислал текст после завершения ответа. Исходник сохранён.');
            text += delta.content;
        }
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        if (finishReason === 'length' || finishReason === 'max_tokens') {
            throw new Error('Ответ редактора обрезан лимитом токенов. Увеличь лимит; исходник сохранён.');
        }
        events++;
        // reasoning_content/reasoning keep the connection active but are never displayed or saved.
        onProgress({ text, events });
    };
    const line = value => {
        if (value === '') { dispatch(); return; }
        if (value.startsWith(':')) return;
        const colon = value.indexOf(':');
        const name = colon < 0 ? value : value.slice(0, colon);
        let valuePart = colon < 0 ? '' : value.slice(colon + 1);
        if (valuePart.startsWith(' ')) valuePart = valuePart.slice(1);
        if (name === 'data') dataLines.push(valuePart);
        if (name === 'event') eventType = valuePart;
    };
    const consume = eof => {
        while (!doneMarker) {
            const index = buffer.search(/[\r\n]/);
            if (index < 0) break;
            if (!eof && buffer[index] === '\r' && index === buffer.length - 1) break;
            const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
            const value = buffer.slice(0, index);
            buffer = buffer.slice(index + width);
            line(value);
        }
        if (eof && !doneMarker) {
            if (buffer) { line(buffer); buffer = ''; }
            dispatch();
        }
    };
    try {
        while (!doneMarker) {
            const chunk = await withAbort(reader.read(), signal);
            if (chunk.done) { buffer += decoder.decode(); consume(true); break; }
            if (!chunk.value?.byteLength) continue;
            onActivity();
            bytes += chunk.value.byteLength;
            if (bytes > 16 * 1024 * 1024) throw new Error('Поток API слишком большой. Исходник сохранён.');
            buffer += decoder.decode(chunk.value, { stream: true });
            consume(false);
        }
        if (signal.aborted) throw abortError(signal);
        if (!doneMarker && finishReason !== 'stop') {
            throw new Error('Поток оборвался без признака завершения. Частичный текст не применён.');
        }
        if (finishReason !== null && finishReason !== 'stop') throw new Error('Неизвестная причина завершения API. Исходник сохранён.');
        return { choices: [{ finish_reason: finishReason ?? 'stop', message: { content: text } }] };
    } finally {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* An aborted read can still be settling. */ }
    }
}

export async function requestProxy(path, body, controller, timeout, headers, onProgress, fetchImpl = globalThis.fetch) {
    let timer;
    const resetTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort('timeout'), timeout * 1000);
    };
    resetTimeout();
    try {
        const response = await withAbort(fetchImpl(`/api/backends/chat-completions/${path}`, {
            method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        }), controller.signal);
        if (!response.ok) throw new Error(`Ошибка API/сервера (${response.status}). Проверь ключ, URL, модель и баланс.`);
        let data;
        if (body.stream && !response.headers?.get('content-type')?.includes('application/json')) {
            data = await readCompletionStream(response, { signal: controller.signal, onActivity: resetTimeout, onProgress });
            parseCompletion(data); // No truncated, empty, refused or reasoning-only result may be applied.
        } else {
            // Some compatible providers ignore stream:true and return a normal JSON response.
            data = await withAbort(response.json(), controller.signal);
        }
        if (data?.error) throw new Error('Провайдер вернул ошибку. Проверь ключ, модель, баланс и журнал SillyTavern.');
        return data;
    } catch (error) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        throw error;
    } finally { clearTimeout(timer); }
}
