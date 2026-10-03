import {
    MODULE, DEFAULTS, normalizeBaseUrl, validateConfig, buildMessages, buildReviewMessages, makeProxyBody,
    parseCompletion, captureTarget, assertTarget, replaceText, restoreText, collectEvidence,
} from './core.js';
import { requestProxy } from './transport.js';
import { auditCandidate, issueSummary } from './audit.js';

const ctx = () => SillyTavern.getContext();
let settings, panel, rules, epoch = 0, generationActive = false, job = null, pending = null;
let apiKey = ''; // Never saved in extension settings, exports, or browser storage.
const automaticQueue = new Map();
let flushTimer;
const say = (text, kind = 'info') => {
    const status = panel?.querySelector('[data-status]');
    if (status) status.textContent = text;
    if (kind === 'error') globalThis.toastr?.error(text, 'Text Polisher');
};
const notifyError = error => say(error instanceof Error ? error.message : 'Не удалось выполнить действие.', 'error');

function button(text, handler, title = '') {
    const element = document.createElement('button');
    element.type = 'button'; element.className = 'menu_button tp-button';
    element.textContent = text; element.title = title;
    element.addEventListener('click', () => Promise.resolve().then(handler).catch(notifyError));
    return element;
}

function field(parent, labelText, key, type = 'text', options = {}) {
    const label = document.createElement('label'); label.className = 'tp-field';
    const text = document.createElement('span'); text.textContent = labelText;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.dataset.setting = key; input.className = type === 'checkbox' ? '' : 'text_pole';
    if (type === 'checkbox') { input.checked = Boolean(settings[key]); label.append(input, text); }
    else { input.value = settings[key]; label.append(text, input); }
    for (const [attr, value] of Object.entries(options)) input.setAttribute(attr, value);
    input.addEventListener('input', () => {
        settings[key] = type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value;
        ctx().saveSettingsDebounced();
        if (key === 'enabled' && !input.checked) cancelWork('Автоматическая редактура выключена.');
        if (key === 'review' && !input.checked) cancelWork('Второй проход отключён. Текущая редактура отменена.');
    });
    parent.append(label);
    return input;
}

function group(parent, title) {
    const details = document.createElement('details'); details.className = 'tp-section';
    const summary = document.createElement('summary'); summary.textContent = title;
    details.append(summary); parent.append(details); return details;
}

function createPanel() {
    panel = document.createElement('div'); panel.id = 'text_polisher_settings'; panel.className = 'tp-panel';
    const drawer = document.createElement('div'); drawer.className = 'inline-drawer';
    const toggle = document.createElement('div'); toggle.className = 'inline-drawer-toggle inline-drawer-header';
    toggle.innerHTML = '<b>Text Polisher · Редактор ответов</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>';
    const body = document.createElement('div'); body.className = 'inline-drawer-content';
    drawer.append(toggle, body); panel.append(drawer);
    field(body, 'Автоматически редактировать новые ответы ИИ', 'enabled', 'checkbox');
    field(body, 'Предпросмотр перед заменой', 'preview', 'checkbox');
    const modeHint = document.createElement('p'); modeHint.className = 'tp-hint';
    modeHint.textContent = 'Без галочки предпросмотра готовый результат заменит ответ. Оригинал можно вернуть. С включённым вторым проходом редактура использует два API-запроса.';
    body.append(modeHint);

    const connection = group(body, 'Подключение API'); connection.open = true;
    const providers = document.createElement('div'); providers.className = 'tp-actions';
    for (const [name, url] of [['rout.my', 'https://api.rout.my/v1'], ['LinkAPI', 'https://linkapi.ai/v1']]) {
        providers.append(button(name, () => {
            cancelWork('Провайдер изменён. Введи его ключ и выбери модель.');
            settings.baseUrl = url; settings.model = ''; apiKey = '';
            panel.querySelector('[data-key]').value = '';
            panel.querySelector('[data-model-list]').replaceChildren();
            syncInputs(); ctx().saveSettingsDebounced();
        }));
    }
    connection.append(providers);
    const base = field(connection, 'Base URL (можно указать любой OpenAI-совместимый API)', 'baseUrl', 'url', { spellcheck: 'false' });
    base.addEventListener('input', () => {
        cancelWork('Адрес API изменён. Введи соответствующий ключ.');
        apiKey = ''; panel.querySelector('[data-key]').value = '';
        panel.querySelector('[data-model-list]').replaceChildren();
    });
    const keyLabel = document.createElement('label'); keyLabel.className = 'tp-field';
    keyLabel.append(document.createTextNode('API-ключ редактора'));
    const keyInput = document.createElement('input'); keyInput.type = 'password'; keyInput.className = 'text_pole';
    keyInput.dataset.key = ''; keyInput.autocomplete = 'off'; keyInput.spellcheck = false;
    keyInput.addEventListener('input', () => { apiKey = keyInput.value.trim(); }); keyLabel.append(keyInput); connection.append(keyLabel);
    const keyHint = document.createElement('p'); keyHint.className = 'tp-hint';
    keyHint.textContent = 'Ключ действует до перезагрузки страницы. Основное подключение Таверны не меняется. Запрос идёт через сервер SillyTavern; CORS провайдера не нужен.';
    connection.append(keyHint);
    field(connection, 'ID модели (из каталога либо вручную)', 'model', 'text', { list: 'tp-models', spellcheck: 'false' });
    const list = document.createElement('datalist'); list.id = 'tp-models'; list.dataset.modelList = ''; connection.append(list);
    connection.append(button('Загрузить модели / проверить ключ', loadModels));
    field(connection, 'Стриминг ответа редактора', 'stream', 'checkbox');
    const streamHint = document.createElement('p'); streamHint.className = 'tp-hint';
    streamHint.textContent = 'Текст поступает частями в поток ниже. В стриминге таймаут отсчитывается между порциями данных. Замена ответа и предпросмотр доступны после полного завершения.';
    connection.append(streamHint);

    const ruleOptions = group(body, 'Правила редактора');
    field(ruleOptions, 'Основной BAN LIST', 'basic', 'checkbox');
    field(ruleOptions, 'Расширенные запреты B1–B10 / S1–S10 (строже основного списка)', 'extended', 'checkbox');
    field(ruleOptions, 'Инициатива персонажа / убрать передачу хода', 'agency', 'checkbox');
    field(ruleOptions, 'Проверять эпитеты: одно точное определение, без цепочек', 'epithets', 'checkbox');
    field(ruleOptions, 'Второй проход: полный аудит банов, верность оригиналу и плавность (ещё один API-запрос)', 'review', 'checkbox');
    field(ruleOptions, 'Блокировать замену при явных банах и повреждении структуры', 'strictChecks', 'checkbox');
    const strictHint = document.createElement('p'); strictHint.className = 'tp-hint';
    strictHint.textContent = 'Второй проход сравнивает правку с оригиналом и сохраняет живой голос. Локальная проверка ловит часть явных форм из расширенного списка и повреждение тегов/rs_metrics. Смысловые клише проверяет модель; абсолютной гарантии нет.';
    ruleOptions.append(strictHint);
    field(ruleOptions, 'Дополнительные пожелания редактору', 'customRules', 'textarea', { rows: '6', placeholder: 'Например: сохранять длинные реплики; не менять обращения.' });
    ruleOptions.append(button('Открыть активные правила', showRules));

    const advanced = group(body, 'Контекст и параметры');
    field(advanced, 'Передавать карточку говорящего персонажа', 'includeCard', 'checkbox');
    field(advanced, 'Передавать карточку пользователя (активную персону)', 'includePersona', 'checkbox');
    field(advanced, 'Предыдущих сообщений в контексте', 'contextMessages', 'number', { min: '0', max: '30', step: '1' });
    field(advanced, 'Температура', 'temperature', 'number', { min: '0', max: '2', step: '0.05' });
    field(advanced, 'Лимит выходных токенов редактора', 'maxTokens', 'number', { min: '256', max: '65536', step: '256' });
    field(advanced, 'Таймаут ожидания / паузы стрима, секунд', 'timeout', 'number', { min: '10', max: '600', step: '10' });
    const evidenceHint = document.createElement('p'); evidenceHint.className = 'tp-hint';
    evidenceHint.textContent = 'В API отправляются ответ, активные правила и выбранные данные контекста. По умолчанию — 5 предыдущих сообщений для проверки поз и движений; редактируется только текущий ответ. Lorebook и скрытые рассуждения не отправляются.';
    advanced.append(evidenceHint);
    const actions = document.createElement('div'); actions.className = 'tp-actions';
    actions.append(button('Редактировать последний ответ', () => edit(lastAssistantId(), false)),
        button('Вернуть оригинал', () => restore(lastAssistantId())), button('Отменить запрос', () => cancelWork('Запрос отменён.')));
    body.append(actions);
    const status = document.createElement('p'); status.dataset.status = ''; status.className = 'tp-status'; status.setAttribute('role', 'status');
    status.textContent = 'Введи ключ, выбери модель и начни с ручной редактуры.'; body.append(status);
    const streamView = group(body, 'Поток редактора — промежуточный текст');
    streamView.dataset.streamView = ''; streamView.hidden = true; streamView.open = true;
    const streamText = document.createElement('textarea'); streamText.className = 'text_pole tp-stream-text';
    streamText.dataset.streamText = ''; streamText.readOnly = true; streamText.spellcheck = false;
    streamText.setAttribute('aria-label', 'Промежуточный текст редактора'); streamView.append(streamText);
    (document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings')).append(panel);
}

function syncInputs() {
    for (const input of panel.querySelectorAll('[data-setting]')) {
        if (input.type === 'checkbox') input.checked = settings[input.dataset.setting];
        else input.value = settings[input.dataset.setting];
    }
}

async function getRules() {
    if (rules) return rules;
    const values = await Promise.all(['basic', 'extended', 'agency'].map(async name => {
        const response = await fetch(new URL(`./rules/${name}.txt`, import.meta.url));
        if (!response.ok) throw new Error(`Не удалось загрузить rules/${name}.txt. Проверь установку расширения.`);
        return [name, await response.text()];
    }));
    rules = Object.fromEntries(values); return rules;
}

async function apiRequest(path, body, controller, timeout, onProgress) {
    return requestProxy(path, body, controller, timeout, ctx().getRequestHeaders(), onProgress);
}

async function loadModels() {
    if (job) throw new Error('Дождись завершения запроса или отмени его.');
    if (!apiKey) throw new Error('Введи API-ключ.');
    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    const active = { controller: new AbortController() }; job = active;
    say('Загружаю каталог моделей…');
    try {
        const data = await apiRequest('status', {
            chat_completion_source: 'custom', custom_url: baseUrl,
            custom_include_headers: JSON.stringify({ Authorization: `Bearer ${apiKey}` }),
        }, active.controller, 30);
        if (job !== active || active.controller.signal.aborted) return;
        const ids = [...new Set((data.data ?? []).map(m => m.id).filter(id => typeof id === 'string'))].sort();
        if (!ids.length) throw new Error('Каталог пуст. Можно вписать ID модели вручную.');
        const list = panel.querySelector('[data-model-list]'); list.replaceChildren();
        for (const id of ids) { const option = document.createElement('option'); option.value = id; list.append(option); }
        say(`Ключ принят. Моделей: ${ids.length}. Выбери ID в поле модели (каталог может включать модели без Chat Completions).`);
    } finally { if (job === active) job = null; drainQueue(); }
}

function lastAssistantId() {
    const chat = ctx().chat;
    for (let id = chat.length - 1; id >= 0; id--) if (!chat[id].is_user && !chat[id].is_system && chat[id].mes?.trim()) return id;
    throw new Error('В чате пока нет ответа персонажа.');
}

async function persist(target) {
    const context = ctx();
    context.updateMessageBlock(target.id, target.message);
    addMessageButtons(target.id);
    await context.saveChat();
    // A dedicated event avoids making the new reply enter the editor again.
    await context.eventSource.emit('text_polisher:message_updated', target.id);
}

async function apply(target, result, model) {
    if (generationActive) throw new Error('Дождись окончания генерации Таверны.');
    if (!replaceText(ctx(), target, epoch, result, model)) { say('Изменений нет.'); return; }
    try { await persist(target); }
    catch { throw new Error('Текст заменён в текущем чате, но сохранение или обработчик расширения завершился ошибкой. Оригинал доступен через откат; проверь журнал сервера.'); }
    say('Ответ заменён. Оригинал сохранён для этого свайпа.');
}

async function edit(id, automatic, captured = null) {
    if (generationActive) throw new Error('Дождись окончания генерации Таверны.');
    if (job || pending) throw new Error('Сначала закончи текущую редактуру или закрой предпросмотр.');
    const config = validateConfig(structuredClone(settings), apiKey);
    const requestKey = apiKey;
    const target = captured ?? captureTarget(ctx(), id, epoch);
    assertTarget(ctx(), target, epoch);
    const evidence = collectEvidence(ctx(), target, config);
    const active = { target, controller: new AbortController() }; job = active;
    const streamView = panel.querySelector('[data-stream-view]');
    const streamText = panel.querySelector('[data-stream-text]');
    streamView.hidden = !config.stream; streamText.value = '';
    let lastProgress = 0, pass = 1;
    const progress = ({ text }) => {
        if (job !== active || active.controller.signal.aborted) return;
        const now = Date.now();
        if (now - lastProgress < 100) return;
        lastProgress = now;
        const follow = streamText.scrollTop + streamText.clientHeight >= streamText.scrollHeight - 30;
        streamText.value = text;
        if (follow) streamText.scrollTop = streamText.scrollHeight;
        const stage = config.review ? `Проход ${pass}/2. ` : '';
        say(stage + (text ? `Получаю редактуру ответа №${id + 1}: ${text.length} символов…` : `Модель обрабатывает ответ №${id + 1}; поток активен…`));
    };
    say(`Редактирую ответ №${id + 1}…`);
    try {
        const loaded = await getRules();
        if (job !== active || active.controller.signal.aborted) return;
        const messages = buildMessages(config, loaded, target.original, evidence);
        const data = await apiRequest('generate', makeProxyBody(config, requestKey, messages), active.controller, config.timeout, progress);
        if (job !== active || active.controller.signal.aborted) return;
        let result = parseCompletion(data);
        if (config.review) {
            assertTarget(ctx(), target, epoch);
            pass = 2;
            say(`Второй проход ответа №${id + 1}: баны, верность оригиналу и плавность…`);
            streamText.value = ''; lastProgress = 0;
            const reviewed = await apiRequest('generate', makeProxyBody(config, requestKey,
                buildReviewMessages(config, loaded, target.original, result, evidence)), active.controller, config.timeout, progress);
            if (job !== active || active.controller.signal.aborted) return;
            result = parseCompletion(reviewed);
        }
        if (config.stream) streamText.value = result;
        assertTarget(ctx(), target, epoch);
        const issues = config.strictChecks ? auditCandidate(target.original, result, config, loaded) : [];
        if (issues.length) {
            showPreview(target, result, config.model, config, loaded, issues);
            return;
        }
        if (result === target.original) { say('Редактор оставил ответ без изменений.'); return; }
        if (config.preview) showPreview(target, result, config.model, config, loaded);
        else await apply(target, result, config.model);
    } catch (error) {
        if (job === active) { streamText.value = ''; streamView.hidden = true; }
        if (job === active) notifyError(error);
    } finally { if (job === active) job = null; drainQueue(); }
}

function openDialog(title, className = '') {
    const dialog = document.createElement('dialog'); dialog.className = `tp-dialog ${className}`;
    const heading = document.createElement('h3'); heading.textContent = title; dialog.append(heading);
    document.body.append(dialog); return dialog;
}

function showPreview(target, result, model, config, loaded, initialIssues = []) {
    const dialog = openDialog(`Редактура ответа №${target.id + 1}`, 'tp-preview');
    const columns = document.createElement('div'); columns.className = 'tp-columns';
    const makeColumn = (title, text, readOnly) => {
        const label = document.createElement('label'); label.textContent = title;
        const area = document.createElement('textarea'); area.className = 'text_pole'; area.value = text; area.readOnly = readOnly;
        area.spellcheck = false; area.setAttribute('aria-label', title); label.append(area); columns.append(label); return area;
    };
    makeColumn('Исходник', target.original, true);
    const edited = makeColumn('После редактуры — можно поправить вручную', result, false);
    dialog.append(columns);
    const error = document.createElement('p'); error.setAttribute('role', 'status'); dialog.append(error);
    error.textContent = initialIssues.length ? 'Автозамена заблокирована. ' + issueSummary(initialIssues) : '';
    const actions = document.createElement('div'); actions.className = 'tp-actions';
    const accept = button('Заменить ответ', async () => {
        accept.disabled = true;
        try {
            const issues = config.strictChecks ? auditCandidate(target.original, edited.value, config, loaded) : [];
            if (issues.length) throw new Error('Исправь замечания перед заменой. ' + issueSummary(issues));
            await apply(target, edited.value, model); dialog.close();
        }
        catch (e) { error.textContent = e.message; notifyError(e); }
        finally { accept.disabled = false; }
    });
    actions.append(accept, button('Оставить исходник', () => dialog.close())); dialog.append(actions);
    pending = { dialog, target };
    dialog.addEventListener('close', () => { if (pending?.dialog === dialog) pending = null; dialog.remove(); drainQueue(); });
    dialog.showModal(); say(initialIssues.length ? 'Проверка нашла нарушения. Исходник сохранён; исправь текст в предпросмотре.' : 'Предпросмотр готов. Можно исправить текст перед применением.');
}

async function showRules() {
    const loaded = await getRules();
    const dialog = openDialog('Активные правила редактора');
    const area = document.createElement('textarea'); area.className = 'text_pole tp-rule-view'; area.readOnly = true;
    area.value = buildMessages(settings, loaded, '', {})[0].content; dialog.append(area);
    dialog.append(button('Закрыть', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
}

async function restore(id) {
    if (generationActive) throw new Error('Дождись окончания генерации.');
    cancelWork('Редактура отменена перед откатом.');
    const target = captureTarget(ctx(), id, epoch); restoreText(target.message);
    await persist(target); say('Оригинал возвращён.');
}

function cancelWork(message, keepQueue = false) {
    job?.controller.abort('cancel'); job = null;
    const streamText = panel?.querySelector('[data-stream-text]');
    if (streamText) streamText.value = '';
    const streamView = panel?.querySelector('[data-stream-view]');
    if (streamView) streamView.hidden = true;
    pending?.dialog.close(); pending = null;
    if (!keepQueue) automaticQueue.clear();
    clearTimeout(flushTimer);
    if (message) say(message);
}

function enqueue(id, type) {
    if (!settings.enabled || ['first_message', 'impersonate', 'quiet'].includes(type)) return;
    if (ctx().streamingProcessor?.abortController?.signal.aborted) return;
    try {
        const target = captureTarget(ctx(), Number(id), epoch);
        automaticQueue.set(target.message, target);
        drainQueue();
    } catch { /* System/tool/empty messages are not editable. */ }
}

function drainQueue() {
    clearTimeout(flushTimer);
    if (!settings.enabled || generationActive || job || pending || !automaticQueue.size) return;
    // Defer until core has finished rendering and initializing swipe metadata.
    flushTimer = setTimeout(() => {
        if (generationActive || job || pending) return;
        const [message, target] = automaticQueue.entries().next().value ?? [];
        if (!target) return;
        automaticQueue.delete(message);
        try { assertTarget(ctx(), target, epoch); }
        catch { drainQueue(); return; }
        void edit(target.id, true, target).catch(notifyError).finally(drainQueue);
    }, 0);
}

function addMessageButtons(id) {
    const node = document.querySelector(`#chat .mes[mesid="${Number(id)}"]`);
    const message = ctx().chat[Number(id)];
    if (!node || !message || message.is_user || message.is_system || node.querySelector('.tp-message-actions')) return;
    const host = node.querySelector('.extraMesButtons') ?? node.querySelector('.mes_buttons');
    if (!host) return;
    const actions = document.createElement('span'); actions.className = 'tp-message-actions';
    const editButton = button('✎', () => edit(Number(node.getAttribute('mesid')), false), 'Редактировать через API');
    const restoreButton = button('↶', () => restore(Number(node.getAttribute('mesid'))), 'Вернуть оригинал этого свайпа');
    actions.append(editButton, restoreButton); host.append(actions);
}

function refreshButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(node => addMessageButtons(Number(node.getAttribute('mesid'))));
}

function initialize() {
    if (panel) return;
    const context = ctx();
    settings = context.extensionSettings[MODULE] ??= {};
    for (const [key, value] of Object.entries(DEFAULTS)) if (settings[key] === undefined) settings[key] = value;
    delete settings.apiKey;
    createPanel(); refreshButtons();
    const events = context.eventTypes ?? context.event_types;
    context.eventSource.on(events.MESSAGE_RECEIVED, enqueue);
    context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, id => addMessageButtons(id));
    context.eventSource.on(events.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun || type === 'quiet') return;
        generationActive = true; cancelWork(undefined, true);
    });
    context.eventSource.on(events.GENERATION_ENDED, () => { generationActive = false; drainQueue(); });
    context.eventSource.on(events.GENERATION_STOPPED, () => { generationActive = false; cancelWork('Генерация остановлена; автоматическая редактура отменена.'); });
    context.eventSource.on(events.CHAT_CHANGED, () => { epoch++; generationActive = false; cancelWork(); refreshButtons(); });
    for (const event of [events.MESSAGE_SWIPED, events.MESSAGE_EDITED, events.MESSAGE_DELETED]) {
        if (event) context.eventSource.on(event, () => { epoch++; cancelWork(); refreshButtons(); });
    }
    // Covers lazy-loaded history and core re-renders without coupling to private UI methods.
    const chatNode = document.querySelector('#chat');
    if (chatNode) {
        const observer = new MutationObserver(records => {
            if (records.some(r => [...r.addedNodes].some(n => n.nodeType === 1 && (n.matches?.('.mes') || n.querySelector?.('.mes'))))) refreshButtons();
        });
        observer.observe(chatNode, { childList: true, subtree: true });
    }
}

if (document.querySelector('#extensions_settings2, #extensions_settings')) initialize();
else {
    const context = ctx(); const events = context.eventTypes ?? context.event_types;
    context.eventSource.on(events.APP_READY ?? events.APP_INITIALIZED, initialize);
}
