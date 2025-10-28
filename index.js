import {
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { promptQuietForLoudResponse, sendNarratorMessage } from '../../../slash-commands.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const extensionName = 'third-party/Extension-Idle';

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
        <summary><b>Idle Settings (Termux Backend Mode)</b></summary>
        
        <!-- 后端状态显示 -->
        <fieldset style="border: 2px solid #4a90e2; margin-bottom: 10px;">
            <legend style="font-weight: bold; color: #4a90e2;">🔧 后端服务状态</legend>
            <div style="padding: 10px;">
                <div id="idle_backend_status" style="font-size: 14px; padding: 5px; color: #999;">
                    未连接
                </div>
                <button type="button" id="idle_reconnect_backend" style="margin-top: 5px; padding: 5px 10px;">
                    重新连接
                </button>
                <button type="button" id="idle_test_notification" style="margin-left: 5px; padding: 5px 10px;">
                    测试通知
                </button>
            </div>
        </fieldset>
        
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

// ========================================
// === 后端客户端（核心通信逻辑）===
// ========================================

class IdleBackendClient {
    constructor() {
        this.eventSource = null;
        this.isConnected = false;
        this.backendUrl = 'http://localhost:8765';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 999;
    }

    connect() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        console.log('[Idle Backend] Connecting to', this.backendUrl);
        toastr.info('正在连接后端服务...', 'Idle Extension');

        this.eventSource = new EventSource(`${this.backendUrl}/events`);

        this.eventSource.onopen = () => {
            console.log('[Idle Backend] ✓ Connected');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            toastr.success('后端服务已连接 - 支持息屏通知', 'Idle Extension');
            $('#idle_backend_status').html('✓ 后端运行中').css('color', '#4a90e2');
        };

        this.eventSource.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (err) {
                console.error('[Idle Backend] Parse error:', err);
            }
        };

        this.eventSource.onerror = (err) => {
            console.error('[Idle Backend] Connection error');
            this.isConnected = false;
            $('#idle_backend_status').html('✗ 后端断开').css('color', '#999');
            
            this.eventSource.close();
            this.attemptReconnect();
        };
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            toastr.error('无法连接到后端服务，请运行: ./idle-service.sh start', 'Idle Extension');
            return;
        }

        this.reconnectAttempts++;
        console.log(`[Idle Backend] Reconnecting... (${this.reconnectAttempts})`);

        setTimeout(() => {
            this.connect();
        }, 5000);
    }

    handleMessage(message) {
    console.log('[Idle Backend] Message:', message.type);
    switch (message.type) {
        case 'CONNECTED':
            console.log('[Idle Backend] Initial state received');
            if (message.data.nextTrigger) {
                this.updateNextTimeUI(message.data.nextTrigger);
            }
            break;
        case 'NEXT_TIME_UPDATE':
            // 定期更新显示
            if (message.data.remainingSeconds !== undefined) {
                const remaining = message.data.remainingSeconds;
                const nextTime = new Date(message.data.nextTriggerTime);
                const timeStr = nextTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                $('#idle_next_time').html(`${timeStr} <span style="color: #666;">(${remaining}秒后)</span>`);
            }
            break;
        case 'IDLE_TRIGGER':
            console.log('[Idle Backend] ⏰ Idle triggered by backend!');
            toastr.warning('后端触发空闲消息', 'Idle Extension');
            sendIdlePrompt('', null, message.data.isDelayed);
            
            // 清空显示
            $('#idle_next_time').text('等待 AI 回复...');
            break;
        case 'SCHEDULE_ONCE_TRIGGER':
            console.log('[Idle Backend] ⏰ Once schedule triggered!');
            handleOnceSchedule(message.data.index, message.data.prompt);
            break;
        case 'SCHEDULE_DAILY_TRIGGER':
            console.log('[Idle Backend] ⏰ Daily schedule triggered!');
            handleDailySchedule(message.data.index, message.data.prompt);
            break;
        case 'SETTINGS_UPDATED':
            console.log('[Idle Backend] Settings synced from backend');
            break;
        case 'AI_REPLY_DETECTED':
            console.log('[Idle Backend] AI reply detected by backend');
            break;
    }
}

    

    async syncSettings(settings) {
        if (!this.isConnected) {
            console.warn('[Idle Backend] Not connected, cannot sync settings');
            return;
        }

        try {
            const response = await fetch(`${this.backendUrl}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });

            if (response.ok) {
                console.log('[Idle Backend] Settings synced');
            }
        } catch (err) {
            console.error('[Idle Backend] Failed to sync settings:', err);
        }
    }

    async notifyAIReply() {
        if (!this.isConnected) {
            console.warn('[Idle Backend] Not connected, cannot notify AI reply');
            return;
        }

        try {
            const response = await fetch(`${this.backendUrl}/api/ai-reply`, {
                method: 'POST'
            });

            if (response.ok) {
                console.log('[Idle Backend] AI reply notified to backend');
            }
        } catch (err) {
            console.error('[Idle Backend] Failed to notify AI reply:', err);
        }
    }

    async testNotification() {
        if (!this.isConnected) {
            toastr.error('后端未连接', 'Idle Extension');
            return;
        }

        try {
            // 临时设置一个很短的触发时间
            const testSettings = {
                ...extension_settings.idle,
                enabled: true,
                lastAIReplyTime: new Date(Date.now() - 1000).toISOString(), // 1秒前
                timer: 0 // 立即触发
            };

            await this.syncSettings(testSettings);
            toastr.success('测试通知已发送到后端，请查看手机', 'Idle Extension');

            // 2秒后恢复正常设置
            setTimeout(async () => {
                await this.syncSettings(extension_settings.idle);
            }, 2000);
        } catch (err) {
            toastr.error('测试失败：' + err.message, 'Idle Extension');
        }
    }

    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.isConnected = false;
    }
}

// 全局后端客户端实例
let idleBackendClient = null;

// ========================================
// === AI 回复监听器 ===
// ========================================

function setupAIReplyMonitor() {
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.classList && node.classList.contains('mes') && 
                    !node.classList.contains('user_mes')) {
                    
                    // 更新本地设置
                    extension_settings.idle.lastAIReplyTime = new Date().toISOString();
                    saveSettingsDebounced();
                    
                    // 通知后端
                    if (idleBackendClient && idleBackendClient.isConnected) {
                        idleBackendClient.notifyAIReply();
                        console.log('[Idle Extension] AI reply detected, notified backend');
                    }
                }
            });
        });
    });

    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        observer.observe(chatContainer, {
            childList: true,
            subtree: true
        });
        console.log('[Idle Extension] AI reply monitor started');
    }
}

// ========================================
// === 其他函数（保持不变）===
// ========================================

function getFullTimestamp() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
}

async function sendIdlePrompt(customPrompt = '', sendAsOverride = null, isDelayed = false) {
    if (!extension_settings.idle.enabled) return;

    if ($('#mes_stop').is(':visible')) {
        console.log('[Idle Extension] AI is generating, skip');
        return;
    }

    let promptToSend = customPrompt;
    if (!promptToSend) {
        promptToSend = extension_settings.idle.prompts[
            Math.floor(Math.random() * extension_settings.idle.prompts.length)
        ];
    }

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
}

async function handleOnceSchedule(index, prompt) {
    await sendIdlePrompt(prompt || '', 'char', false);
    extension_settings.idle.scheduleOnceList[index].enabled = false;
    saveSettingsDebounced();
    renderSchedules();
}

async function handleDailySchedule(index, prompt) {
    await sendIdlePrompt(prompt || '', 'char', false);
}

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

async function loadSettingsHTML() {
    const getContainer = () => $(document.getElementById('idle_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(settingsHTML);
}

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

function attachUpdateListener(elementId, property, isCheckbox = false) {
    $(`#${elementId}`).on('input', debounce(async () => {
        updateSetting(elementId, property, isCheckbox);
        
        // 同步到后端
        if (idleBackendClient && idleBackendClient.isConnected) {
            await idleBackendClient.syncSettings(extension_settings.idle);
        }
    }, 250));
}

async function handleIdleEnabled() {
    if (!extension_settings.idle.enabled) {
        $('#idle_next_time').text('--');
        toastr.warning('Idle Extension: Disabled');
    } else {
        if (!extension_settings.idle.lastAIReplyTime) {
            extension_settings.idle.lastAIReplyTime = new Date().toISOString();
            saveSettingsDebounced();
        }
        toastr.success('Idle Extension: Enabled');
    }
    
    // 同步到后端
    if (idleBackendClient && idleBackendClient.isConnected) {
        await idleBackendClient.syncSettings(extension_settings.idle);
    }
}

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
    
    // 后端控制按钮
    $('#idle_reconnect_backend').on('click', () => {
        if (idleBackendClient) {
            idleBackendClient.connect();
        }
    });
    
    $('#idle_test_notification').on('click', async () => {
        if (idleBackendClient) {
            await idleBackendClient.testNotification();
        }
    });
}

function toggleIdle() {
    extension_settings.idle.enabled = !extension_settings.idle.enabled;
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled);
    $('#idle_enabled').trigger('input');
    toastr.info(`Idle mode ${extension_settings.idle.enabled ? 'enabled' : 'disabled'}.`);
}

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

async function setupScheduleListeners() {
    $('#idle_add_schedule_once').on('click', async () => {
        extension_settings.idle.scheduleOnceList.push({ enabled: true, time: '', prompt: '' });
        saveSettingsDebounced();
        renderSchedules();
        toastr.success('Idle Extension: Added one-time schedule');
        
        if (idleBackendClient && idleBackendClient.isConnected) {
            await idleBackendClient.syncSettings(extension_settings.idle);
        }
    });

    $('#idle_add_schedule_daily').on('click', async () => {
        extension_settings.idle.scheduleDailyList.push({ enabled: true, time: '', prompt: '' });
        saveSettingsDebounced();
        renderSchedules();
        toastr.success('Idle Extension: Added daily schedule');
        
        if (idleBackendClient && idleBackendClient.isConnected) {
            await idleBackendClient.syncSettings(extension_settings.idle);
        }
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
        
        if (idleBackendClient && idleBackendClient.isConnected) {
            await idleBackendClient.syncSettings(extension_settings.idle);
        }
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
        
        if (idleBackendClient && idleBackendClient.isConnected) {
            await idleBackendClient.syncSettings(extension_settings.idle);
        }
    });
}

// ========================================
// === 初始化 ===
// ========================================

jQuery(async () => {
    console.log('[Idle Extension] Initializing (Backend-Only Mode)...');
    
    await loadSettingsHTML();
    loadSettings();
    setupListeners();
    setupScheduleListeners();
    renderSchedules();
    setupAIReplyMonitor();
    
    // 连接后端服务
    idleBackendClient = new IdleBackendClient();
    idleBackendClient.connect();
    
    // 等待连接
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 同步设置到后端
    if (idleBackendClient.isConnected) {
        await idleBackendClient.syncSettings(extension_settings.idle);
        console.log('[Idle Extension] Settings synced to backend');
    } else {
        toastr.error('后端未连接！请运行: cd ~/SillyTavern && ./idle-service.sh start', 'Idle Extension', {timeOut: 10000});
    }
    
    registerSlashCommand('idle', toggleIdle, [], '– toggles idle mode', true, true);
    
    console.log('[Idle Extension] Initialized (Backend-Only Mode)');
});