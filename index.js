import {
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { promptQuietForLoudResponse, sendNarratorMessage } from '../../../slash-commands.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const extensionName = 'third-party/Extension-Idle';
let serviceWorkerReady = false;

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
    randomTime: false,
    timerMin: 60,
    includePrompt: false,
    scheduleOnceList: [],
    scheduleDailyList: [],
    useIdleTimer: true,
    sendAs: 'user',
    lastAIReplyTime: null,
};

// --- HTML Template ---
const settingsHTML = `
<div id="idle_container" class="extension-container">
    <details>
        <summary><b>Idle Settings</b></summary>
        <!-- Global Settings -->
        <fieldset>
            <legend>General Settings</legend>
            <label>
                <input type="checkbox" id="idle_enabled">
                Enable Idle
            </label>
            <div>
                <label for="idle_sendAs">Send As:</label>
                <select id="idle_sendAs">
                    <option value="user">User</option>
                    <option value="char">Character</option>
                    <option value="sys">System</option>
                    <option value="raw">Raw</option>
                </select>
            </div>
            <div>
                <label>
                    <input type="checkbox" id="idle_include_prompt">
                    Include Prompt in Message
                </label>
            </div>
            <!-- Next reply time display -->
            <div class="idle-next-time">
                Next event scheduled: <span id="idle_next_time">--</span>
            </div>
        </fieldset>
        <!-- Idle Behaviors -->
        <fieldset>
            <legend>Idle Behaviors</legend>
            <div>
                <label>
                    <input type="checkbox" id="idle_use_timer">
                    Enable Idle Reply
                </label>
            </div>
            <div>
                <label>
                    <input type="checkbox" id="idle_random_time">
                    Use Random Time
                </label>
            </div>
            <div>
                <label for="idle_timer">Idle Timer (seconds):</label>
                <input type="number" id="idle_timer" min="1">
            </div>
            <div>
                <label for="idle_timer_min">Idle Timer Minimum (when random):</label>
                <input type="number" id="idle_timer_min" min="1">
            </div>
            <div>
                <label for="idle_prompts">Prompts (one per line):</label>
                <textarea id="idle_prompts" rows="5"></textarea>
            </div>
            <!-- One-Time Schedules -->
            <fieldset>
                <legend>One-Time Schedules</legend>
                <div id="idle_schedule_once_list"></div>
                <button type="button" id="idle_add_schedule_once">+ Add One-Time Schedule</button>
            </fieldset>
            <!-- Daily Schedules -->
            <fieldset>
                <legend>Daily Schedules</legend>
                <div id="idle_schedule_daily_list"></div>
                <button type="button" id="idle_add_schedule_daily">+ Add Daily Schedule</button>
            </fieldset>
        </fieldset>
    </details>
</div>
`;

// --- Service Worker Communication ---
async function initServiceWorker() {
    try {
        const registration = await navigator.serviceWorker.getRegistration('/hlh-todo-sw.js');
        if (!registration) {
            toastr.error('Idle Extension: Service Worker not found. Please register hlh-todo-sw.js first.');
            return false;
        }

        await navigator.serviceWorker.ready;
        serviceWorkerReady = true;
        toastr.success('Idle Extension: Service Worker connected successfully');
        return true;
    } catch (error) {
        console.error('Failed to initialize service worker:', error);
        toastr.error('Idle Extension: Failed to connect to Service Worker');
        return false;
    }
}

async function sendServiceWorkerMessage(type, data) {
    if (!serviceWorkerReady) {
        console.error('Service Worker not ready');
        toastr.warning('Idle Extension: Service Worker not ready, retrying...');
        await initServiceWorker();
        if (!serviceWorkerReady) return null;
    }

    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
            resolve(event.data);
        };
        
        navigator.serviceWorker.controller?.postMessage({
            type,
            data: { ...data, source: 'idle-extension' }
        }, [channel.port2]);
    });
}

// --- Monitor AI Replies ---
function setupAIReplyMonitor() {
    // Monitor for AI message generation completion
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                // Check if this is an AI message
                if (node.classList && node.classList.contains('mes') && 
                    !node.classList.contains('user_mes')) {
                    // AI message detected
                    extension_settings.idle.lastAIReplyTime = new Date().toISOString();
                    saveSettingsDebounced();
                    console.log('[Idle Extension] AI reply detected, updating next time');
                    updateNextTime();
                }
            });
        });
    });

    // Observe the chat container
    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        observer.observe(chatContainer, {
            childList: true,
            subtree: true
        });
        console.log('[Idle Extension] AI reply monitor started');
    }
}

// --- Unified Next Time Calculation ---
function calculateNextTime() {
    if (!extension_settings.idle.enabled) return null;

    const now = new Date();
    let candidates = [];

    // 1. Calculate next idle reply time
    if (extension_settings.idle.useIdleTimer) {
        const lastReply = extension_settings.idle.lastAIReplyTime 
            ? new Date(extension_settings.idle.lastAIReplyTime) 
            : now;
        
        let delaySeconds;
        if (extension_settings.idle.randomTime) {
            const min = parseInt(extension_settings.idle.timerMin);
            const max = parseInt(extension_settings.idle.timer);
            delaySeconds = Math.floor(Math.random() * (max - min + 1)) + min;
        } else {
            delaySeconds = parseInt(extension_settings.idle.timer);
        }
        
        let nextIdleTime = new Date(lastReply.getTime() + delaySeconds * 1000);
        
        // Check if the calculated time is in the past
        let isDelayed = false;
        if (nextIdleTime < now) {
            console.log('[Idle Extension] Idle reply time is in the past, scheduling for 30s from now with delay prompt');
            nextIdleTime = new Date(now.getTime() + 10000); // 30 seconds from now
            isDelayed = true;
        }
        
        candidates.push({
            time: nextIdleTime,
            type: 'idle_reply',
            data: { isDelayed }
        });
    }

    // 2. Calculate one-time schedules
    extension_settings.idle.scheduleOnceList.forEach((item, index) => {
        if (item.enabled && item.time) {
            const target = new Date(item.time);
            if (target > now) {
                candidates.push({
                    time: target,
                    type: 'once',
                    data: { index, prompt: item.prompt }
                });
            }
        }
    });

    // 3. Calculate daily schedules
    extension_settings.idle.scheduleDailyList.forEach((item, index) => {
        if (item.enabled && item.time) {
            const [h, m] = item.time.split(':').map(Number);
            const target = new Date();
            target.setHours(h, m, 0, 0);
            
            // If time has passed today, schedule for tomorrow
            if (target <= now) {
                target.setDate(target.getDate() + 1);
            }
            
            candidates.push({
                time: target,
                type: 'daily',
                data: { index, prompt: item.prompt }
            });
        }
    });

    // Find the earliest time
    if (candidates.length === 0) return null;
    
    candidates.sort((a, b) => a.time - b.time);
    return candidates[0];
}

// --- Update Next Time ---
async function updateNextTime() {
    const nextEvent = calculateNextTime();
    
    if (!nextEvent) {
        $('#idle_next_time').text('--');
        await sendServiceWorkerMessage('CANCEL_UNIFIED_TIMER', {});
        return;
    }

    const { time, type, data } = nextEvent;
    $('#idle_next_time').text(time.toLocaleString());
    
    const delayMs = time.getTime() - Date.now();
    
    await sendServiceWorkerMessage('SCHEDULE_UNIFIED_TIMER', {
        fireAt: time.getTime(),
        delayMs: delayMs,
        eventType: type,
        eventData: data
    });
    
    console.log(`[Idle Extension] Next event: ${type} at ${time.toLocaleString()}`);
}

// --- Time Formatting ---
function getFullTimestamp() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
}

// --- Send Idle Prompt ---
async function sendIdlePrompt(customPrompt = '', sendAsOverride = null, isDelayed = false) {
    if (!extension_settings.idle.enabled) return;

    if ($('#mes_stop').is(':visible')) {
        // AI is currently generating, reschedule
        console.log('[Idle Extension] AI is generating, rescheduling...');
        setTimeout(() => updateNextTime(), 5000);
        return;
    }

    let promptToSend = customPrompt;
    if (!promptToSend) {
        promptToSend = extension_settings.idle.prompts[
            Math.floor(Math.random() * extension_settings.idle.prompts.length)
        ];
    }

    // Add delayed message if applicable
    if (isDelayed) {
        const delayedMessage = substituteParams('{{char}}之前的信息没发出去，需要告诉{{user}}');
        promptToSend = delayedMessage + ' ' + promptToSend;
    }

    const timestamp = getFullTimestamp();
    promptToSend = `[${timestamp}] ${promptToSend}`;

    const sendAsValue = sendAsOverride || extension_settings.idle.sendAs || 'user';

    if (sendAsValue === 'char') {
        promptQuietForLoudResponse('char', promptToSend);
    } else if (sendAsValue === 'sys') {
        sendNarratorMessage('', promptToSend);
    } else if (sendAsValue === 'raw') {
        $('#send_textarea').val(promptToSend);
        $('#send_button').click();
    } else {
        promptQuietForLoudResponse('user', promptToSend);
    }

    toastr.info(`Idle Extension: Sent ${isDelayed ? 'delayed ' : ''}prompt as ${sendAsValue}`);
    
    // Don't update lastAIReplyTime here - wait for actual AI response
    // Next time will be recalculated after AI responds
}

// --- Handle One-Time Schedule ---
async function handleOnceSchedule(index, prompt) {
    await sendIdlePrompt(prompt || '', 'char', false);
    
    // Disable this schedule
    extension_settings.idle.scheduleOnceList[index].enabled = false;
    saveSettingsDebounced();
    renderSchedules();
}

// --- Handle Daily Schedule ---
async function handleDailySchedule(index, prompt) {
    await sendIdlePrompt(prompt || '', 'char', false);
}

// --- Load Settings ---
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

// --- Populate UI ---
function populateUIWithSettings() {
    $('#idle_timer').val(extension_settings.idle.timer).trigger('input');
    $('#idle_prompts').val(extension_settings.idle.prompts.join('\n')).trigger('input');
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled).trigger('input');
    $('#idle_random_time').prop('checked', extension_settings.idle.randomTime).trigger('input');
    $('#idle_timer_min').val(extension_settings.idle.timerMin).trigger('input');
    $('#idle_include_prompt').prop('checked', extension_settings.idle.includePrompt).trigger('input');
    $('#idle_sendAs').val(extension_settings.idle.sendAs || 'user').trigger('input');
    $('#idle_use_timer').prop('checked', extension_settings.idle.useIdleTimer).trigger('input');
    renderSchedules();
}

// --- Load Settings HTML ---
async function loadSettingsHTML() {
    const getContainer = () => $(document.getElementById('idle_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(settingsHTML);
}

// --- Update Setting ---
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

// --- Attach Listener ---
function attachUpdateListener(elementId, property, isCheckbox = false) {
    $(`#${elementId}`).on('input', debounce(async () => {
        updateSetting(elementId, property, isCheckbox);
        await updateNextTime();
    }, 250));
}

// --- Handle Enabled ---
async function handleIdleEnabled() {
    if (!extension_settings.idle.enabled) {
        await sendServiceWorkerMessage('CANCEL_UNIFIED_TIMER', {});
        $('#idle_next_time').text('--');
        toastr.warning('Idle Extension: Disabled');
    } else {
        // Initialize last reply time if not set
        if (!extension_settings.idle.lastAIReplyTime) {
            extension_settings.idle.lastAIReplyTime = new Date().toISOString();
            saveSettingsDebounced();
        }
        await updateNextTime();
        toastr.success('Idle Extension: Enabled');
    }
}

// --- Setup Listeners ---
function setupListeners() {
    const settingsToWatch = [
        ['idle_timer', 'timer'],
        ['idle_prompts', 'prompts'],
        ['idle_enabled', 'enabled', true],
        ['idle_random_time', 'randomTime', true],
        ['idle_timer_min', 'timerMin'],
        ['idle_include_prompt', 'includePrompt', true],
        ['idle_sendAs', 'sendAs'],
        ['idle_use_timer', 'useIdleTimer', true],
    ];

    settingsToWatch.forEach(setting => {
        attachUpdateListener(...setting);
    });

    $('#idle_enabled').on('input', debounce(handleIdleEnabled, 250));
}

// --- Toggle Idle ---
function toggleIdle() {
    extension_settings.idle.enabled = !extension_settings.idle.enabled;
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled);
    $('#idle_enabled').trigger('input');
    toastr.info(`Idle mode ${extension_settings.idle.enabled ? 'enabled' : 'disabled'}.`);
}

// --- Render Schedules ---
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

// --- Setup Schedule Listeners ---
async function setupScheduleListeners() {
    $('#idle_add_schedule_once').on('click', async () => {
        extension_settings.idle.scheduleOnceList.push({ enabled: true, time: '', prompt: '' });
        saveSettingsDebounced();
        renderSchedules();
        toastr.success('Idle Extension: Added one-time schedule');
        await updateNextTime();
    });

    $('#idle_add_schedule_daily').on('click', async () => {
        extension_settings.idle.scheduleDailyList.push({ enabled: true, time: '', prompt: '' });
        saveSettingsDebounced();
        renderSchedules();
        toastr.success('Idle Extension: Added daily schedule');
        await updateNextTime();
    });

    $('#idle_schedule_once_list').on('input change click', '.schedule-entry', async function(e) {
        const index = $(this).data('index');
        const entry = extension_settings.idle.scheduleOnceList[index];
        if (e.target.classList.contains('once-enabled')) entry.enabled = e.target.checked;
        if (e.target.classList.contains('once-time')) entry.time = e.target.value;
        if (e.target.classList.contains('once-prompt')) entry.prompt = e.target.value;
        if (e.target.classList.contains('once-delete')) {
            extension_settings.idle.scheduleOnceList.splice(index, 1);
            renderSchedules();
            toastr.warning('Idle Extension: Removed one-time schedule');
        }
        saveSettingsDebounced();
        await updateNextTime();
    });

    $('#idle_schedule_daily_list').on('input change click', '.schedule-entry', async function(e) {
        const index = $(this).data('index');
        const entry = extension_settings.idle.scheduleDailyList[index];
        if (e.target.classList.contains('daily-enabled')) entry.enabled = e.target.checked;
        if (e.target.classList.contains('daily-time')) entry.time = e.target.value;
        if (e.target.classList.contains('daily-prompt')) entry.prompt = e.target.value;
        if (e.target.classList.contains('daily-delete')) {
            extension_settings.idle.scheduleDailyList.splice(index, 1);
            renderSchedules();
            toastr.warning('Idle Extension: Removed daily schedule');
        }
        saveSettingsDebounced();
        await updateNextTime();
    });
}

// --- Listen for Service Worker Messages ---
navigator.serviceWorker?.addEventListener('message', async (event) => {
    const { type, data } = event.data;
    
    if (type === 'UNIFIED_TIMER_FIRED') {
        const { eventType, eventData } = data;
        
        if (eventType === 'idle_reply') {
            toastr.info('Idle Extension: Idle timer fired');
            await sendIdlePrompt('', null, eventData?.isDelayed || false);
        } else if (eventType === 'once') {
            toastr.info('Idle Extension: One-time schedule triggered');
            await handleOnceSchedule(eventData.index, eventData.prompt);
        } else if (eventType === 'daily') {
            toastr.info('Idle Extension: Daily schedule triggered');
            await handleDailySchedule(eventData.index, eventData.prompt);
        }
    }
});

// --- Init ---
jQuery(async () => {
    await loadSettingsHTML();
    loadSettings();
    setupListeners();
    setupScheduleListeners();
    renderSchedules();
    
    // Setup AI reply monitor
    setupAIReplyMonitor();
    
    const swReady = await initServiceWorker();
    if (swReady) {
        if (extension_settings.idle.enabled) {
            if (!extension_settings.idle.lastAIReplyTime) {
                extension_settings.idle.lastAIReplyTime = new Date().toISOString();
                saveSettingsDebounced();
            }
            await updateNextTime();
            toastr.info('Idle Extension: Initialized');
        }
    } else {
        toastr.error('Idle Extension: Service Worker initialization failed');
    }
    
    registerSlashCommand('idle', toggleIdle, [], '– toggles idle mode', true, true);
});