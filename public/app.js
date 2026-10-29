// Greenlight: the signed-in app (requests, members, approval chains, audit log).
// All user-provided text is inserted with textContent (via h()), never as HTML.

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'aw.workspace';
const TYPE_LABEL = { purchase: 'Purchase', expense: 'Expense', time_off: 'Time off' };
const STATUS_LABEL = { pending: 'Pending', changes_requested: 'Needs changes', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
const STEP_LABEL = { waiting: 'Waiting', pending: 'Waiting for decision', approved: 'Approved', rejected: 'Rejected', returned: 'Sent back for changes', skipped: 'Skipped', cancelled: 'Cancelled' };
const RANK = { employee: 1, manager: 2, admin: 3 };

let me = null;      // { user, workspaces }
let ws = null;      // current workspace details (incl. members and my role)
let scope = 'mine';
let auditBefore = null;

// ---------- Helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (res.status === 401) { location.assign('/signin'); throw new Error('Signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const send = (method, path, body = {}) => api(path, { method, body: JSON.stringify(body) });

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
function avatarEl(user) {
  if (user.avatar_url) return h('span', { class: 'avatar' }, h('img', { src: user.avatar_url, alt: '', referrerPolicy: 'no-referrer' }));
  return h('span', { class: 'avatar' }, initials(user.name));
}
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso) => dateFmt.format(new Date(`${iso}T12:00:00`));
function money(amount, currency) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount); } catch { return `${amount} ${currency}`; }
}
const amountOrDates = (r) => (r.type === 'time_off' ? `${fmtDay(r.start_date)} – ${fmtDay(r.end_date)}` : money(r.amount, r.currency));
const badge = (cls, text) => h('span', { class: `badge ${cls}` }, text);
const roleBadge = (role) => h('span', { class: `role role-${role}` }, role);

// Receipts: read a picked file as base64 and upload it to a request.
const MAX_FILE = 5 * 1024 * 1024;
const fileSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
async function uploadFiles(requestId, files) {
  for (const file of files) {
    if (file.size > MAX_FILE) throw new Error(`${file.name} is larger than 5 MB.`);
    await post(`/api/workspaces/${ws.id}/requests/${requestId}/files`, { filename: file.name, content_type: file.type, data: await readBase64(file) });
  }
}

function notice(el, text, ok) {
  el.textContent = text;
  el.className = ok ? 'notice notice-ok' : 'notice notice-error';
  el.hidden = false;
}

// After inviting: either "sent", or (no email set up) the link with a Copy button.
function inviteResult(email, inv) {
  if (inv.emailed !== false) return notice($('invite-msg'), `Invitation sent to ${email}.`, true);
  const input = h('input', { class: 'invite-link', type: 'text', readonly: true, value: inv.link, onclick: (e) => e.target.select() });
  const copy = h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(inv.link); copy.textContent = 'Copied'; } catch { input.select(); }
  } }, 'Copy');
  const el = $('invite-msg');
  el.className = 'notice notice-ok';
  el.replaceChildren(h('span', {}, `Invitation created. Send this link to ${email} (valid for 7 days):`), h('div', { class: 'invite-link-row' }, input, copy));
  el.hidden = false;
}

function savedWorkspaceId() { try { return Number(localStorage.getItem(STORE_KEY)) || null; } catch { return null; } }
function saveWorkspaceId(id) { try { localStorage.setItem(STORE_KEY, String(id)); } catch {} }

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- Loading ----------

async function load(selectId) {
  me = await api('/api/me');
  $('avatar').replaceWith(Object.assign(avatarEl(me.user), { id: 'avatar', title: `${me.user.name} (${me.user.email})` }));
  const hasWs = me.workspaces.length > 0;
  $('onboarding').hidden = hasWs;
  $('workspace').hidden = !hasWs;
  $('ws-select').hidden = !hasWs;
  $('new-ws').hidden = !hasWs;
  if (!hasWs) { $('create-name').focus(); return; }

  const wanted = selectId || savedWorkspaceId();
  const current = me.workspaces.find((w) => w.id === wanted) || me.workspaces[0];
  $('ws-select').replaceChildren(...me.workspaces.map((w) => new Option(w.name, w.id, false, w.id === current.id)));
  await showWorkspace(current.id);
}

async function showWorkspace(id) {
  saveWorkspaceId(id);
  ws = await api(`/api/workspaces/${id}`);
  document.title = `${ws.name} – Greenlight`;
  $('ws-name').textContent = ws.name;
  $('ws-role').textContent = ws.role;
  $('ws-role').className = `role role-${ws.role}`;
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = ws.role !== 'admin'));
  document.querySelectorAll('.manager-only').forEach((el) => (el.hidden = RANK[ws.role] < RANK.manager));
  renderDemoBar();
  showTab('requests');
  setScope(ws.demo_expires_at && ws.role !== 'employee' ? 'to_approve' : 'mine');
  refreshApproveCount();
}

// Live demo: switch between the sample company's people to see each role's view.
const PERSONA_TITLE = { 'Alex Morgan': 'CEO', 'Priya Shah': 'Finance lead', 'Daniel Cohen': 'Engineering lead', 'Noa Katz': 'Marketing', 'Maya Levi': 'Designer', 'Sam Rivera': 'Engineer' };
function renderDemoBar() {
  $('demo-bar').hidden = !ws.demo_expires_at;
  if (!ws.demo_expires_at) return;
  $('demo-persona').replaceChildren(...ws.members.map((m) => new Option(
    `${m.name} · ${PERSONA_TITLE[m.name] || m.role} (${m.role})`, m.id, false, m.id === me.user.id)));
}
$('demo-persona').addEventListener('change', async (e) => {
  try {
    await post('/auth/demo/switch', { user_id: Number(e.target.value) });
    await load(ws.id);
  } catch (err) { alert(err.message); }
});
$('demo-signup').addEventListener('click', async (e) => {
  e.preventDefault();
  await post('/auth/logout').catch(() => {});
  location.assign('/signin');
});

async function refreshApproveCount() {
  const { requests } = await api(`/api/workspaces/${ws.id}/requests?scope=to_approve`);
  $('approve-count').textContent = requests.length;
  $('approve-count').hidden = requests.length === 0;
}

// ---------- Tabs ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === 'members') renderMembers();
  if (name === 'dashboard') loadDashboard();
  if (name === 'chains') loadChains();
  if (name === 'audit') { auditBefore = null; $('audit-rows').replaceChildren(); loadAudit(); }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- Requests ----------

function setScope(next) {
  scope = next;
  document.querySelectorAll('#scopes .chip').forEach((c) => c.classList.toggle('active', c.dataset.scope === scope));
  loadRequests();
}
document.querySelectorAll('#scopes .chip').forEach((c) => c.addEventListener('click', () => setScope(c.dataset.scope)));

async function loadRequests() {
  const { requests } = await api(`/api/workspaces/${ws.id}/requests?scope=${scope}`);
  $('requests-empty').hidden = requests.length > 0;
  $('requests-empty').textContent = {
    mine: "You haven't submitted any requests yet. Click New request to start.",
    to_approve: 'Nothing is waiting for your approval.',
    team: "Your team hasn't submitted any requests.",
    all: 'No requests in this workspace yet.',
  }[scope];
  $('request-rows').replaceChildren(...requests.map((r) => h('tr', { onclick: () => openRequest(r.id), tabindex: '0', onkeydown: (e) => e.key === 'Enter' && openRequest(r.id) },
    h('td', {}, h('strong', {}, r.title), h('small', { class: 'sub' }, scope === 'mine' ? (r.current_step ? `Waiting for ${r.current_approver} (${r.current_step})` : '') : r.requester_name)),
    h('td', { class: 'hide-sm' }, TYPE_LABEL[r.type]),
    h('td', {}, amountOrDates(r), r.file_count ? h('span', { class: 'clip', title: `${r.file_count} file(s) attached` }, ` 📎${r.file_count}`) : ''),
    h('td', {}, badge(`st-${r.status}`, STATUS_LABEL[r.status]), r.risk_level && r.risk_level !== 'low' ? h('span', { class: `risk risk-${r.risk_level}`, title: `${r.flag_count} flag(s)` }, r.risk_level === 'high' ? 'High risk' : 'Check') : ''),
    h('td', { class: 'hide-sm' }, dateFmt.format(new Date(r.created_at))),
  )));
}

async function openRequest(id) {
  let r;
  try { r = await api(`/api/workspaces/${ws.id}/requests/${id}`); } catch (err) { return alert(err.message); }
  const facts = [
    ['Type', r.type_label],
    r.type === 'time_off' ? ['Dates', amountOrDates(r)] : ['Amount', money(r.amount, r.currency)],
    r.vendor && ['Vendor', r.vendor],
    ['Requested by', r.requester_name],
    ['Submitted', timeFmt.format(new Date(r.created_at))],
  ].filter(Boolean);

  const error = h('p', { class: 'error', hidden: true });
  const comment = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Comment (required when rejecting or sending back)', 'aria-label': 'Comment' });
  async function decide(decision, btn) {
    error.hidden = true;
    btn.disabled = true;
    try {
      await post(`/api/workspaces/${ws.id}/requests/${r.id}/decision`, { decision, comment: comment.value });
      $('detail-dialog').close();
      loadRequests();
      refreshApproveCount();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      btn.disabled = false;
    }
  }
  async function cancel(btn) {
    if (!confirm('Cancel this request?')) return;
    btn.disabled = true;
    try {
      await post(`/api/workspaces/${ws.id}/requests/${r.id}/cancel`);
      $('detail-dialog').close();
      loadRequests();
    } catch (err) { error.textContent = err.message; error.hidden = false; btn.disabled = false; }
  }

  // Files: open in a new tab; the requester can add or remove them until the request is decided.
  const filesUrl = `/api/workspaces/${ws.id}/requests/${r.id}/files`;
  const picker = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,application/pdf', multiple: true, hidden: true,
    onchange: async (e) => {
      try { await uploadFiles(r.id, [...e.target.files]); } catch (err) { alert(err.message); }
      openRequest(r.id);
      loadRequests();
    } });
  const filesSection = (r.files.length || r.can_attach) && h('section', { class: 'files' },
    h('h3', { class: 'timeline-title' }, 'Receipts and files'),
    r.files.length ? h('ul', { class: 'file-list' }, ...r.files.map((f) => h('li', {},
      h('a', { href: `${filesUrl}/${f.id}`, target: '_blank', rel: 'noopener' }, f.content_type === 'application/pdf' ? '📄 ' : '🖼️ ', f.filename),
      h('span', { class: 'muted' }, ` · ${fileSize(f.size_bytes)}`),
      r.can_attach && h('button', { class: 'link-btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Remove ${f.filename}?`)) return;
        try { await send('DELETE', `${filesUrl}/${f.id}`); openRequest(r.id); loadRequests(); } catch (err) { alert(err.message); }
      } }, 'Remove')))) : h('p', { class: 'muted', style: 'margin:0 0 8px' }, 'No files yet. Approvers often ask for a receipt or invoice.'),
    r.can_attach && r.files.length < 5 && h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => picker.click() }, '📎 Attach receipt'),
    picker);

  // Sent back: show what to change, and let the requester edit and resubmit.
  const returned = [...r.approvals].reverse().find((a) => a.status === 'returned');
  const changesNote = r.status === 'changes_requested' && returned && h('div', { class: 'changes-note' },
    h('strong', {}, `${returned.approver_name || 'An approver'} asked for changes`),
    returned.comment && h('p', {}, returned.comment),
    r.can_edit && h('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => { $('detail-dialog').close(); openRequestForm(r); } }, 'Edit and resubmit'));

  // A new round starts each time the request is resubmitted.
  const timeline = [];
  r.approvals.forEach((a, i) => {
    if (i > 0 && a.round !== r.approvals[i - 1].round) timeline.push(h('li', { class: 'round-sep' }, `Resubmitted · round ${a.round}`));
    timeline.push(a);
  });

  $('detail').replaceChildren(...[
    h('div', { class: 'detail-head' }, h('h2', {}, r.title), badge(`st-${r.status}`, STATUS_LABEL[r.status])),
    changesNote,
    h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    r.description && h('p', { class: 'desc' }, r.description),
    filesSection,
    insightPanel(r),
    h('h3', { class: 'timeline-title' }, 'Approvals'),
    h('ol', { class: 'timeline' }, ...timeline.map((a) => (a instanceof Node ? a : h('li', { class: `step step-${a.status}` },
      h('span', { class: 'dot' }),
      h('div', {},
        h('strong', {}, a.step_name), ' ', h('span', { class: 'muted' }, a.approver_name ? `· ${a.approver_name}` : ''),
        h('div', { class: 'step-status' }, STEP_LABEL[a.status], a.decided_at && a.status !== 'skipped' ? ` · ${timeFmt.format(new Date(a.decided_at))}` : ''),
        a.comment && h('div', { class: 'step-comment' }, a.comment),
      ))))),
    r.can_decide && h('div', { class: 'decide' }, comment, error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-danger', type: 'button', onclick: (e) => decide('reject', e.target) }, 'Reject'),
        h('button', { class: 'btn btn-secondary', type: 'button', title: 'Ask the requester to change something and resubmit', onclick: (e) => decide('request_changes', e.target) }, 'Send back'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => decide('approve', e.target) }, 'Approve'))),
    !r.can_decide && error,
    h('div', { class: 'dialog-actions' },
      r.can_cancel && h('button', { class: 'btn btn-secondary', type: 'button', onclick: (e) => cancel(e.target) }, 'Cancel request'),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => $('detail-dialog').close() }, 'Close')),
  ].filter(Boolean));
  $('detail-dialog').showModal();
}

const RISK_LABEL = { low: 'Low risk', medium: 'Worth a look', high: 'High risk' };
function insightPanel(r) {
  const i = r.insight;
  if (!i) return null;
  const flags = [...i.rule_flags.map((f) => ({ ...f, source: 'Check' })), ...i.ai_flags.map((f) => ({ ...f, source: 'AI' }))];
  const aiLine = {
    done: i.summary,
    pending: 'AI review in progress…',
    failed: `AI review unavailable${i.ai_error ? ` (${i.ai_error})` : ''}.`,
    off: null,
  }[i.ai_status];
  return h('section', { class: `insight insight-${i.risk_level}` },
    h('div', { class: 'insight-head' },
      h('span', { class: `risk risk-${i.risk_level}` }, RISK_LABEL[i.risk_level]),
      i.category && h('span', { class: 'category' }, i.category),
      ws.role === 'admin' && i.ai_status !== 'off' && h('button', { class: 'link-btn', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try { await post(`/api/workspaces/${ws.id}/requests/${r.id}/reanalyze`); setTimeout(() => openRequest(r.id), 1500); }
        catch (err) { alert(err.message); e.target.disabled = false; }
      } }, 'Re-run AI')),
    aiLine && h('p', { class: 'insight-summary' }, aiLine),
    flags.length
      ? h('ul', { class: 'flags' }, ...flags.map((f) => h('li', { class: `flag flag-${f.severity}` }, h('span', { class: 'flag-src' }, f.source), f.message)))
      : h('p', { class: 'muted', style: 'margin:0' }, 'No anomalies found.'));
}

// New request form
function syncRequestForm() {
  const type = $('rq-type').value;
  document.querySelectorAll('#request-form .money').forEach((el) => (el.hidden = type === 'time_off'));
  document.querySelector('#request-form .dates').hidden = type !== 'time_off';
  $('vendor-optional').hidden = type === 'purchase';
}
$('rq-type').addEventListener('change', syncRequestForm);

// The same form creates a request, or (editing) resubmits one that was sent back.
let editing = null;
function openRequestForm(r = null) {
  editing = r;
  $('request-form').reset();
  $('rq-error').hidden = true;
  $('rq-form-title').textContent = r ? 'Edit and resubmit' : 'New request';
  $('rq-btn').textContent = r ? 'Resubmit for approval' : 'Submit for approval';
  $('rq-type').disabled = Boolean(r);
  $('rq-files-field').hidden = Boolean(r);
  if (r) {
    $('rq-type').value = r.type;
    $('rq-title').value = r.title;
    $('rq-desc').value = r.description || '';
    if (r.type === 'time_off') { $('rq-start').value = r.start_date; $('rq-end').value = r.end_date; }
    else { $('rq-amount').value = r.amount; $('rq-currency').value = r.currency; $('rq-vendor').value = r.vendor || ''; }
  }
  syncRequestForm();
  $('request-dialog').showModal();
}
$('new-request').addEventListener('click', () => openRequestForm());
$('request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = $('rq-type').value;
  const body = { type, title: $('rq-title').value, description: $('rq-desc').value };
  if (type === 'time_off') Object.assign(body, { start_date: $('rq-start').value, end_date: $('rq-end').value });
  else Object.assign(body, { amount: $('rq-amount').value.replace(/,/g, ''), currency: $('rq-currency').value, vendor: $('rq-vendor').value });
  $('rq-btn').disabled = true;
  $('rq-error').hidden = true;
  try {
    const saved = editing
      ? await post(`/api/workspaces/${ws.id}/requests/${editing.id}/resubmit`, body)
      : await post(`/api/workspaces/${ws.id}/requests`, body);
    // Receipts picked in the form are uploaded once the request exists.
    if (!editing && $('rq-files').files.length) {
      try { await uploadFiles(saved.id, [...$('rq-files').files]); } catch (err) { alert(`The request was submitted, but a file wasn't attached: ${err.message}`); }
    }
    $('request-dialog').close();
    showTab('requests');
    setScope('mine');
    openRequest(saved.id);
  } catch (err) {
    $('rq-error').textContent = err.message;
    $('rq-error').hidden = false;
  } finally {
    $('rq-btn').disabled = false;
  }
});

// ---------- Dashboard ----------

let range = '12m';
document.querySelectorAll('#ranges .chip').forEach((c) => c.addEventListener('click', () => {
  range = c.dataset.range;
  document.querySelectorAll('#ranges .chip').forEach((x) => x.classList.toggle('active', x === c));
  loadDashboard();
}));

const compact = (n, currency) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(n); }
  catch { return String(Math.round(n)); }
};
const monthLabel = (key, long) => new Intl.DateTimeFormat(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short' })
  .format(new Date(`${key}-15T12:00:00`));
const hoursText = (h) => (h == null ? '—' : h < 1 ? 'under 1 h' : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} days`);

// Tooltip shared by every chart.
function showTip(e, html) {
  const tip = $('chart-tip');
  tip.replaceChildren(...html);
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = Math.max(8, e.clientY - tip.offsetHeight - 12);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => { $('chart-tip').hidden = true; };

// Each chart card can switch between the chart and a plain table of the same numbers.
function chartCard(el, title, subtitle, chart, rows) {
  const table = h('table', { class: 'chart-table', hidden: true },
    h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v)))));
  const toggle = h('button', { class: 'link-btn', type: 'button', onclick: () => {
    const showTable = table.hidden;
    table.hidden = !showTable;
    chart.hidden = showTable;
    toggle.textContent = showTable ? 'Chart' : 'Table';
  } }, 'Table');
  el.replaceChildren(
    h('div', { class: 'chart-head' }, h('div', {}, h('h2', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)), toggle),
    chart, table);
}

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};

// Monthly approved spend: columns from one baseline, rounded tops, the latest month labeled.
function monthlyChart(data, currency) {
  const W = 900, H = 260, L = 52, R = 12, T = 20, B = 28;
  const max = niceMax(Math.max(...data.map((d) => d.total)));
  const band = (W - L - R) / data.length;
  const bw = Math.min(24, band * 0.6);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Approved spending per month' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }),
      s('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, compact(v, currency)));
  }
  data.forEach((d, i) => {
    const cx = L + band * i + band / 2;
    const top = y(d.total), base = y(0), hgt = base - top, r = Math.min(4, hgt);
    if (hgt > 0) {
      svg.append(s('path', { class: 'bar', d: `M${cx - bw / 2},${base} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${base} Z` }));
    }
    if (data.length <= 6 || (data.length - 1 - i) % 2 === 0) { // every month, or every other one ending at the latest
      svg.append(s('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, monthLabel(d.month)));
    }
    if (i === data.length - 1 && d.total > 0) svg.append(s('text', { x: cx, y: top - 6, class: 'cap', 'text-anchor': 'middle' }, compact(d.total, currency)));
    // Hit target: the whole column band, not just the bar.
    const hit = s('rect', { x: L + band * i, y: T, width: band, height: H - T - B, class: 'hit' });
    hit.addEventListener('mousemove', (e) => showTip(e, [h('strong', {}, monthLabel(d.month, true)), h('span', {}, money(d.total, currency))]));
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit);
  });
  return svg;
}

// Ranked horizontal bars with the value at each bar's tip.
function barList(items, currency, emptyText) {
  if (!items.length || items.every((i) => !i.total)) return h('p', { class: 'muted chart-empty' }, emptyText);
  const max = Math.max(...items.map((i) => i.total));
  return h('ul', { class: 'hbars' }, ...items.map((i) => h('li', {
    onmousemove: (e) => showTip(e, [h('strong', {}, i.label), h('span', {}, money(i.total, currency))]), onmouseleave: hideTip },
    h('span', { class: 'hbar-label' }, i.label),
    h('span', { class: 'hbar-track' }, h('span', { class: 'hbar', style: `width:${Math.max(1.5, (i.total / max) * 100)}%` }),
      h('span', { class: 'hbar-value' }, compact(i.total, currency))))));
}

async function loadDashboard() {
  $('export-csv').href = `/api/workspaces/${ws.id}/reports/export.csv?range=${range}`;
  let d;
  try { d = await api(`/api/workspaces/${ws.id}/reports?range=${range}`); }
  catch (err) { $('kpis').replaceChildren(h('p', { class: 'error' }, err.message)); return; }
  const c = d.currency;
  $('dash-scope').textContent = (d.scope === 'company' ? 'The whole company' : 'You and the people who report to you')
    + `. Amounts are approved spending in ${c}` + (d.other_currencies.length ? ` (requests in ${d.other_currencies.join(', ')} are not included).` : '.');

  const tile = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, label), h('strong', { class: 'kpi-value' }, value), sub && h('span', { class: 'kpi-sub' }, sub));
  const k = d.kpis;
  $('kpis').replaceChildren(
    tile('Approved this month', money(k.approved_this_month, c), `${money(k.approved_total, c)} in this period`),
    tile('Waiting for a decision', String(k.pending_count), k.pending_amount ? `${money(k.pending_amount, c)} requested` : 'Nothing waiting'),
    tile('Approval rate', k.approval_rate == null ? '—' : `${k.approval_rate}%`, 'of decided requests'),
    tile('Typical time to decide', hoursText(k.median_hours_to_decision), k.high_risk ? `${k.high_risk} high-risk request(s) in this period` : 'No high-risk requests'));

  const monthly = monthlyChart(d.monthly, c);
  chartCard($('chart-monthly'), 'Approved spending by month', 'Purchases and expenses, by the month they were approved', monthly,
    d.monthly.map((m) => [monthLabel(m.month, true), money(m.total, c)]));
  chartCard($('chart-vendors'), 'Top vendors', null, barList(d.top_vendors, c, 'No approved spending yet.'),
    d.top_vendors.map((v) => [v.label, money(v.total, c)]));
  chartCard($('chart-people'), 'Top spenders', null, barList(d.top_people, c, 'No approved spending yet.'),
    d.top_people.map((v) => [v.label, money(v.total, c)]));
  const types = d.by_type.map((t) => ({ ...t, label: TYPE_LABEL[t.label] }));
  chartCard($('chart-types'), 'Purchases vs expenses', null, barList(types, c, 'No approved spending yet.'),
    types.map((v) => [v.label, money(v.total, c)]));
}

// ---------- Members ----------

function renderMembers() {
  const isAdmin = ws.role === 'admin';
  $('member-count').textContent = `${ws.members.length} ${ws.members.length === 1 ? 'person' : 'people'}`;
  $('member-msg').hidden = true;
  const nameOf = (id) => ws.members.find((m) => m.id === id)?.name || '—';

  async function update(member, changes) {
    try {
      await send('PATCH', `/api/workspaces/${ws.id}/members/${member.id}`, changes);
      ws = await api(`/api/workspaces/${ws.id}`);
      renderMembers();
      notice($('member-msg'), `Updated ${member.name}.`, true);
    } catch (err) {
      renderMembers();
      notice($('member-msg'), err.message, false);
    }
  }

  $('members').replaceChildren(...ws.members.map((m) => {
    const roleCell = isAdmin
      ? h('select', { 'aria-label': `Role of ${m.name}`, onchange: (e) => update(m, { role: e.target.value }) },
          ...['employee', 'manager', 'admin'].map((r) => new Option(r[0].toUpperCase() + r.slice(1), r, false, r === m.role)))
      : roleBadge(m.role);
    const managerCell = isAdmin
      ? h('select', { 'aria-label': `Manager of ${m.name}`, onchange: (e) => update(m, { manager_id: e.target.value ? Number(e.target.value) : null }) },
          new Option('— No manager —', '', false, !m.manager_id),
          ...ws.members.filter((x) => x.id !== m.id).map((x) => new Option(x.name, x.id, false, x.id === m.manager_id)))
      : nameOf(m.manager_id);
    const remove = isAdmin && m.id !== me.user.id
      ? h('button', { class: 'link-btn danger', type: 'button', onclick: async () => {
          if (!confirm(`Remove ${m.name} from ${ws.name}?`)) return;
          try {
            await send('DELETE', `/api/workspaces/${ws.id}/members/${m.id}`);
            ws = await api(`/api/workspaces/${ws.id}`);
            renderMembers();
            notice($('member-msg'), `${m.name} was removed.`, true);
          } catch (err) { notice($('member-msg'), err.message, false); }
        } }, 'Remove')
      : '';
    return h('tr', {},
      h('td', {}, h('div', { class: 'person' }, avatarEl(m), h('div', {}, h('strong', {}, m.name + (m.id === me.user.id ? ' (you)' : '')), h('small', {}, m.email)))),
      h('td', {}, roleCell),
      h('td', {}, managerCell),
      isAdmin && h('td', { style: 'text-align:right' }, remove));
  }));
  if (isAdmin) loadInvitations().catch((err) => notice($('invite-msg'), err.message, false));
}

async function loadInvitations() {
  const { invitations } = await api(`/api/workspaces/${ws.id}/invitations`);
  $('pending-table').hidden = invitations.length === 0;
  $('pending').replaceChildren(...invitations.map((inv) => h('tr', {},
    h('td', {}, inv.email),
    h('td', {}, roleBadge(inv.role)),
    h('td', { class: 'hide-sm' }, dateFmt.format(new Date(inv.expires_at))),
    h('td', { style: 'text-align:right' },
      h('button', { class: 'link-btn', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          inviteResult(inv.email, await post(`/api/workspaces/${ws.id}/invitations`, { email: inv.email, role: inv.role }));
          loadInvitations();
        } catch (err) { notice($('invite-msg'), err.message, false); e.target.disabled = false; }
      } }, 'Resend'),
      h('button', { class: 'link-btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Revoke the invitation for ${inv.email}?`)) return;
        try {
          await send('DELETE', `/api/workspaces/${ws.id}/invitations/${inv.id}`);
          notice($('invite-msg'), `Invitation for ${inv.email} revoked.`, true);
          loadInvitations();
        } catch (err) { notice($('invite-msg'), err.message, false); }
      } }, 'Revoke')))));
}

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('invite-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return notice($('invite-msg'), 'Enter a valid email address.', false);
  $('invite-btn').disabled = true;
  try {
    inviteResult(email, await post(`/api/workspaces/${ws.id}/invitations`, { email, role: $('invite-role').value }));
    $('invite-email').value = '';
    loadInvitations();
  } catch (err) {
    notice($('invite-msg'), err.message, false);
  } finally {
    $('invite-btn').disabled = false;
  }
});

// ---------- Approval chains ----------

async function loadChains() {
  const chains = await api(`/api/workspaces/${ws.id}/approval-chains`);
  const isAdmin = ws.role === 'admin';
  $('chains').replaceChildren(...['purchase', 'expense', 'time_off'].map((type) => chainCard(type, chains[type], isAdmin)));
}

function chainCard(type, chain, isAdmin) {
  const list = h('div', { class: 'steps' });
  const msg = h('p', { class: 'notice', hidden: true });

  function stepRow(step = { name: '', approver_type: 'manager', approver_user_id: null, min_amount: null }) {
    const approver = h('select', { 'aria-label': 'Approver', disabled: !isAdmin },
      new Option("Requester's manager", 'manager', false, step.approver_type === 'manager'),
      ...ws.members.map((m) => new Option(m.name, String(m.id), false, step.approver_type === 'user' && step.approver_user_id === m.id)));
    const row = h('div', { class: 'step-row' },
      h('span', { class: 'step-num' }),
      h('input', { type: 'text', value: step.name, placeholder: 'Step name (e.g. Finance)', maxlength: 40, 'aria-label': 'Step name', disabled: !isAdmin }),
      approver,
      type !== 'time_off' && h('input', { type: 'text', inputmode: 'decimal', value: step.min_amount ?? '', placeholder: 'Any amount', 'aria-label': 'Only from amount', disabled: !isAdmin, class: 'min' }),
      isAdmin && h('button', { class: 'link-btn danger', type: 'button', onclick: () => { row.remove(); renumber(); } }, 'Remove'));
    return row;
  }
  function renumber() { list.querySelectorAll('.step-num').forEach((n, i) => (n.textContent = i + 1)); }

  chain.steps.forEach((s) => list.append(stepRow(s)));
  renumber();

  async function save(btn) {
    const steps = [...list.querySelectorAll('.step-row')].map((row) => {
      const [name, min] = [row.querySelector('input[type=text]:not(.min)'), row.querySelector('.min')];
      const approver = row.querySelector('select').value;
      return {
        name: name.value,
        approver_type: approver === 'manager' ? 'manager' : 'user',
        approver_user_id: approver === 'manager' ? null : Number(approver),
        min_amount: min && min.value.trim() ? min.value.replace(/,/g, '') : null,
      };
    });
    btn.disabled = true;
    try {
      await send('PUT', `/api/workspaces/${ws.id}/approval-chains/${type}`, { steps });
      notice(msg, 'Saved. New requests will use this chain.', true);
    } catch (err) {
      notice(msg, err.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  return h('div', { class: 'card chain' },
    h('div', { class: 'card-head' }, h('h2', {}, TYPE_LABEL[type]), chain.default ? h('span', { class: 'muted' }, 'Default') : ''),
    h('div', { class: 'chain-body' },
      type !== 'time_off' && h('div', { class: 'step-row step-head' }, h('span'), h('span', {}, 'Step'), h('span', {}, 'Approver'), h('span', {}, 'Only from amount'), isAdmin && h('span')),
      list,
      msg,
      isAdmin && h('div', { class: 'chain-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { if (list.children.length < 5) { list.append(stepRow()); renumber(); } } }, 'Add step'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => save(e.target) }, 'Save chain'))));
}

// ---------- Audit log ----------

const AUDIT_TEXT = {
  'workspace.created': (d) => `created the workspace "${d.name}"`,
  'invitation.sent': (d) => `invited ${d.email} as ${d.role}`,
  'invitation.revoked': () => 'revoked an invitation',
  'member.joined': (d) => `joined as ${d.role}`,
  'member.role_changed': (d) => `changed ${d.email}'s role from ${d.from} to ${d.to}`,
  'member.manager_changed': (d, e) => `changed who ${d.email} reports to`,
  'member.removed': (d) => `removed ${d.email}`,
  'chain.updated': (d) => `updated the ${TYPE_LABEL[d.type]} approval chain (${d.steps.map((s) => s.name).join(' → ')})`,
  'request.submitted': (d) => `submitted "${d.title}"${d.amount ? ` (${money(d.amount, d.currency)})` : ''}`,
  'request.step_approved': (d) => `approved the ${d.step} step${d.comment ? `: "${d.comment}"` : ''}`,
  'request.approved': (d) => (d.reason ? `auto-approved a request (${d.reason})` : `gave final approval${d.comment ? `: "${d.comment}"` : ''}`),
  'request.rejected': (d) => `rejected at the ${d.step} step: "${d.comment}"`,
  'request.cancelled': (d) => `cancelled "${d.title}"`,
  'request.changes_requested': (d) => `sent a request back for changes at the ${d.step} step: "${d.comment}"`,
  'request.resubmitted': (d) => `resubmitted "${d.title}" (round ${d.round})`,
  'request.file_added': (d) => `attached ${d.filename}`,
  'request.file_removed': (d) => `removed ${d.filename}`,
};

async function loadAudit() {
  const q = auditBefore ? `&before=${auditBefore}` : '';
  const { entries, next_before } = await api(`/api/workspaces/${ws.id}/audit-log?limit=50${q}`);
  auditBefore = next_before;
  $('audit-more-wrap').hidden = !next_before;
  $('audit-rows').append(...entries.map((e) => h('tr', {},
    h('td', { class: 'nowrap' }, timeFmt.format(new Date(e.created_at))),
    h('td', {}, e.actor_name || 'System'),
    h('td', {}, (AUDIT_TEXT[e.action] || (() => e.action))(e.details || {}, e), e.entity_type === 'request' ? h('span', { class: 'muted' }, ` · request #${e.entity_id}`) : ''))));
}
$('audit-more').addEventListener('click', loadAudit);

// ---------- Workspaces ----------

async function createWorkspace(name, errorEl, btn) {
  errorEl.hidden = true;
  if (name.trim().length < 2) {
    errorEl.textContent = 'Enter a name with at least 2 characters.';
    errorEl.hidden = false;
    return false;
  }
  btn.disabled = true;
  try {
    const created = await post('/api/workspaces', { name });
    await load(created.id);
    return true;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    return false;
  } finally {
    btn.disabled = false;
  }
}

$('create-form').addEventListener('submit', (e) => { e.preventDefault(); createWorkspace($('create-name').value, $('create-error'), $('create-btn')); });
$('new-ws').addEventListener('click', () => { $('dialog-name').value = ''; $('dialog-error').hidden = true; $('ws-dialog').showModal(); });
$('dialog-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await createWorkspace($('dialog-name').value, $('dialog-error'), $('dialog-btn'))) $('ws-dialog').close();
});
$('ws-select').addEventListener('change', (e) => showWorkspace(Number(e.target.value)));
$('logout').addEventListener('click', async () => {
  await post('/auth/logout').catch(() => {});
  location.assign('/');
});

// Links from emails: /app?ws=<id>&request=<id>
(async () => {
  const params = new URLSearchParams(location.search);
  const linkWs = Number(params.get('ws')) || null;
  const linkRequest = Number(params.get('request')) || null;
  await load(linkWs);
  if (linkRequest && ws) {
    history.replaceState(null, '', '/app');
    openRequest(linkRequest);
  }
})().catch((err) => console.error(err));
