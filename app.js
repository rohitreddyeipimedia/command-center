/* ============================================================
   EiPi Command Center — Application Logic
   Supabase-powered agent management dashboard
   ============================================================ */

// --- Supabase Client (with fallback) ---
let sb = null;
let useFallback = false;
try {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.warn('Supabase JS client not loaded, using REST fallback');
    useFallback = true;
  }
} catch(e) {
  console.warn('Supabase init failed, using REST fallback:', e);
  useFallback = true;
}

// --- REST API fallback helpers ---
const sbHeaders = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function sbGet(table, query = '') {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbHeaders });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function sbInsert(table, row) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: sbHeaders, body: JSON.stringify(row)
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// --- State ---
let agents = [];
let currentAgent = null;
let currentMessages = [];
let activityFeed = [];
let isSending = false;
let realtimeChannel = null;
let isAuthenticated = false;

// --- DOM References ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- PIN Auth ---
function initAuth() {
  if (isAuthenticated) {
    showApp();
    return;
  }
  showAuthScreen();
}

function showAuthScreen() {
  $('#auth-screen').classList.remove('hidden');
  $('#app-main').classList.add('hidden');
  
  const pinInput = $('#pin-input');
  const pinBtn = $('#pin-submit');
  
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptAuth();
  });
  pinBtn.addEventListener('click', attemptAuth);
  
  setTimeout(() => pinInput.focus(), 100);
}

function attemptAuth() {
  const pinInput = $('#pin-input');
  const value = pinInput.value.trim();
  
  if (value === AUTH_PIN) {
    isAuthenticated = true;
    showApp();
  } else {
    pinInput.classList.add('error');
    pinInput.value = '';
    pinInput.setAttribute('placeholder', 'Wrong PIN — try again');
    setTimeout(() => {
      pinInput.classList.remove('error');
      pinInput.setAttribute('placeholder', 'Enter PIN');
    }, 1500);
  }
}

function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-main').classList.remove('hidden');
  bootstrap();
}

// --- Bootstrap ---
async function bootstrap() {
  showAgentSkeletons();
  await loadAgents();
  await loadActivityFeed();
  setupRealtime();
}

// --- Agents ---
async function loadAgents() {
  try {
    let data;
    if (!useFallback && sb) {
      const res = await sb.from('agents').select('*').order('created_at', { ascending: true });
      if (res.error) throw res.error;
      data = res.data;
    } else {
      data = await sbGet('agents', '?select=*&order=created_at.asc');
    }
    agents = data || [];
    renderAgents();
  } catch (err) {
    console.error('Failed to load agents:', err);
    // Try REST fallback if SDK failed
    if (!useFallback) {
      try {
        console.log('Retrying with REST fallback...');
        const data = await sbGet('agents', '?select=*&order=created_at.asc');
        agents = data || [];
        useFallback = true;
        renderAgents();
        return;
      } catch(e2) {
        console.error('REST fallback also failed:', e2);
      }
    }
    renderAgentsError();
  }
}

function showAgentSkeletons() {
  const grid = $('#agent-grid');
  grid.innerHTML = Array(4).fill(0).map(() =>
    `<div class="skeleton skeleton-card"></div>`
  ).join('');
}

function renderAgents() {
  const grid = $('#agent-grid');
  const count = $('#agent-count');
  
  if (agents.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-tertiary);">
        <div style="font-size: 2rem; margin-bottom: 12px;">📡</div>
        <div style="font-size: 0.85rem;">No agents registered yet.</div>
        <div style="font-size: 0.75rem; margin-top: 4px;">Add agents to the <code style="font-family: var(--font-mono); color: var(--accent);">agents</code> table in Supabase.</div>
      </div>
    `;
    count.textContent = '0 agents';
    return;
  }
  
  count.textContent = `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
  
  grid.innerHTML = agents.map((agent) => {
    const statusClass = agent.status === 'processing' ? 'processing' : agent.status === 'error' ? 'error' : '';
    const statusLabel = agent.status || 'idle';
    const lastActive = agent.last_active ? timeAgo(agent.last_active) : 'Never';
    
    return `
      <div class="agent-card" data-agent-id="${agent.id}" onclick="openAgent('${agent.id}')">
        <div class="agent-card-header">
          <div class="agent-identity">
            <span class="agent-emoji">${agent.emoji || '🤖'}</span>
            <span class="agent-name">${escapeHTML(agent.name)}</span>
          </div>
          <div class="status-indicator ${statusClass}">
            <span class="status-dot"></span>
            ${statusLabel}
          </div>
        </div>
        <div class="agent-description">${escapeHTML(agent.description || 'No description')}</div>
        <div id="last-response-${agent.id}"></div>
        <div class="agent-meta">
          <span class="agent-last-active">Last active: ${lastActive}</span>
          <button class="send-btn" onclick="event.stopPropagation(); openAgent('${agent.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: -1px;"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Message
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  // Load last responses
  agents.forEach(agent => loadLastResponse(agent.id));
}

async function loadLastResponse(agentId) {
  try {
    let data;
    if (!useFallback && sb) {
      const res = await sb.from('messages').select('content').eq('agent_id', agentId).eq('direction', 'outbound').order('created_at', { ascending: false }).limit(1);
      data = res.data;
    } else {
      data = await sbGet('messages', `?select=content&agent_id=eq.${agentId}&direction=eq.outbound&order=created_at.desc&limit=1`);
    }
    const el = $(`#last-response-${agentId}`);
    if (el && data && data.length > 0) {
      el.innerHTML = `<div class="agent-last-response">${escapeHTML(truncate(data[0].content, 120))}</div>`;
    }
  } catch (err) {
    // Silently ignore
  }
}

function renderAgentsError() {
  const grid = $('#agent-grid');
  grid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-tertiary);">
      <div style="font-size: 2rem; margin-bottom: 12px;">⚠️</div>
      <div style="font-size: 0.85rem; color: var(--status-error);">Failed to connect to Supabase.</div>
      <div style="font-size: 0.75rem; margin-top: 4px;">Check that the tables exist and RLS policies are configured.</div>
      <button onclick="loadAgents()" style="margin-top: 16px; padding: 8px 20px; background: var(--accent-dim); color: var(--accent); border: 1px solid rgba(0,212,170,0.2); border-radius: 8px; cursor: pointer; font-size: 0.8rem;">Retry</button>
    </div>
  `;
}

// --- Message Panel ---
async function openAgent(agentId) {
  currentAgent = agents.find(a => a.id === agentId);
  if (!currentAgent) return;
  
  const overlay = $('#message-panel-overlay');
  const panelEmoji = $('#panel-agent-emoji');
  const panelName = $('#panel-agent-name');
  const panelStatus = $('#panel-agent-status');
  
  panelEmoji.textContent = currentAgent.emoji || '🤖';
  panelName.textContent = currentAgent.name;
  panelStatus.textContent = `${currentAgent.status || 'idle'} · ${currentAgent.id.substring(0, 8)}`;
  
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  
  await loadMessages(agentId);
  
  const textarea = $('#message-textarea');
  setTimeout(() => textarea.focus(), 300);
}

function closePanel() {
  const overlay = $('#message-panel-overlay');
  overlay.classList.remove('active');
  document.body.style.overflow = '';
  currentAgent = null;
  currentMessages = [];
}

async function loadMessages(agentId) {
  const area = $('#messages-area');
  area.innerHTML = '<div class="messages-empty"><div class="skeleton" style="width: 200px; height: 16px;"></div></div>';
  
  try {
    let data;
    if (!useFallback && sb) {
      const res = await sb.from('messages').select('*').eq('agent_id', agentId).order('created_at', { ascending: true });
      if (res.error) throw res.error;
      data = res.data;
    } else {
      data = await sbGet('messages', `?select=*&agent_id=eq.${agentId}&order=created_at.asc`);
    }
    currentMessages = data || [];
    renderMessages();
  } catch (err) {
    console.error('Failed to load messages:', err);
    area.innerHTML = `
      <div class="messages-empty">
        <span class="messages-empty-icon">⚠️</span>
        <span>Failed to load messages</span>
      </div>
    `;
  }
}

function renderMessages() {
  const area = $('#messages-area');
  
  if (currentMessages.length === 0) {
    area.innerHTML = `
      <div class="messages-empty">
        <span class="messages-empty-icon">💬</span>
        <span>No messages yet</span>
        <span style="font-size: 0.7rem;">Send a message to this agent below</span>
      </div>
    `;
    return;
  }
  
  area.innerHTML = currentMessages.map(msg => {
    const time = formatTime(msg.created_at);
    const dirClass = msg.direction === 'inbound' ? 'inbound' : 'outbound';
    const dirLabel = msg.direction === 'inbound' ? 'You' : (currentAgent?.name || 'Agent');
    
    return `
      <div class="message-bubble ${dirClass}">
        <div>${escapeHTML(msg.content)}</div>
        <div class="message-meta">
          <span>${dirLabel}</span>
          <span>·</span>
          <span>${time}</span>
          <span class="message-status-badge ${msg.status}">${msg.status}</span>
        </div>
      </div>
    `;
  }).join('');
  
  // Auto-scroll
  requestAnimationFrame(() => {
    area.scrollTop = area.scrollHeight;
  });
}

async function sendMessage() {
  if (isSending || !currentAgent) return;
  
  const textarea = $('#message-textarea');
  const content = textarea.value.trim();
  if (!content) return;
  
  isSending = true;
  const sendBtn = $('#message-send-btn');
  sendBtn.disabled = true;
  
  // Show sending indicator
  const indicator = $('#sending-indicator');
  indicator.classList.remove('hidden');
  indicator.textContent = 'Sending...';
  
  // Optimistic UI: add message immediately
  const tempMsg = {
    id: 'temp-' + Date.now(),
    agent_id: currentAgent.id,
    direction: 'inbound',
    content: content,
    status: 'pending',
    source: 'web',
    created_at: new Date().toISOString()
  };
  currentMessages.push(tempMsg);
  renderMessages();
  textarea.value = '';
  autoResizeTextarea(textarea);
  
  try {
    const row = {
      agent_id: currentAgent.id,
      direction: 'inbound',
      content: content,
      status: 'pending',
      source: 'web'
    };
    let data;
    if (!useFallback && sb) {
      const res = await sb.from('messages').insert(row).select().single();
      if (res.error) throw res.error;
      data = res.data;
    } else {
      const arr = await sbInsert('messages', row);
      data = arr[0];
    }
    
    // Replace temp message with real one
    const idx = currentMessages.findIndex(m => m.id === tempMsg.id);
    if (idx !== -1) currentMessages[idx] = data;
    renderMessages();
    
    showToast('Message sent', 'success');
  } catch (err) {
    console.error('Send failed:', err);
    // Mark temp message as failed
    const idx = currentMessages.findIndex(m => m.id === tempMsg.id);
    if (idx !== -1) currentMessages[idx].status = 'failed';
    renderMessages();
    showToast('Failed to send message', 'error');
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    indicator.classList.add('hidden');
  }
}

// --- Activity Feed ---
async function loadActivityFeed() {
  try {
    let data;
    if (!useFallback && sb) {
      const res = await sb.from('messages').select('*, agents!inner(name, emoji)').order('created_at', { ascending: false }).limit(20);
      if (res.error) throw res.error;
      data = res.data;
    } else {
      // REST fallback — get messages then enrich with agent data
      data = await sbGet('messages', '?select=*&order=created_at.desc&limit=20');
    }
    activityFeed = data || [];
    renderActivityFeed();
  } catch (err) {
    console.error('Failed to load activity feed:', err);
    // Try simpler query as fallback
    try {
      let data;
      if (!useFallback && sb) {
        const res = await sb.from('messages').select('*').order('created_at', { ascending: false }).limit(20);
        data = res.data;
      } else {
        data = await sbGet('messages', '?select=*&order=created_at.desc&limit=20');
      }
      if (data) {
        activityFeed = data;
        renderActivityFeed();
      }
    } catch (e) {
      // Silently fail
    }
  }
}

function renderActivityFeed() {
  const feed = $('#activity-feed');
  
  if (activityFeed.length === 0) {
    feed.innerHTML = `<div class="activity-empty">No recent activity. Messages will appear here as agents process them.</div>`;
    return;
  }
  
  feed.innerHTML = activityFeed.map(item => {
    const agentName = item.agents?.name || getAgentName(item.agent_id);
    const agentEmoji = item.agents?.emoji || getAgentEmoji(item.agent_id);
    const action = item.direction === 'inbound' ? 'received' : 'responded';
    const preview = truncate(item.content, 80);
    const time = timeAgo(item.created_at);
    
    return `
      <div class="activity-item" ${item.agent_id ? `onclick="openAgent('${item.agent_id}')"` : ''} style="cursor: pointer;">
        <div class="activity-icon">${agentEmoji || '🤖'}</div>
        <div class="activity-content">
          <div class="activity-text"><strong>${escapeHTML(agentName || 'Agent')}</strong> ${action}: ${escapeHTML(preview)}</div>
          <div class="activity-time">${time} · ${item.status}</div>
        </div>
      </div>
    `;
  }).join('');
}

function getAgentName(agentId) {
  const agent = agents.find(a => a.id === agentId);
  return agent ? agent.name : 'Unknown Agent';
}

function getAgentEmoji(agentId) {
  const agent = agents.find(a => a.id === agentId);
  return agent ? (agent.emoji || '🤖') : '🤖';
}

// --- Realtime ---
function setupRealtime() {
  if (!sb) {
    console.warn('Realtime disabled — Supabase client not available. Polling every 15s instead.');
    // Poll fallback
    setInterval(() => { loadAgents(); loadActivityFeed(); }, 15000);
    return;
  }
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
  }
  
  realtimeChannel = sb
    .channel('messages-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages' },
      (payload) => {
        handleRealtimeMessage(payload);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'agents' },
      (payload) => {
        handleRealtimeAgent(payload);
      }
    )
    .subscribe((status) => {
      const dot = $('#realtime-dot');
      if (status === 'SUBSCRIBED') {
        dot.style.background = 'var(--accent)';
        dot.title = 'Connected';
      } else {
        dot.style.background = 'var(--status-error)';
        dot.title = 'Disconnected';
      }
    });
}

function handleRealtimeMessage(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  
  // Update activity feed
  if (eventType === 'INSERT') {
    activityFeed.unshift(newRow);
    if (activityFeed.length > 20) activityFeed.pop();
    renderActivityFeed();
  } else if (eventType === 'UPDATE') {
    const idx = activityFeed.findIndex(a => a.id === newRow.id);
    if (idx !== -1) {
      activityFeed[idx] = { ...activityFeed[idx], ...newRow };
      renderActivityFeed();
    }
  }
  
  // Update message panel if viewing this agent
  if (currentAgent && newRow && newRow.agent_id === currentAgent.id) {
    if (eventType === 'INSERT') {
      // Only add if not already present (might be our optimistic add)
      if (!currentMessages.find(m => m.id === newRow.id)) {
        currentMessages.push(newRow);
        renderMessages();
      }
    } else if (eventType === 'UPDATE') {
      const msgIdx = currentMessages.findIndex(m => m.id === newRow.id);
      if (msgIdx !== -1) {
        currentMessages[msgIdx] = { ...currentMessages[msgIdx], ...newRow };
        renderMessages();
      }
    }
  }
  
  // Reload last responses
  if (newRow && newRow.direction === 'outbound') {
    loadLastResponse(newRow.agent_id);
  }
}

function handleRealtimeAgent(payload) {
  const { eventType, new: newRow } = payload;
  
  if (eventType === 'UPDATE' || eventType === 'INSERT') {
    const idx = agents.findIndex(a => a.id === newRow.id);
    if (idx !== -1) {
      agents[idx] = newRow;
    } else {
      agents.push(newRow);
    }
    renderAgents();
  } else if (eventType === 'DELETE') {
    agents = agents.filter(a => a.id !== payload.old.id);
    renderAgents();
  }
}

// --- Textarea auto-resize ---
function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

// --- Toast ---
function showToast(message, type = 'success') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${type === 'success' ? '✓' : '✗'} ${escapeHTML(message)}`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 300ms ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Utility ---
function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '…' : str;
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);
  
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-IN', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true 
  }) + ' · ' + date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  // Escape to close panel
  if (e.key === 'Escape' && currentAgent) {
    closePanel();
  }
});

// --- Event Bindings (after DOM) ---
document.addEventListener('DOMContentLoaded', () => {
  // Close panel on overlay click
  $('#message-panel-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePanel();
  });
  
  // Close button
  $('#panel-close-btn').addEventListener('click', closePanel);
  
  // Send message
  $('#message-send-btn').addEventListener('click', sendMessage);
  
  // Textarea
  const textarea = $('#message-textarea');
  textarea.addEventListener('input', () => autoResizeTextarea(textarea));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  
  // Logout
  $('#logout-btn')?.addEventListener('click', () => {
    isAuthenticated = false;
    location.reload();
  });
  
  // Init auth
  initAuth();
});
