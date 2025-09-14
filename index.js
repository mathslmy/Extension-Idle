import {
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { promptQuietForLoudResponse, sendNarratorMessage } from '../../../slash-commands.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const extensionName = 'third-party/Extension-Idle';

let idleTimer = null;
let repeatCount = 0;

// ✅ 记录 Daily 上次触发日期，避免一天触发多次
let lastDailyTrigger = {};

let defaultSettings = {
    enabled: false,
    timer: 120,
    prompts: [
        '*stands silently, looking deep in thought*',
        '*pauses, eyes wandering over the surroundings*',
        '*hesitates, appearing lost for a moment*',
        '*takes a deep breath, collecting their thoughts*',
        '*gazes into the distance, seemingly distracted*',
        '*remains still, absorbing the ambiance*',
        '*lingers in silence, a contemplative look on their face*',
        '*stops, fingers brushing against an old memory*',
        '*seems to drift into a momentary daydream*',
        '*waits quietly, allowing the weight of the moment to settle*',
    ],
    useContinuation: true,
    useRegenerate: false,
    useImpersonation: false,
    useSwipe: false,
    repeats: 2,
    randomTime: false,
    timerMin: 60,
    includePrompt: false,
    scheduleOnceList: [],
    scheduleDailyList: [],
    // ✅ 新增：局部 Idle Timer 开关
    useIdleTimer: true,
};

// --- 更新时间显示 ---
function updateNextTimeDisplay(date) {
    if (!date) {
        $('#idle_next_time').text('--');
    } else {
        $('#idle_next_time').text(date.toLocaleString());
    }
}

// Load settings
async function loadSettings() {
    if (!extension_settings.idle) {
        extension_settings.idle = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings.idle.hasOwnProperty(key)) {
            extension_settings.idle[key] = value;
        }
    }
    populateUIWithSettings();
}

// Populate UI
function populateUIWithSettings() {
    $('#idle_timer').val(extension_settings.idle.timer).trigger('input');
    $('#idle_prompts').val(extension_settings.idle.prompts.join('\n')).trigger('input');
    $('#idle_use_continuation').prop('checked', extension_settings.idle.useContinuation).trigger('input');
    $('#idle_use_regenerate').prop('checked', extension_settings.idle.useRegenerate).trigger('input');
    $('#idle_use_impersonation').prop('checked', extension_settings.idle.useImpersonation).trigger('input');
    $('#idle_use_swipe').prop('checked', extension_settings.idle.useSwipe).trigger('input');
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled).trigger('input');
    $('#idle_repeats').val(extension_settings.idle.repeats).trigger('input');
    $('#idle_random_time').prop('checked', extension_settings.idle.randomTime).trigger('input');
    $('#idle_timer_min').val(extension_settings.idle.timerMin).trigger('input');
    $('#idle_include_prompt').prop('checked', extension_settings.idle.includePrompt).trigger('input');
    // ✅ 新增：局部开关
    $('#idle_use_timer').prop('checked', extension_settings.idle.useIdleTimer).trigger('input');
    renderSchedules();
    updateNextTimeDisplay(null);
}

// Reset timer
function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    let context = getContext();
    if (!context.characterId && !context.groupID) return;
    if (!extension_settings.idle.enabled) return;
    // ✅ 局部 Idle Timer 开关
    if (!extension_settings.idle.useIdleTimer) return;

    let targetTime;
    if (extension_settings.idle.randomTime) {
        let min = extension_settings.idle.timerMin;
        let max = extension_settings.idle.timer;
        min = parseInt(min);
        max = parseInt(max);
        let randomTime = (Math.random() * (max - min + 1)) + min;
        targetTime = new Date(Date.now() + randomTime * 1000);
        idleTimer = setTimeout(sendIdlePrompt, 1000 * randomTime);
    } else {
        targetTime = new Date(Date.now() + extension_settings.idle.timer * 1000);
        idleTimer = setTimeout(sendIdlePrompt, 1000 * extension_settings.idle.timer);
    }
    updateNextTimeDisplay(targetTime);
}

// ✅ 统一生成完整时间戳
function getFullTimestamp() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
}

// Send idle prompt
async function sendIdlePrompt(customPrompt = '', sendAsOverride = null) {
    if (!extension_settings.idle.enabled) return;
    if ((extension_settings.idle.repeats > 0 && repeatCount >= extension_settings.idle.repeats) || $('#mes_stop').is(':visible')) {
        resetIdleTimer();
        return;
    }

    let promptToSend = customPrompt;
    if (!promptToSend) {
        promptToSend = extension_settings.idle.prompts[
            Math.floor(Math.random() * extension_settings.idle.prompts.length)
        ];
    }

    // ✅ 时间戳始终在开头
    const timestamp = getFullTimestamp();
    promptToSend = `[${timestamp}] ${promptToSend}`;

    // ✅ 强制角色发言
    promptQuietForLoudResponse('char', promptToSend);

    repeatCount++;
    resetIdleTimer();
}

// Send prompt (special cases only)
function sendPrompt(prompt) {
    clearTimeout(idleTimer);
    $('#send_textarea').off('input');

    if (extension_settings.idle.useRegenerate) {
        $('#option_regenerate').trigger('click');
    } else if (extension_settings.idle.useContinuation) {
        if (prompt) {
            const timestamp = getFullTimestamp();
            sendNarratorMessage('', `[${timestamp}] ${prompt}`);
        }
        $('#option_continue').trigger('click');
    } else if (extension_settings.idle.useImpersonation) {
        $('#option_impersonate').trigger('click');
    } else if (extension_settings.idle.useSwipe) {
        $('.last_mes .swipe_right').click();
    } else {
        const timestamp = getFullTimestamp();
        promptQuietForLoudResponse('char', `[${timestamp}] ${prompt}`);
    }
}

// Load settings HTML
async function loadSettingsHTML() {
    const settingsHtml = await renderExtensionTemplateAsync(extensionName, 'dropdown');
    const getContainer = () => $(document.getElementById('idle_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(settingsHtml);
}

// Update setting
function updateSetting(elementId, property, isCheckbox = false) {
    let value = $(`#${elementId}`).val();
    if (isCheckbox) {
        value = $(`#${elementId}`).prop('checked');
    }
    if (property === 'prompts') {
        value = value.split('\n');
    }
    extension_settings.idle[property] = value;
    saveSettingsDebounced();
}

// Attach listener
function attachUpdateListener(elementId, property, isCheckbox = false) {
    $(`#${elementId}`).on('input', debounce(() => {
        updateSetting(elementId, property, isCheckbox);
    }, 250));
}

// Handle enabled
function handleIdleEnabled() {
    if (!extension_settings.idle.enabled) {
        clearTimeout(idleTimer);
        removeIdleListeners();
        updateNextTimeDisplay(null);
    } else {
        resetIdleTimer();
        attachIdleListeners();
    }
}

// Setup listeners
function setupListeners() {
    const settingsToWatch = [
        ['idle_timer', 'timer'],
        ['idle_prompts', 'prompts'],
        ['idle_use_continuation', 'useContinuation', true],
        ['idle_use_regenerate', 'useRegenerate', true],
        ['idle_use_impersonation', 'useImpersonation', true],
        ['idle_use_swipe', 'useSwipe', true],
        ['idle_enabled', 'enabled', true],
        ['idle_repeats', 'repeats'],
        ['idle_random_time', 'randomTime', true],
        ['idle_timer_min', 'timerMin'],
        ['idle_include_prompt', 'includePrompt', true],
        // ✅ 新增局部开关
        ['idle_use_timer', 'useIdleTimer', true],
    ];
    settingsToWatch.forEach(setting => {
        attachUpdateListener(...setting);
    });

    $('#idle_enabled').on('input', debounce(handleIdleEnabled, 250));
    if (extension_settings.idle.enabled) {
        attachIdleListeners();
    }

    $('#idle_use_continuation, #idle_use_regenerate, #idle_use_impersonation, #idle_use_swipe').on('change', function() {
        const checkboxId = $(this).attr('id');
        if ($(this).prop('checked')) {
            if (checkboxId !== 'idle_use_continuation') {
                $('#idle_use_continuation').prop('checked', false);
                extension_settings.idle.useContinuation = false;
            }
            if (checkboxId !== 'idle_use_regenerate') {
                $('#idle_use_regenerate').prop('checked', false);
                extension_settings.idle.useRegenerate = false;
            }
            if (checkboxId !== 'idle_use_impersonation') {
                $('#idle_use_impersonation').prop('checked', false);
                extension_settings.idle.useImpersonation = false;
            }
            if (checkboxId !== 'idle_use_swipe') {
                $('#idle_use_swipe').prop('checked', false);
                extension_settings.idle.useSwipe = false;
            }
            saveSettingsDebounced();
        }
    });
}

// Idle activity
const debouncedActivityHandler = debounce(() => {
    resetIdleTimer();
    repeatCount = 0;
}, 250);

function attachIdleListeners() {
    $(document).on('click keypress', debouncedActivityHandler);
    document.addEventListener('keydown', debouncedActivityHandler);
}

function removeIdleListeners() {
    $(document).off('click keypress', debouncedActivityHandler);
    document.removeEventListener('keydown', debouncedActivityHandler);
}

// Toggle idle
function toggleIdle() {
    extension_settings.idle.enabled = !extension_settings.idle.enabled;
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled);
    $('#idle_enabled').trigger('input');
    toastr.info(`Idle mode ${extension_settings.idle.enabled ? 'enabled' : 'disabled'}.`);
    resetIdleTimer();
}

// --- 多条调度逻辑 ---
function renderSchedules() {
    const onceList = $('#idle_schedule_once_list').empty();
    extension_settings.idle.scheduleOnceList.forEach((item, index) => {
        onceList.append(`
            <div class="schedule-entry" data-index="${index}">
                <input type="checkbox" class="once-enabled" ${item.enabled ? 'checked' : ''}>
                <input type="datetime-local" class="once-time" value="${item.time || ''}">
                <input type="text" class="once-prompt" value="${item.prompt || ''}" placeholder="Prompt">
                <button type="button" class="once-delete">✕</button>
            </div>
        `);
    });

    const dailyList = $('#idle_schedule_daily_list').empty();
    extension_settings.idle.scheduleDailyList.forEach((item, index) => {
        dailyList.append(`
            <div class="schedule-entry" data-index="${index}">
                <input type="checkbox" class="daily-enabled" ${item.enabled ? 'checked' : ''}>
                <input type="time" class="daily-time" value="${item.time || ''}">
                <input type="text" class="daily-prompt" value="${item.prompt || ''}" placeholder="Prompt">
                <button type="button" class="daily-delete">✕</button>
            </div>
        `);
    });
}

function setupScheduleListeners() {
    $('#idle_add_schedule_once').on('click', () => {
        extension_settings.idle.scheduleOnceList.push({ enabled: true, time: '', prompt: '' });
        saveSettingsDebounced();
        renderSchedules();
    });

    $('#idle_add_schedule_daily').on('click', () => {
        extension_settings.idle.scheduleDailyList.push({ enabled: true, time: '', prompt: '' });
        saveSettingsDebounced();
        renderSchedules();
    });

    $('#idle_schedule_once_list').on('input change click', '.schedule-entry', function(e) {
        const index = $(this).data('index');
        const entry = extension_settings.idle.scheduleOnceList[index];
        if (e.target.classList.contains('once-enabled')) entry.enabled = e.target.checked;
        if (e.target.classList.contains('once-time')) entry.time = e.target.value;
        if (e.target.classList.contains('once-prompt')) entry.prompt = e.target.value;
        if (e.target.classList.contains('once-delete')) {
            extension_settings.idle.scheduleOnceList.splice(index, 1);
            renderSchedules();
        }
        saveSettingsDebounced();
    });

    $('#idle_schedule_daily_list').on('input change click', '.schedule-entry', function(e) {
        const index = $(this).data('index');
        const entry = extension_settings.idle.scheduleDailyList[index];
        if (e.target.classList.contains('daily-enabled')) entry.enabled = e.target.checked;
        if (e.target.classList.contains('daily-time')) entry.time = e.target.value;
        if (e.target.classList.contains('daily-prompt')) entry.prompt = e.target.value;
        if (e.target.classList.contains('daily-delete')) {
            extension_settings.idle.scheduleDailyList.splice(index, 1);
            renderSchedules();
        }
        saveSettingsDebounced();
    });
}

// Check schedules
function checkSchedules() {
    const now = new Date();
    let next = null;

    // --- One-Time ---
    extension_settings.idle.scheduleOnceList.forEach(item => {
        if (item.enabled && item.time) {
            const target = new Date(item.time);
            if (!next || target < next) next = target;
            if (now >= target) {
                sendIdlePrompt(item.prompt || '', 'char');
                item.enabled = false;
                saveSettingsDebounced();
            }
        }
    });

    // --- Daily ---
    extension_settings.idle.scheduleDailyList.forEach((item, index) => {
        if (item.enabled && item.time) {
            const [h, m] = item.time.split(':').map(Number);

            // 生成今天的目标时间
            const target = new Date();
            target.setHours(h, m, 0, 0);

            // 如果今天已经过了，就推到明天
            if (target <= now) {
                target.setDate(target.getDate() + 1);
            }

            // 更新下一次触发显示
            if (!next || target < next) next = target;

            // ✅ 到点触发（允许 ±1 分钟容差）
            if (Math.abs(now - target) < 60000) {
                if (lastDailyTrigger[index] !== now.toDateString()) {
                    sendIdlePrompt(item.prompt || '', 'char');
                    lastDailyTrigger[index] = now.toDateString();
                }
            }
        }
    });

    updateNextTimeDisplay(next);
}

// Init
jQuery(async () => {
    await loadSettingsHTML();
    loadSettings();
    setupListeners();
    setupScheduleListeners();
    renderSchedules();
    if (extension_settings.idle.enabled) {
        resetIdleTimer();
    }
    registerSlashCommand('idle', toggleIdle, [], '– toggles idle mode', true, true);
    setInterval(checkSchedules, 60 * 1000);
});