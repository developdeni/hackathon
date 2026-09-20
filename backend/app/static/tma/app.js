// ==========================================================================
// TANAP AI TELEGRAM MINI APP LOGIC
// ==========================================================================

const API_BASE = window.location.origin;
const tg = window.Telegram?.WebApp;

// State
let authToken = localStorage.getItem('tanap_token') || null;
let currentUser = null;
let fieldsData = [];

// Init Telegram WebApp
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.enableClosingConfirmation) {
    tg.enableClosingConfirmation();
  }
}

// Helper: Haptics
function triggerHaptic(type = 'light') {
  try {
    if (tg?.HapticFeedback) {
      if (type === 'success' || type === 'error' || type === 'warning') {
        tg.HapticFeedback.notificationOccurred(type);
      } else if (type === 'selection') {
        tg.HapticFeedback.selectionChanged();
      } else {
        tg.HapticFeedback.impactOccurred(type);
      }
    }
  } catch (e) {
    // Ignore if not supported
  }
}

// Helper: Toast
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2800);
}

// ==========================================================================
// 1. INTRO SPLASH HANDLING
// ==========================================================================
const splashEl = document.getElementById('intro-splash');
let splashDismissed = false;

function dismissSplash() {
  if (splashDismissed) return;
  splashDismissed = true;
  triggerHaptic('medium');

  splashEl.classList.add('fade-out');
  setTimeout(() => {
    splashEl.remove();
    checkAuthAndInit();
  }, 500);
}

splashEl.addEventListener('click', dismissSplash);
setTimeout(dismissSplash, 2400);

// ==========================================================================
// 2. AUTH & ONBOARDING
// ==========================================================================
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const appContainer = document.getElementById('app-container');

function checkAuthAndInit() {
  const savedUser = localStorage.getItem('tanap_user');
  if (authToken && savedUser) {
    try {
      currentUser = JSON.parse(savedUser);
      showApp();
      return;
    } catch (e) {
      // invalid cache, fallback to auth
    }
  }

  // Show Auth Modal
  authModal.classList.remove('hidden');

  // Prefill from Telegram if available
  const tgUser = tg?.initDataUnsafe?.user;
  const nameInput = document.getElementById('input-name');
  const companyInput = document.getElementById('input-company');

  if (tgUser) {
    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
    if (fullName) nameInput.value = fullName;
    if (tgUser.username) {
      companyInput.placeholder = `КХ «${tgUser.first_name || 'Агро'}»`;
    }
  } else {
    nameInput.value = 'Данил Мирошниченко';
    companyInput.value = 'КХ «Астана Агро»';
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('input-name').value.trim();
  const company = document.getElementById('input-company').value.trim();

  if (!name || !company) {
    showToast('Пожалуйста, заполните имя и компанию');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-auth');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span>Подключение...</span>';

  const tgUser = tg?.initDataUnsafe?.user;
  const telegramId = tgUser?.id || (Date.now() % 100000000);
  const username = tgUser?.username || null;

  try {
    const res = await fetch(`${API_BASE}/api/auth/telegram-webapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramId: String(telegramId),
        name: name,
        companyName: company,
        username: username,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ошибка авторизации (${res.status})`);
    }

    const data = await res.json();
    authToken = data.token;
    currentUser = data.user;

    localStorage.setItem('tanap_token', authToken);
    localStorage.setItem('tanap_user', JSON.stringify(currentUser));

    triggerHaptic('success');
    authModal.classList.add('hidden');
    showApp();
  } catch (err) {
    triggerHaptic('error');
    showToast(err.message || 'Ошибка входа');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Войти в систему</span> <span class="btn-arrow">→</span>';
  }
});

function showApp() {
  appContainer.classList.remove('hidden');
  updateProfileHeader();
  loadFields();
}

function updateProfileHeader() {
  if (!currentUser) return;
  const companyHeader = document.getElementById('display-company-header');
  const profName = document.getElementById('profile-user-name');
  const profOrg = document.getElementById('profile-user-org');
  const profTg = document.getElementById('profile-tg-id');
  const profAvatar = document.getElementById('profile-avatar-char');

  const org = currentUser.organization || 'КХ Партнёр';
  companyHeader.textContent = org;
  profName.textContent = currentUser.name || 'Пользователь';
  profOrg.textContent = org;

  const tgUser = tg?.initDataUnsafe?.user;
  if (tgUser?.username) {
    profTg.textContent = `Telegram: @${tgUser.username}`;
  } else {
    profTg.textContent = `ID: ${currentUser.id.slice(0, 14)}`;
  }

  profAvatar.textContent = (currentUser.name || 'Т')[0].toUpperCase();
}

// ==========================================================================
// 3. FIELDS / УЧАСТКИ TAB
// ==========================================================================
async function loadFields() {
  const fieldsContainer = document.getElementById('fields-list');
  fieldsContainer.innerHTML = '<div style="text-align:center; padding:30px; color:#9CA3AF;">Загрузка полей Sentinel-2...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/fields`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!res.ok) throw new Error('Не удалось загрузить поля');

    fieldsData = await res.json();
    renderFields(fieldsData);
  } catch (err) {
    fieldsContainer.innerHTML = `
      <div style="text-align:center; padding:30px; color:#F87171;">
        ${err.message}<br>
        <button onclick="loadFields()" style="margin-top:10px; padding:8px 16px; border-radius:10px; background:#2E7D32; color:#fff; border:none;">Повторить</button>
      </div>`;
  }
}

function renderFields(fields) {
  const fieldsContainer = document.getElementById('fields-list');
  const statHa = document.getElementById('stat-total-ha');
  const statCount = document.getElementById('stat-field-count');
  const badgeCount = document.getElementById('badge-field-count');

  if (!fields || fields.length === 0) {
    fieldsContainer.innerHTML = '<div style="text-align:center; padding:40px; color:#9CA3AF;">Нет добавленных полей.</div>';
    statHa.innerHTML = '0 <span class="stat-unit">га</span>';
    statCount.innerHTML = '0 <span class="stat-unit">полей</span>';
    badgeCount.textContent = '0 полей';
    return;
  }

  const totalHa = fields.reduce((sum, f) => sum + (f.areaHa || 0), 0);
  statHa.innerHTML = `${Math.round(totalHa)} <span class="stat-unit">га</span>`;
  statCount.innerHTML = `${fields.length} <span class="stat-unit">участка</span>`;
  badgeCount.textContent = `${fields.length} полей`;

  fieldsContainer.innerHTML = fields.map(f => {
    const cropName = f.cropType || 'Яровая пшеница';
    const area = f.areaHa ? Math.round(f.areaHa) : 120;
    const perimeter = f.perimeterKm ? f.perimeterKm.toFixed(1) : '4.5';

    return `
      <div class="field-card" data-id="${f.id}">
        <div class="field-header">
          <div>
            <div class="field-name">${f.name}</div>
            <div class="field-meta">Акмолинская обл. • ${area} га</div>
          </div>
          <span class="crop-badge">${cropName}</span>
        </div>

        <div class="field-indicators">
          <div class="indicator-chip">
            <span class="chip-dot"></span>
            <span>NDVI: 0.64 (Норма)</span>
          </div>
          <div class="indicator-chip">
            <span>💧 Влага: 42%</span>
          </div>
          <div class="indicator-chip">
            <span>📏 Периметр: ${perimeter} км</span>
          </div>
        </div>

        <div class="field-actions">
          <button class="btn-field-action primary-accent" onclick="downloadAgropassport('${f.id}', '${f.name}')">
            <span>📄 Агропаспорт PDF</span>
          </button>
          <button class="btn-field-action" onclick="askAiAboutField('${f.name}', '${cropName}')">
            <span>🤖 Спросить AI</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Download Agro-passport PDF
function downloadAgropassport(fieldId, fieldName) {
  triggerHaptic('medium');
  showToast(`Формирование агропаспорта для ${fieldName}...`);

  const url = `${API_BASE}/api/fields/${encodeURIComponent(fieldId)}/agropassport/pdf`;

  if (tg?.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, '_blank');
  }
}

function askAiAboutField(fieldName, cropName) {
  switchTab('tab-advisor');
  const chatInput = document.getElementById('chat-input');
  chatInput.value = `Дай рекомендации по уходу и защите для поля «${fieldName}» (культура: ${cropName}) в Акмолинской области.`;
  sendMessage();
}

// ==========================================================================
// 4. AI АГРОНОМ (CHAT)
// ==========================================================================
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const chatThread = document.getElementById('chat-thread');

async function sendMessage(customText = null) {
  const text = customText || chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  triggerHaptic('light');

  // Append user message
  appendMessage(text, 'user');

  // Typing placeholder
  const typingEl = appendMessage('Агроном думает над ответом...', 'ai', true);

  try {
    const res = await fetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        message: text,
        context: 'telegram_miniapp',
      }),
    });

    if (!res.ok) throw new Error(`Ошибка связи с AI (${res.status})`);

    const data = await res.json();
    typingEl.remove();
    appendMessage(data.reply || data.answer || 'Ответ сформирован.', 'ai');
    triggerHaptic('success');
  } catch (err) {
    typingEl.remove();
    appendMessage(`⚠️ Не удалось получить ответ: ${err.message}`, 'ai');
    triggerHaptic('error');
  }
}

function appendMessage(content, sender = 'ai', isTyping = false) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${sender}-msg`;
  if (isTyping) msgDiv.id = 'typing-indicator';

  const avatarChar = sender === 'ai' ? '🌾' : '👤';

  // Format markdown bolding and line breaks
  const formattedContent = content
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');

  msgDiv.innerHTML = `
    <div class="msg-avatar">${avatarChar}</div>
    <div class="msg-bubble">${formattedContent}</div>
  `;

  chatThread.appendChild(msgDiv);
  chatThread.scrollTop = chatThread.scrollHeight;
  return msgDiv;
}

btnSendChat.addEventListener('click', () => sendMessage());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
});

// Quick Prompt Chips
document.querySelectorAll('.chip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const prompt = btn.getAttribute('data-prompt');
    sendMessage(prompt);
  });
});

// ==========================================================================
// 5. TABS & NAVIGATION
// ==========================================================================
const navButtons = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');

function switchTab(targetTabId) {
  triggerHaptic('selection');

  navButtons.forEach(btn => {
    if (btn.getAttribute('data-tab') === targetTabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  tabPanes.forEach(pane => {
    if (pane.id === targetTabId) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });
}

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    switchTab(tabId);
  });
});

// ==========================================================================
// 6. LOGOUT
// ==========================================================================
document.getElementById('btn-logout').addEventListener('click', () => {
  triggerHaptic('warning');
  localStorage.removeItem('tanap_token');
  localStorage.removeItem('tanap_user');
  authToken = null;
  currentUser = null;

  appContainer.classList.add('hidden');
  authModal.classList.remove('hidden');
  showToast('Вы вышли из профиля');
});
