/* ---------- Utilities ---------- */
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- Data layer ---------- */
const STORAGE_KEY = 'warehouseTrackerData_v1';

const DEFAULT_STATUS_COLORS = ['#2f6fed', '#b4780a', '#7a3fd6', '#1a9e5a', '#d1403f', '#0a9ab4'];

function defaultState() {
  return {
    stores: Array.from({ length: 8 }, (_, i) => ({ id: uid(), name: `Store ${i + 1}` })),
    statuses: [
      { id: uid(), name: 'Received at Warehouse' },
      { id: uid(), name: 'Under Verification' },
      { id: uid(), name: 'Verification Done' },
      { id: uid(), name: 'Ready for Transfer' },
      { id: uid(), name: 'In Transit to Office' },
      { id: uid(), name: 'Transferred to Office' }
    ].map((s, i) => ({ ...s, color: DEFAULT_STATUS_COLORS[i % DEFAULT_STATUS_COLORS.length] })),
    stockItems: [],
    staff: [],
    tasks: [],
    taskCatalog: [
      'Unload delivery truck', 'Stock verification', 'Inventory count',
      'Packing for store transfer', 'Warehouse cleaning'
    ].map(name => ({ id: uid(), name })),
    productCategories: [
      'Apparel & Clothing', 'Footwear', 'Electronics & Accessories',
      'Home & Kitchen', 'Grocery & FMCG', 'Beauty & Personal Care'
    ].map(name => ({ id: uid(), name })),
    deliveries: [],
    dealers: [],
    localPurchases: [],
    localDealers: [],
    lpItemCatalog: [],
    lpBrandModelCatalog: [],
    lpReturnReasons: [],
    stockSerialCounter: 0,
    deliverySerialCounter: 0,
    deliveryStaff: []
  };
}

function nextStockSerial(state) {
  state.stockSerialCounter = (state.stockSerialCounter || 0) + 1;
  return 'SN-' + String(state.stockSerialCounter).padStart(4, '0');
}

function nextDeliverySerial(state) {
  state.deliverySerialCounter = (state.deliverySerialCounter || 0) + 1;
  return 'DEL-' + String(state.deliverySerialCounter).padStart(4, '0');
}

function normalizeState(parsed) {
  if (!parsed || !parsed.stores || !parsed.statuses) return defaultState();
  parsed.stockItems = parsed.stockItems || [];
  parsed.staff = parsed.staff || [];
  parsed.tasks = parsed.tasks || [];
  parsed.taskCatalog = parsed.taskCatalog || [];
  parsed.productCategories = parsed.productCategories || [];
  parsed.deliveries = parsed.deliveries || [];
  parsed.dealers = parsed.dealers || [];
  parsed.localPurchases = parsed.localPurchases || [];
  parsed.localDealers = parsed.localDealers || [];
  parsed.lpItemCatalog = parsed.lpItemCatalog || [];
  parsed.lpBrandModelCatalog = parsed.lpBrandModelCatalog || [];
  parsed.lpReturnReasons = parsed.lpReturnReasons || [];
  parsed.localPurchases.forEach(p => { if (!p.status) p.status = 'RECEIVED'; });
  parsed.stockSerialCounter = parsed.stockSerialCounter || 0;
  parsed.deliverySerialCounter = parsed.deliverySerialCounter || 0;
  parsed.deliveryStaff = parsed.deliveryStaff || [];

  const unserialized = parsed.stockItems.filter(i => !i.serialNumber)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  unserialized.forEach(item => { item.serialNumber = nextStockSerial(parsed); });

  const unidentifiedDeliveries = parsed.deliveries.filter(d => !d.deliveryId)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  unidentifiedDeliveries.forEach(d => { d.deliveryId = nextDeliverySerial(parsed); });

  /* Deliveries used to hold a single transferId; they can now carry
     several (e.g. multiple transfers going out on one truck run). */
  parsed.deliveries.forEach(d => {
    if (!Array.isArray(d.transferIds)) d.transferIds = d.transferId ? [d.transferId] : [];
    delete d.transferId;
  });

  /* One-time migration: deliveries used to reference the general Staff
     list. Move anyone who was ever assigned a delivery into their own
     Delivery Staff list, and remap those deliveries to point there. */
  if (parsed.deliveryStaff.length === 0) {
    const usedStaffIds = new Set(parsed.deliveries.map(d => d.staffId).filter(Boolean));
    const idMap = {};
    usedStaffIds.forEach(oldId => {
      const staffMember = parsed.staff.find(s => s.id === oldId);
      if (staffMember) {
        const newId = uid();
        idMap[oldId] = newId;
        parsed.deliveryStaff.push({
          id: newId, empId: staffMember.empId || '', name: staffMember.name,
          phone: '', active: staffMember.active !== false
        });
      }
    });
    parsed.deliveries.forEach(d => { if (d.staffId && idMap[d.staffId]) d.staffId = idMap[d.staffId]; });
  }

  /* Deliveries used to reference a single staffId; a delivery can now be
     assigned to multiple delivery staff, so it holds a staffIds array. */
  parsed.deliveries.forEach(d => {
    if (!Array.isArray(d.staffIds)) d.staffIds = d.staffId ? [d.staffId] : [];
    delete d.staffId;
  });

  return parsed;
}

function loadFromLocalCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch (e) {
    return null;
  }
}

let state = loadFromLocalCache() || defaultState();
let serverReachable = true;
let saveInFlight = false;
let saveQueued = false;

/* Every save() writes to the local cache immediately (instant, never
   fails) and pushes the same snapshot to the shared server in the
   background, so a phone/PC losing WiFi mid-edit doesn't lose data
   entered so far -- it just can't sync until the connection returns. */
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  pushToServer();
}

async function pushToServer() {
  if (saveInFlight) { saveQueued = true; return; }
  saveInFlight = true;
  const snapshot = JSON.stringify(state);
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot
    });
    if (res.status === 401) { handleSessionExpired(); return; }
    if (res.status === 403) { showToast('View-only account — changes are not saved to the server'); return; }
    if (!res.ok) throw new Error('Server rejected save');
    if (!serverReachable) { serverReachable = true; showToast('Back online — synced'); }
  } catch (e) {
    if (serverReachable) showToast('Offline — changes saved on this device only');
    serverReachable = false;
  } finally {
    saveInFlight = false;
    if (saveQueued) { saveQueued = false; pushToServer(); }
  }
}

let pollTimer = null;

async function bootFromServer() {
  try {
    const res = await fetch('/api/state');
    if (res.status === 401) { handleSessionExpired(); return; }
    if (!res.ok) throw new Error('Bad response');
    const data = await res.json();
    state = normalizeState(data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Could not reach server, using local data for now', e);
    serverReachable = false;
    showToast('Could not connect to server — showing data saved on this device');
  }
  initDashboardDates();
  renderDashboard();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollServer, 20000);
}

/* Picks up other devices' changes. Skipped while this device has a save
   in flight/queued, so it never clobbers an edit the user just made. */
async function pollServer() {
  // Skip entirely while a save is pending or a modal is open, so we never
  // swap the shared `state` object out from under an in-progress edit
  // (the open form's submit handler holds a reference into the old state).
  if (saveInFlight || saveQueued || !modalOverlay.hidden || !historyOverlay.hidden) return;
  try {
    const res = await fetch('/api/state');
    if (res.status === 401) { handleSessionExpired(); return; }
    if (!res.ok) return;
    const data = await res.json();
    const fresh = normalizeState(data);
    const freshJson = JSON.stringify(fresh);
    if (freshJson !== JSON.stringify(state)) {
      state = fresh;
      localStorage.setItem(STORAGE_KEY, freshJson);
      const activeBtn = document.querySelector('.nav-btn.active');
      if (activeBtn) switchView(activeBtn.dataset.view);
    }
    serverReachable = true;
  } catch (e) {
    serverReachable = false;
  }
}

/* ---------- Navigation ---------- */
const views = ['dashboard', 'stock', 'tasks', 'deliveries', 'reports', 'staff', 'deliveryStaff', 'stores', 'dealers', 'localPurchases', 'settings', 'users'];
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => { switchView(btn.dataset.view); closeMobileSidebar(); });
});

/* Mobile off-canvas sidebar */
function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarBackdrop').hidden = false;
  document.getElementById('sidebarBackdrop').classList.add('open');
}
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
  document.getElementById('sidebarBackdrop').hidden = true;
}
document.getElementById('mobileMenuBtn').addEventListener('click', openMobileSidebar);
document.getElementById('sidebarCloseBtn').addEventListener('click', closeMobileSidebar);
document.getElementById('sidebarBackdrop').addEventListener('click', closeMobileSidebar);
function switchView(name) {
  views.forEach(v => {
    document.getElementById('view-' + v).classList.toggle('active', v === name);
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'dashboard') renderDashboard();
  if (name === 'stock') renderStock();
  if (name === 'tasks') renderTasks();
  if (name === 'deliveries') renderDeliveries();
  if (name === 'reports') renderReports();
  if (name === 'staff') renderStaff();
  if (name === 'deliveryStaff') renderDeliveryStaff();
  if (name === 'stores') renderStores();
  if (name === 'dealers') renderDealers();
  if (name === 'localPurchases') renderLocalPurchases();
  if (name === 'settings') renderSettings();
  if (name === 'users') renderUsers();
  applyModuleReadonly(name);
}

/* ---------- Modal helper ---------- */
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

function openModal(title, bodyHtml, onMount) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOverlay.hidden = false;
  if (onMount) onMount(modalBody);
}
/* Reusable multi-select dropdown (checkboxes in a popover). Returns
   {el, getSelected()}. A single delegated document click-listener
   (registered once, at the bottom of this file) closes any open panel
   when the click lands outside its .multiselect wrapper. */
function buildStoreMultiSelect(selectedIds) {
  const selected = new Set(selectedIds || []);
  const wrap = document.createElement('div');
  wrap.className = 'multiselect';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'multiselect-toggle';
  btn.innerHTML = `<span class="ms-label"></span><span class="ms-caret">&#9662;</span>`;

  const panel = document.createElement('div');
  panel.className = 'multiselect-panel';
  panel.hidden = true;

  function updateLabel() {
    const label = btn.querySelector('.ms-label');
    if (selected.size === 0) { label.textContent = 'Related store(s) (optional)'; return; }
    const names = state.stores.filter(s => selected.has(s.id)).map(s => s.name);
    label.textContent = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  }

  if (state.stores.length === 0) {
    panel.innerHTML = `<div style="padding:6px 8px;color:var(--text-muted);font-size:12.5px">No stores set up yet.</div>`;
  }
  state.stores.forEach(store => {
    const row = document.createElement('label');
    row.className = 'multiselect-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = store.id;
    cb.checked = selected.has(store.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(store.id); else selected.delete(store.id);
      updateLabel();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(store.name));
    panel.appendChild(row);
  });

  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  updateLabel();
  wrap.appendChild(btn);
  wrap.appendChild(panel);
  return { el: wrap, getSelected: () => [...selected] };
}

/* Same pattern as buildStoreMultiSelect, for assigning a delivery to
   more than one delivery staff member at once. */
function buildDeliveryStaffMultiSelect(selectedIds) {
  const selected = new Set(selectedIds || []);
  const wrap = document.createElement('div');
  wrap.className = 'multiselect';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'multiselect-toggle';
  btn.innerHTML = `<span class="ms-label"></span><span class="ms-caret">&#9662;</span>`;

  const panel = document.createElement('div');
  panel.className = 'multiselect-panel';
  panel.hidden = true;

  function updateLabel() {
    const label = btn.querySelector('.ms-label');
    if (selected.size === 0) { label.textContent = 'Delivery staff'; return; }
    const names = state.deliveryStaff.filter(s => selected.has(s.id)).map(deliveryPersonLabel);
    label.textContent = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  }

  const activeStaff = state.deliveryStaff.filter(s => s.active !== false);
  if (activeStaff.length === 0) {
    panel.innerHTML = `<div style="padding:6px 8px;color:var(--text-muted);font-size:12.5px">No delivery staff set up yet.</div>`;
  }
  activeStaff.forEach(person => {
    const row = document.createElement('label');
    row.className = 'multiselect-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = person.id;
    cb.checked = selected.has(person.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(person.id); else selected.delete(person.id);
      updateLabel();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(deliveryPersonLabel(person)));
    panel.appendChild(row);
  });

  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  updateLabel();
  wrap.appendChild(btn);
  wrap.appendChild(panel);
  return { el: wrap, getSelected: () => [...selected] };
}

/* Freeform "add multiple values" input: type a value, press Enter or
   click +Add, it becomes a removable chip. Used for entering more than
   one Transfer ID on a single delivery. Returns {el, getValues()}. */
function buildTagInput(initialValues, placeholder) {
  const values = [...(initialValues || [])];
  const wrap = document.createElement('div');

  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex;gap:6px';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder || 'Add a value...';
  input.style.flex = '1';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'secondary-btn';
  addBtn.textContent = '+ Add';
  inputRow.appendChild(input);
  inputRow.appendChild(addBtn);

  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px';

  function renderChips() {
    chips.innerHTML = '';
    values.forEach((val, idx) => {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#eef1f5;border-radius:12px;padding:2px 8px;font-size:12px';
      chip.textContent = val;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'border:none;background:none;cursor:pointer;font-size:14px;line-height:1;color:var(--text-muted);padding:0';
      removeBtn.addEventListener('click', () => { values.splice(idx, 1); renderChips(); });
      chip.appendChild(removeBtn);
      chips.appendChild(chip);
    });
  }

  function addValue() {
    const val = input.value.trim();
    if (!val) return;
    values.push(val);
    input.value = '';
    renderChips();
    input.focus();
  }
  addBtn.addEventListener('click', addValue);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addValue(); }
  });

  renderChips();
  wrap.appendChild(inputRow);
  wrap.appendChild(chips);
  return { el: wrap, getValues: () => [...values] };
}

/* Reusable searchable single-select ("dropdown with a search bar"):
   a text input that filters a list of options as you type; you must
   click a matching option to set a value (typing alone doesn't count,
   so the result is always a real catalog entry, never free text).
   Reuses .multiselect/.multiselect-panel so it gets the same
   click-outside-to-close behavior as the multi-select above for free. */
function buildSearchSelect({ items, getId, getLabel, initialId, placeholder, onSelect, disabled }) {
  let selectedId = initialId || null;
  const wrap = document.createElement('div');
  wrap.className = 'multiselect';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'multiselect-toggle';
  input.placeholder = placeholder || 'Search...';
  input.autocomplete = 'off';
  if (disabled) input.disabled = true;

  const panel = document.createElement('div');
  panel.className = 'multiselect-panel';
  panel.hidden = true;

  function renderOptions(query) {
    const q = (query || '').trim().toLowerCase();
    const matches = q ? items.filter(it => getLabel(it).toLowerCase().includes(q)) : items;
    panel.innerHTML = '';
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:6px 8px;color:var(--text-muted);font-size:12.5px';
      empty.textContent = 'No matches.';
      panel.appendChild(empty);
      return;
    }
    matches.forEach(it => {
      const row = document.createElement('div');
      row.className = 'multiselect-option';
      row.style.cursor = 'pointer';
      row.textContent = getLabel(it);
      row.addEventListener('mousedown', ev => {
        ev.preventDefault();
        selectedId = getId(it);
        input.value = getLabel(it);
        panel.hidden = true;
        if (onSelect) onSelect(it);
      });
      panel.appendChild(row);
    });
  }

  input.addEventListener('focus', () => { renderOptions(input.value); panel.hidden = false; });
  input.addEventListener('input', () => { selectedId = null; renderOptions(input.value); panel.hidden = false; });

  if (initialId) {
    const found = items.find(it => getId(it) === initialId);
    if (found) input.value = getLabel(found);
  }

  wrap.appendChild(input);
  wrap.appendChild(panel);
  return { el: wrap, getValue: () => selectedId };
}

document.addEventListener('click', e => {
  document.querySelectorAll('.multiselect').forEach(ms => {
    if (!ms.contains(e.target)) {
      const panel = ms.querySelector('.multiselect-panel');
      if (panel) panel.hidden = true;
    }
  });
});

function closeModal() {
  modalOverlay.hidden = true;
  modalBody.innerHTML = '';
}

const historyOverlay = document.getElementById('historyOverlay');
const historyBody = document.getElementById('historyBody');
document.getElementById('historyClose').addEventListener('click', () => historyOverlay.hidden = true);
historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) historyOverlay.hidden = true; });

/* =========================================================
   DASHBOARD
   ========================================================= */
function currentRange() {
  const from = document.getElementById('dashFrom').value || todayStr();
  const to = document.getElementById('dashTo').value || todayStr();
  return { from, to };
}

function initDashboardDates() {
  document.getElementById('dashFrom').value = todayStr();
  document.getElementById('dashTo').value = todayStr();
}

document.querySelectorAll('.chip[data-range]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-range]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const today = new Date();
    let from = new Date(today), to = new Date(today);
    if (chip.dataset.range === 'week') {
      const day = today.getDay(); // 0 = Sunday
      const diffToMonday = (day === 0 ? 6 : day - 1);
      from = new Date(today); from.setDate(today.getDate() - diffToMonday);
    } else if (chip.dataset.range === 'month') {
      from = new Date(today.getFullYear(), today.getMonth(), 1);
    }
    document.getElementById('dashFrom').value = toInputDate(from);
    document.getElementById('dashTo').value = toInputDate(to);
    renderDashboard();
  });
});
function toInputDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
document.getElementById('dashFrom').addEventListener('change', renderDashboard);
document.getElementById('dashTo').addEventListener('change', renderDashboard);

function renderDashboard() {
  const { from, to } = currentRange();
  const tasksInRange = state.tasks.filter(t => t.date >= from && t.date <= to);
  const total = tasksInRange.length;
  const completed = tasksInRange.filter(t => t.status === 'completed').length;
  const overallPct = total ? Math.round((completed / total) * 100) : 0;

  const inPipeline = state.stockItems.filter(s => {
    const last = state.statuses[state.statuses.length - 1];
    return !last || s.statusId !== last.id;
  }).length;
  const transferred = state.stockItems.length - inPipeline;
  const avgStockProgress = state.stockItems.length
    ? Math.round(state.stockItems.reduce((sum, s) => sum + statusProgressPct(s.statusId), 0) / state.stockItems.length)
    : 0;
  const delayedStockCount = state.stockItems.filter(isStockDelayed).length;
  const unassignedDeliveryCount = state.deliveries.filter(d => !d.staffIds || d.staffIds.length === 0).length;
  const delayedDeliveryCount = state.deliveries.filter(isDeliveryDelayed).length;

  const deliveriesInRange = state.deliveries.filter(d => d.date >= from && d.date <= to);
  const deliveredCount = deliveriesInRange.filter(d => d.status === 'delivered').length;
  const inTransitCount = deliveriesInRange.filter(d => d.status === 'in_transit').length;
  const pendingOnlyCount = deliveriesInRange.filter(d => d.status === 'pending').length;
  const packagesDelivered = deliveriesInRange.filter(d => d.status === 'delivered')
    .reduce((sum, d) => sum + (Number(d.packages) || 0), 0);

  document.getElementById('summaryCards').innerHTML = `
    <div class="card"><div class="card-value">${total}</div><div class="card-label">Tasks assigned (range)</div></div>
    <div class="card"><div class="card-value">${completed}</div><div class="card-label">Tasks completed</div></div>
    <div class="card"><div class="card-value">${overallPct}%</div><div class="card-label">Overall completion</div></div>
    <div class="card"><div class="card-value">${inPipeline}</div><div class="card-label">Stock items in pipeline</div></div>
    <div class="card"><div class="card-value">${transferred}</div><div class="card-label">Stock transferred to office</div></div>
    <div class="card"><div class="card-value">${avgStockProgress}%</div><div class="card-label">Average stock progress</div></div>
    <div class="card" style="${delayedStockCount ? 'border-color:#f4c6c5' : ''}"><div class="card-value" style="${delayedStockCount ? 'color:var(--red)' : ''}">${delayedStockCount}</div><div class="card-label">Stock delayed (${DELAY_THRESHOLD_DAYS}+ days)</div></div>
    <div class="card"><div class="card-value">${deliveredCount}/${deliveriesInRange.length}</div><div class="card-label">Deliveries completed (range)</div></div>
    <div class="card"><div class="card-value">${inTransitCount}</div><div class="card-label">Deliveries in transit</div></div>
    <div class="card"><div class="card-value">${pendingOnlyCount}</div><div class="card-label">Deliveries pending</div></div>
    <div class="card"><div class="card-value">${packagesDelivered}</div><div class="card-label">Packages delivered (range)</div></div>
    <div class="card" style="${unassignedDeliveryCount ? 'border-color:#f4c6c5' : ''}"><div class="card-value" style="${unassignedDeliveryCount ? 'color:var(--red)' : ''}">${unassignedDeliveryCount}</div><div class="card-label">Deliveries awaiting a person</div></div>
    <div class="card" style="${delayedDeliveryCount ? 'border-color:#f4c6c5' : ''}"><div class="card-value" style="${delayedDeliveryCount ? 'color:var(--red)' : ''}">${delayedDeliveryCount}</div><div class="card-label">Deliveries delayed (${DELAY_THRESHOLD_DAYS}+ days)</div></div>
  `;

  const activeStaff = state.staff.filter(s => s.active !== false);
  const rows = activeStaff.map(person => {
    const mine = tasksInRange.filter(t => t.staffId === person.id);
    const done = mine.filter(t => t.status === 'completed').length;
    const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
    const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : pct > 0 ? 'var(--amber)' : '#c9d0da';
    return `
      <div class="employee-row">
        <div class="employee-name">${escapeHtml(staffLabel(person))}</div>
        <div class="employee-bar-track"><div class="employee-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="employee-pct">${pct}%</div>
        <div class="employee-count">${done}/${mine.length} done</div>
      </div>`;
  }).join('');

  document.getElementById('employeeCompletion').innerHTML = rows ||
    `<div class="empty-state">No staff yet. Add staff in the Staff tab, then assign tasks.</div>`;

  const activeDeliveryStaff = state.deliveryStaff.filter(s => s.active !== false);
  const staffWithDeliveries = activeDeliveryStaff.filter(person => deliveriesInRange.some(d => (d.staffIds || []).includes(person.id)));
  const deliveryRows = staffWithDeliveries.map(person => {
    const mine = deliveriesInRange.filter(d => (d.staffIds || []).includes(person.id));
    const done = mine.filter(d => d.status === 'delivered').length;
    const packages = mine.reduce((sum, d) => sum + (Number(d.packages) || 0), 0);
    const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
    const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : pct > 0 ? 'var(--amber)' : '#c9d0da';
    return `
      <div class="employee-row">
        <div class="employee-name">${escapeHtml(deliveryPersonLabel(person))}</div>
        <div class="employee-bar-track"><div class="employee-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="employee-pct">${pct}%</div>
        <div class="employee-count">${done}/${mine.length} · ${packages} pkgs</div>
      </div>`;
  }).join('');

  document.getElementById('deliveryCompletion').innerHTML = deliveryRows ||
    `<div class="empty-state">No deliveries in this range yet.</div>`;

  const stockInRange = state.stockItems.filter(s => s.receivedDate >= from && s.receivedDate <= to);
  const stockSerialRows = [...stockInRange]
    .sort((a, b) => (a.serialNumber || '').localeCompare(b.serialNumber || ''))
    .map(item => {
      const stageIdx = state.statuses.findIndex(s => s.id === item.statusId);
      const totalStages = state.statuses.length;
      const pct = statusProgressPct(item.statusId);
      const delayed = isStockDelayed(item);
      const color = delayed ? 'var(--red)' : pct >= 100 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : pct > 0 ? 'var(--amber)' : '#c9d0da';
      return `
        <div class="employee-row">
          <div class="employee-name">${escapeHtml(item.serialNumber || '—')}${delayed ? ' <span style="color:var(--red);font-size:11px;font-weight:600">DELAYED</span>' : ''}</div>
          <div class="employee-bar-track"><div class="employee-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="employee-pct">${pct}%</div>
          <div class="employee-count">${stageIdx >= 0 ? stageIdx + 1 : 0}/${totalStages} done</div>
        </div>`;
    }).join('');

  document.getElementById('stockSerialProgress').innerHTML = stockSerialRows ||
    `<div class="empty-state">No stock received in this date range.</div>`;

  const pipelineRows = state.statuses.map(st => {
    const count = state.stockItems.filter(s => s.statusId === st.id).length;
    const pct = statusProgressPct(st.id);
    return `<div class="pipeline-row"><span><span class="status-dot" style="display:inline-block;background:${st.color}"></span> ${escapeHtml(st.name)} <span style="color:var(--text-muted)">(${pct}%)</span></span><span class="pipeline-count">${count}</span></div>`;
  }).join('');
  document.getElementById('stockPipeline').innerHTML = pipelineRows ||
    `<div class="empty-state">No stock entries yet.</div>`;

  const storesWithPendingDeliveries = state.stores.filter(store =>
    state.deliveries.some(d => d.storeId === store.id && d.status !== 'delivered'));
  const deliveryByStoreRows = storesWithPendingDeliveries.map(store => {
    const outstanding = state.deliveries.filter(d => d.storeId === store.id && d.status !== 'delivered');
    const packages = outstanding.reduce((sum, d) => sum + (Number(d.packages) || 0), 0);
    return `<div class="pipeline-row"><span>${escapeHtml(store.name)}</span><span class="pipeline-count">${outstanding.length} outstanding · ${packages} pkgs</span></div>`;
  }).join('');
  document.getElementById('deliveryByStore').innerHTML = deliveryByStoreRows ||
    `<div class="empty-state">No pending deliveries.</div>`;

  const recentDeliveries = [...deliveriesInRange]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 8);
  document.getElementById('recentDeliveriesBody').innerHTML = recentDeliveries.map(d => {
    const store = storeById(d.storeId);
    const staffNames = deliveryStaffLabel(d);
    return `
      <tr>
        <td>${escapeHtml(d.deliveryId || '—')}</td>
        <td>${escapeHtml(deliveryTransferIdsLabel(d) || '—')}</td>
        <td>${escapeHtml(store ? store.name : 'Unknown store')}</td>
        <td>${escapeHtml(d.packages)}</td>
        <td>${staffNames ? escapeHtml(staffNames) : '<span class="badge badge-pending">Unassigned</span>'}</td>
        <td>${deliveryStatusBadgeHtml(d.status)}</td>
      </tr>`;
  }).join('');
  document.getElementById('recentDeliveriesEmpty').hidden = recentDeliveries.length !== 0;
}

/* =========================================================
   STOCK TRACKING
   ========================================================= */
function statusById(id) { return state.statuses.find(s => s.id === id); }
function stockQuantityLabel(item) {
  return (item.quantity != null && item.quantity !== '')
    ? escapeHtml(item.quantity)
    : '<span style="color:var(--text-muted)">Pending verification</span>';
}
function packagesCountLabel(item) {
  return (item.packagesCount != null && item.packagesCount !== '')
    ? escapeHtml(item.packagesCount)
    : '—';
}

/* First status = 0%, last status = 100%, evenly spread in between. */
function statusProgressPct(statusId) {
  const idx = state.statuses.findIndex(s => s.id === statusId);
  if (idx < 0) return 0;
  if (state.statuses.length <= 1) return 100;
  return Math.round((idx / (state.statuses.length - 1)) * 100);
}
const DELAY_THRESHOLD_DAYS = 5;
function daysSince(dateStr) {
  if (!dateStr) return 0;
  const then = new Date(dateStr + 'T00:00:00');
  const today = new Date(todayStr() + 'T00:00:00');
  return Math.max(0, Math.round((today - then) / (1000 * 60 * 60 * 24)));
}
function isStockDelayed(item) {
  return statusProgressPct(item.statusId) !== 100 && daysSince(item.receivedDate) > DELAY_THRESHOLD_DAYS;
}
function isDeliveryDelayed(delivery) {
  return delivery.status !== 'delivered' && daysSince(delivery.date) > DELAY_THRESHOLD_DAYS;
}

function storeById(id) { return state.stores.find(s => s.id === id); }
function staffById(id) { return state.staff.find(s => s.id === id); }
function staffLabel(person) { return person ? (person.empId ? `${person.name} (${person.empId})` : person.name) : ''; }

/* Delivery staff are a separate roster from task Staff -- see the
   "Delivery Staff" tab. Deliveries reference deliveryStaff ids only. */
function deliveryPersonById(id) { return state.deliveryStaff.find(s => s.id === id); }
function deliveryPersonLabel(person) { return person ? (person.empId ? `${person.name} (${person.empId})` : person.name) : ''; }
/* A delivery can be assigned to more than one delivery staff member at once. */
function deliveryStaffLabel(delivery) {
  const names = (delivery.staffIds || [])
    .map(id => deliveryPersonById(id))
    .filter(Boolean)
    .map(deliveryPersonLabel);
  return names.join(', ');
}
function deliveryTransferIdsLabel(delivery) {
  return (delivery.transferIds || []).join(', ');
}

function categoryById(id) { return state.productCategories.find(c => c.id === id); }
function dealerById(id) { return state.dealers.find(d => d.id === id); }
function dealerLabel(item) {
  const dealer = item.dealerId ? dealerById(item.dealerId) : null;
  return dealer ? dealer.name : (item.dealerName || '—');
}

function populateStockFilters() {
  const catSel = document.getElementById('stockFilterCategory');
  const dealerSel = document.getElementById('stockFilterDealer');
  const statusSel = document.getElementById('stockFilterStatus');
  const catCurrent = catSel.value, dealerCurrent = dealerSel.value, statusCurrent = statusSel.value;
  catSel.innerHTML = '<option value="">All categories</option>' +
    state.productCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  dealerSel.innerHTML = '<option value="">All dealers</option>' +
    state.dealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  statusSel.innerHTML = '<option value="">All statuses</option>' +
    state.statuses.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  catSel.value = catCurrent; dealerSel.value = dealerCurrent; statusSel.value = statusCurrent;
}

document.getElementById('stockFilterCategory').addEventListener('change', renderStock);
document.getElementById('stockFilterDealer').addEventListener('change', renderStock);
document.getElementById('stockFilterStatus').addEventListener('change', renderStock);
document.getElementById('stockSearchSerial').addEventListener('input', renderStock);

let stockTab = 'active';
document.querySelectorAll('.chip[data-stock-tab]').forEach(chip => {
  chip.addEventListener('click', () => {
    stockTab = chip.dataset.stockTab;
    document.querySelectorAll('.chip[data-stock-tab]').forEach(c => c.classList.toggle('active', c === chip));
    renderStock();
  });
});

function progressBarHtml(pct) {
  const color = pct >= 100 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : pct > 0 ? 'var(--amber)' : '#c9d0da';
  return `
    <div style="display:flex;align-items:center;gap:8px;min-width:110px">
      <div class="employee-bar-track" style="flex:1"><div class="employee-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span style="font-size:12px;font-weight:600;width:34px;text-align:right">${pct}%</span>
    </div>`;
}

function renderStock() {
  populateStockFilters();
  const categoryFilter = document.getElementById('stockFilterCategory').value;
  const dealerFilter = document.getElementById('stockFilterDealer').value;
  const statusFilter = document.getElementById('stockFilterStatus').value;
  const serialSearch = document.getElementById('stockSearchSerial').value.trim().toLowerCase();

  let items = [...state.stockItems];
  items = items.filter(i => {
    const completed = statusProgressPct(i.statusId) === 100;
    const delayed = isStockDelayed(i);
    if (stockTab === 'completed') return completed;
    if (stockTab === 'delayed') return delayed;
    return !completed && !delayed;
  });
  if (categoryFilter) items = items.filter(i => i.categoryId === categoryFilter);
  if (dealerFilter) items = items.filter(i => i.dealerId === dealerFilter);
  if (statusFilter) items = items.filter(i => i.statusId === statusFilter);
  if (serialSearch) items = items.filter(i => (i.serialNumber || '').toLowerCase().includes(serialSearch));

  items.sort(stockTab === 'delayed'
    ? (a, b) => daysSince(b.receivedDate) - daysSince(a.receivedDate)
    : (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const tbody = document.getElementById('stockTableBody');
  tbody.innerHTML = items.map(item => {
    const status = statusById(item.statusId);
    const category = categoryById(item.categoryId);
    const lastHist = item.history[item.history.length - 1];
    const pct = statusProgressPct(item.statusId);
    const days = daysSince(item.receivedDate);
    const delayed = isStockDelayed(item);
    return `
      <tr${delayed ? ' style="background:var(--red-soft)"' : ''}>
        <td><strong>${escapeHtml(item.serialNumber || '—')}</strong></td>
        <td>${escapeHtml(category ? category.name : 'Uncategorized')}${item.notes ? `<div style="color:var(--text-muted);font-size:11.5px;margin-top:2px">${escapeHtml(item.notes)}</div>` : ''}</td>
        <td>${stockQuantityLabel(item)}</td>
        <td>${packagesCountLabel(item)}</td>
        <td>${escapeHtml(dealerLabel(item))}</td>
        <td>${fmtDate(item.receivedDate)}</td>
        <td style="${delayed ? 'color:var(--red);font-weight:600' : ''}">${days}d</td>
        <td>
          <select class="status-select" data-id="${item.id}">
            ${state.statuses.map(s => `<option value="${s.id}" ${s.id === item.statusId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>
        </td>
        <td>${progressBarHtml(pct)}</td>
        <td>${lastHist ? fmtDateTime(lastHist.at) : '—'}</td>
        <td class="row-actions">
          <button class="link-btn" data-history="${item.id}">History</button>
          <button class="link-btn" data-edit-stock="${item.id}">Edit</button>
          <button class="danger-btn" data-del-stock="${item.id}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  const emptyEl = document.getElementById('stockEmpty');
  emptyEl.hidden = items.length !== 0;
  emptyEl.textContent = stockTab === 'completed'
    ? 'No completed stock yet — items land here once they reach the last status (100%).'
    : stockTab === 'delayed'
    ? `Nothing delayed — no active stock has been pending more than ${DELAY_THRESHOLD_DAYS} days.`
    : 'No active stock entries. Click "Add received stock" to log one.';

  const allCompletedCount = state.stockItems.filter(i => statusProgressPct(i.statusId) === 100).length;
  const allDelayedCount = state.stockItems.filter(isStockDelayed).length;
  const allActiveCount = state.stockItems.length - allCompletedCount - allDelayedCount;
  document.querySelector('.chip[data-stock-tab="active"]').textContent = `Active stock (${allActiveCount})`;
  document.querySelector('.chip[data-stock-tab="delayed"]').textContent = `Delayed (${DELAY_THRESHOLD_DAYS}+ days) (${allDelayedCount})`;
  document.querySelector('.chip[data-stock-tab="completed"]').textContent = `Completed stock (${allCompletedCount})`;

  tbody.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const newStatusId = sel.value;
      const item = state.stockItems.find(i => i.id === sel.dataset.id);
      if (isVerificationDoneStatus(newStatusId)) {
        const prevStatusId = item.statusId;
        sel.value = prevStatusId; // revert until quantity is confirmed; renderStock() sets the real value after
        promptStockVerificationQuantity(item.quantity, qty => {
          item.quantity = qty;
          changeStockStatus(item.id, newStatusId, `Verified quantity: ${qty}`);
        });
        return;
      }
      changeStockStatus(sel.dataset.id, newStatusId);
    });
  });
  tbody.querySelectorAll('[data-history]').forEach(btn => {
    btn.addEventListener('click', () => showHistory(btn.dataset.history));
  });
  tbody.querySelectorAll('[data-edit-stock]').forEach(btn => {
    btn.addEventListener('click', () => openStockForm(btn.dataset.editStock));
  });
  tbody.querySelectorAll('[data-del-stock]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this stock entry? This cannot be undone.')) {
        state.stockItems = state.stockItems.filter(i => i.id !== btn.dataset.delStock);
        save(); renderStock(); renderDashboard();
        showToast('Stock entry deleted');
      }
    });
  });
}

/* Stock quantity isn't collected when an item is first logged in --
   it's only known for sure once verification is done, so it's asked
   for at that specific transition instead (see openStockForm and the
   .status-select handler in renderStock). Unit is always "No of Packages". */
function isVerificationDoneStatus(statusId) {
  const s = statusById(statusId);
  return !!s && s.name.trim().toLowerCase() === 'verification done';
}
function promptStockVerificationQuantity(existingQuantity, onConfirm) {
  openModal('Verification done — enter quantity', `
    <form id="verifyQtyForm">
      <div class="form-group">
        <label>Quantity</label>
        <input type="number" id="f-verifyQty" min="0" step="any" required value="${existingQuantity != null ? existingQuantity : ''}">
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">Confirm</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#verifyQtyForm').addEventListener('submit', e => {
      e.preventDefault();
      const qty = document.getElementById('f-verifyQty').value;
      if (qty === '') return;
      closeModal();
      onConfirm(qty);
    });
  });
}

function changeStockStatus(itemId, newStatusId, note) {
  const item = state.stockItems.find(i => i.id === itemId);
  if (!item) return;
  item.statusId = newStatusId;
  item.history.push({ statusId: newStatusId, note: note || '', at: new Date().toISOString() });
  save();
  renderStock();
  renderDashboard();
  showToast(statusProgressPct(newStatusId) === 100
    ? `${item.serialNumber || 'Item'} reached 100% — moved to Completed stock`
    : 'Status updated');
}

function showHistory(itemId) {
  const item = state.stockItems.find(i => i.id === itemId);
  if (!item) return;
  const category = categoryById(item.categoryId);
  const rows = [...item.history].reverse().map(h => {
    const st = statusById(h.statusId);
    return `<li>
      <div class="t-status">${escapeHtml(st ? st.name : 'Unknown status')}</div>
      <div class="t-meta">${fmtDateTime(h.at)}</div>
      ${h.note ? `<div class="t-note">${escapeHtml(h.note)}</div>` : ''}
    </li>`;
  }).join('');
  historyBody.innerHTML = `
    <p style="margin-top:0"><strong>${escapeHtml(item.serialNumber || '—')}</strong> · ${escapeHtml(category ? category.name : 'Uncategorized')} — ${stockQuantityLabel(item)}</p>
    <p style="margin-top:-8px;color:var(--text-muted);font-size:12.5px">
      No of Packages: ${packagesCountLabel(item)}<br>
      Dealer: ${escapeHtml(dealerLabel(item))}<br>
      Delivered by: ${escapeHtml(item.deliveryPerson || '—')} &nbsp;·&nbsp; Received by: ${escapeHtml(item.receiverName || '—')}
    </p>
    <ul class="timeline">${rows}</ul>`;
  historyOverlay.hidden = false;
}

document.getElementById('addStockBtn').addEventListener('click', () => openStockForm());
document.getElementById('manageCategoriesBtn').addEventListener('click', openCategoryManager);

function categoryOptionsHtml(selectedId) {
  return state.productCategories
    .map(c => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function dealerOptionsHtml(selectedId) {
  return state.dealers
    .map(d => `<option value="${d.id}" ${selectedId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
}

function openStockForm(editId) {
  if (state.productCategories.length === 0) {
    showToast('Add at least one product category first');
    openCategoryManager();
    return;
  }
  if (state.dealers.length === 0) {
    showToast('Add at least one dealer first');
    switchView('dealers');
    return;
  }
  const item = editId ? state.stockItems.find(i => i.id === editId) : null;
  const matchingDealer = item
    ? (item.dealerId ? dealerById(item.dealerId) : state.dealers.find(d => d.name.toLowerCase() === (item.dealerName || '').toLowerCase()))
    : null;

  openModal(item ? 'Edit stock entry' : 'Add received stock', `
    <form id="stockForm">
      ${item ? `
      <div class="form-group">
        <label>Serial number</label>
        <input type="text" value="${escapeHtml(item.serialNumber || '—')}" disabled style="background:#f4f6f8;color:var(--text-muted)">
      </div>` : ''}
      <div class="form-group">
        <label>Product category</label>
        <select id="f-category" required>${categoryOptionsHtml(item ? item.categoryId : null)}</select>
      </div>
      <div class="form-group">
        <label>No of Packages</label>
        <input type="number" id="f-packagesCount" min="0" step="1" required value="${item && item.packagesCount != null ? item.packagesCount : ''}">
      </div>
      ${item ? `
      <div class="form-group">
        <label>Quantity</label>
        <input type="number" id="f-quantity" min="0" step="any" value="${item.quantity != null ? item.quantity : ''}">
      </div>` : `
      <p class="hint" style="margin-top:-4px">Quantity is entered once verification is done, not when first logging the item in.</p>`}
      <div class="form-group">
        <label>Dealer</label>
        <select id="f-dealer" required>${dealerOptionsHtml(matchingDealer ? matchingDealer.id : null)}</select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Delivery person name</label>
          <input type="text" id="f-deliveryPerson" value="${item ? escapeHtml(item.deliveryPerson || '') : ''}">
        </div>
        <div class="form-group">
          <label>Receiver name</label>
          <input type="text" id="f-receiverName" value="${item ? escapeHtml(item.receiverName || '') : ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="f-receivedDate" required value="${item ? item.receivedDate : todayStr()}">
      </div>
      ${!item ? `
      <div class="form-group">
        <label>Initial status</label>
        <select id="f-status">${state.statuses.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select>
      </div>` : ''}
      <div class="form-group">
        <label>Notes (optional)</label>
        <textarea id="f-notes" rows="2">${item ? escapeHtml(item.notes || '') : ''}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${item ? 'Save changes' : 'Add stock entry'}</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#stockForm').addEventListener('submit', e => {
      e.preventDefault();
      const categoryId = document.getElementById('f-category').value;
      const dealerId = document.getElementById('f-dealer').value;
      const packagesCountRaw = document.getElementById('f-packagesCount').value;
      const deliveryPerson = document.getElementById('f-deliveryPerson').value.trim();
      const receiverName = document.getElementById('f-receiverName').value.trim();
      const receivedDate = document.getElementById('f-receivedDate').value;
      const notes = document.getElementById('f-notes').value.trim();
      if (!categoryId || !dealerId || !receivedDate || packagesCountRaw === '') return;

      if (item) {
        const quantityRaw = document.getElementById('f-quantity').value;
        item.categoryId = categoryId; item.quantity = quantityRaw === '' ? null : quantityRaw;
        item.packagesCount = packagesCountRaw;
        item.dealerId = dealerId; item.deliveryPerson = deliveryPerson; item.receiverName = receiverName;
        item.receivedDate = receivedDate; item.notes = notes;
        save(); closeModal(); renderStock(); renderDashboard();
        showToast('Stock entry updated');
        return;
      }

      const statusId = document.getElementById('f-status').value;
      const createEntry = quantity => {
        state.stockItems.push({
          id: uid(), serialNumber: nextStockSerial(state), categoryId,
          quantity: quantity != null ? quantity : null, packagesCount: packagesCountRaw,
          dealerId, deliveryPerson, receiverName, receivedDate, notes, statusId,
          createdAt: new Date().toISOString(),
          history: [{
            statusId,
            note: quantity != null ? `Verified quantity: ${quantity}` : 'Logged into system',
            at: new Date().toISOString()
          }]
        });
        save(); closeModal(); renderStock(); renderDashboard();
        showToast(`Stock entry added — ${state.stockItems[state.stockItems.length - 1].serialNumber}`);
      };

      if (isVerificationDoneStatus(statusId)) {
        closeModal();
        promptStockVerificationQuantity(null, createEntry);
      } else {
        createEntry(null);
      }
    });
  });
}

function openCategoryManager() {
  openModal('Manage product categories', `
    <div class="form-group">
      <label>Add a new category</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="f-newCategory" placeholder="e.g. Apparel" style="flex:1">
        <button type="button" class="primary-btn" id="addCategoryBtn">Add</button>
      </div>
    </div>
    <table class="data-table" style="margin-top:10px">
      <tbody id="categoryTableBody"></tbody>
    </table>
  `, body => {
    function renderCategoryRows() {
      const tbody = body.querySelector('#categoryTableBody');
      tbody.innerHTML = state.productCategories.map(c => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td class="row-actions">
            <button class="link-btn" data-rename-cat="${c.id}">Rename</button>
            <button class="danger-btn" data-del-cat="${c.id}">Delete</button>
          </td>
        </tr>
      `).join('') || `<tr><td><div class="empty-state">No categories yet. Add one above.</div></td></tr>`;

      tbody.querySelectorAll('[data-rename-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = categoryById(btn.dataset.renameCat);
          const name = prompt('Category name', entry.name);
          if (name && name.trim()) { entry.name = name.trim(); save(); renderCategoryRows(); renderStock(); }
        });
      });
      tbody.querySelectorAll('[data-del-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          const inUse = state.stockItems.some(i => i.categoryId === btn.dataset.delCat);
          if (inUse) { showToast('Cannot delete: category is used by stock entries.'); return; }
          if (confirm('Delete this category?')) {
            state.productCategories = state.productCategories.filter(c => c.id !== btn.dataset.delCat);
            save(); renderCategoryRows(); renderStock();
          }
        });
      });
    }
    body.querySelector('#addCategoryBtn').addEventListener('click', () => {
      const input = body.querySelector('#f-newCategory');
      const name = input.value.trim();
      if (!name) return;
      if (state.productCategories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        showToast('That category already exists');
        return;
      }
      state.productCategories.push({ id: uid(), name });
      save(); input.value = ''; renderCategoryRows(); renderStock();
    });
    renderCategoryRows();
  });
}

/* =========================================================
   TASKS
   ========================================================= */
document.getElementById('taskDate').addEventListener('change', renderTasks);
document.getElementById('taskFilterStaff').addEventListener('change', renderTasks);
document.getElementById('taskFilterStore').addEventListener('change', renderTasks);
document.getElementById('taskFilterStatus').addEventListener('change', renderTasks);

function populateTaskFilters() {
  const sel = document.getElementById('taskFilterStaff');
  const current = sel.value;
  sel.innerHTML = '<option value="">All staff</option>' +
    state.staff.filter(s => s.active !== false).map(s => `<option value="${s.id}">${escapeHtml(staffLabel(s))}</option>`).join('');
  sel.value = current;

  const storeSel = document.getElementById('taskFilterStore');
  const storeCurrent = storeSel.value;
  storeSel.innerHTML = '<option value="">All stores</option>' +
    state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  storeSel.value = storeCurrent;
}

/* Task status is a 3-state value: pending -> partial -> completed.
   Shared here so the main Tasks table, task report, and anywhere else
   showing a task's status all agree on label/color. */
const TASK_STATUS_META = {
  pending: { cls: 'badge-pending', label: 'Pending' },
  partial: { cls: 'badge-transit', label: 'Partially Completed' },
  completed: { cls: 'badge-completed', label: 'Completed' }
};
function taskStatusMeta(status) { return TASK_STATUS_META[status] || TASK_STATUS_META.pending; }
function taskStatusBadgeHtml(status) {
  const m = taskStatusMeta(status);
  return `<span class="badge ${m.cls}">${escapeHtml(m.label)}</span>`;
}

function renderTasks() {
  if (!document.getElementById('taskDate').value) document.getElementById('taskDate').value = todayStr();
  populateTaskFilters();
  const date = document.getElementById('taskDate').value;
  const staffFilter = document.getElementById('taskFilterStaff').value;
  const storeFilter = document.getElementById('taskFilterStore').value;
  const statusFilter = document.getElementById('taskFilterStatus').value;

  let tasks = state.tasks.filter(t => t.date === date);
  if (staffFilter) tasks = tasks.filter(t => t.staffId === staffFilter);
  if (storeFilter) tasks = tasks.filter(t => (t.storeIds || []).includes(storeFilter));
  if (statusFilter) tasks = tasks.filter(t => t.status === statusFilter);
  tasks.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  const today = todayStr();
  const tbody = document.getElementById('taskTableBody');
  tbody.innerHTML = tasks.map(task => {
    const person = staffById(task.staffId);
    const storeNames = (task.storeIds || []).map(id => storeById(id)).filter(Boolean).map(s => s.name);
    const subtitleParts = [storeNames.length ? storeNames.join(', ') : null, task.description || null].filter(Boolean).join(' · ');
    // Once a task's own day has passed, its status is frozen entirely --
    // no change in any direction (Pending/Partially Completed/Completed)
    // -- unless the user's role grants the "Complete Tasks After Due
    // Date" override (see Roles & Users).
    const status = task.status || 'pending';
    const locked = task.date < today && !canEdit('tasksLateComplete');
    const meta = taskStatusMeta(status);
    return `
      <tr>
        <td><strong>${escapeHtml(task.title)}</strong>${subtitleParts ? `<div style="color:var(--text-muted);font-size:11.5px;margin-top:2px">${escapeHtml(subtitleParts)}</div>` : ''}</td>
        <td>${escapeHtml(person ? staffLabel(person) : 'Unassigned')}</td>
        <td>${fmtDate(task.date)}</td>
        <td>
          <select class="badge task-status-select ${meta.cls}" data-id="${task.id}"
            style="border:none;appearance:none;-webkit-appearance:none;padding-right:22px;cursor:${locked ? 'not-allowed' : 'pointer'}"
            ${locked ? 'disabled' : ''} ${locked ? "title=\"Overdue — status can't be changed after the due date without permission\"" : ''}>
            <option value="pending" ${status === 'pending' ? 'selected' : ''}>${locked && status === 'pending' ? 'Missed' : 'Pending'}</option>
            <option value="partial" ${status === 'partial' ? 'selected' : ''}>Partially Completed</option>
            <option value="completed" ${status === 'completed' ? 'selected' : ''}>Completed</option>
          </select>
        </td>
        <td class="row-actions">
          <button class="link-btn" data-edit-task="${task.id}">Edit</button>
          <button class="danger-btn" data-del-task="${task.id}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  document.getElementById('taskEmpty').hidden = tasks.length !== 0;

  tbody.querySelectorAll('.task-status-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const task = state.tasks.find(t => t.id === sel.dataset.id);
      const prevStatus = task.status || 'pending';
      if (task.date < todayStr() && !canEdit('tasksLateComplete')) {
        sel.value = prevStatus;
        showToast("Can't change status — this task's due date has passed");
        return;
      }
      task.status = sel.value;
      task.completedAt = sel.value === 'completed' ? new Date().toISOString() : null;
      save(); renderTasks(); renderDashboard();
    });
  });
  tbody.querySelectorAll('[data-edit-task]').forEach(btn => {
    btn.addEventListener('click', () => openTaskForm(btn.dataset.editTask));
  });
  tbody.querySelectorAll('[data-del-task]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this task?')) {
        state.tasks = state.tasks.filter(t => t.id !== btn.dataset.delTask);
        save(); renderTasks(); renderDashboard();
        showToast('Task deleted');
      }
    });
  });
}

document.getElementById('addTaskBtn').addEventListener('click', () => openAssignTasksForm());

function taskCatalogOptionsHtml(selectedCatalogId) {
  return state.taskCatalog
    .map(c => `<option value="${c.id}" ${selectedCatalogId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function resolveTaskTitleFromRow(selectEl, customEl) {
  if (selectEl.value === '__custom__') return customEl.value.trim();
  if (selectEl.value) {
    const chosen = state.taskCatalog.find(c => c.id === selectEl.value);
    return chosen ? chosen.name : '';
  }
  return '';
}

function addTitleToCatalogIfNew(title) {
  const exists = state.taskCatalog.some(c => c.name.toLowerCase() === title.toLowerCase());
  if (!exists) state.taskCatalog.push({ id: uid(), name: title });
}

/* Bulk "assign multiple tasks to one focused staff member" flow, used for NEW tasks. */
function openAssignTasksForm() {
  const activeStaff = state.staff.filter(s => s.active !== false);
  if (activeStaff.length === 0) {
    showToast('Add at least one staff member first');
    switchView('staff');
    return;
  }
  const staffOptions = activeStaff.map(s => `<option value="${s.id}">${escapeHtml(staffLabel(s))}</option>`).join('');
  const defaultDate = document.getElementById('taskDate').value || todayStr();

  openModal('Assign tasks', `
    <form id="bulkTaskForm">
      <div class="form-row">
        <div class="form-group">
          <label>Staff member</label>
          <select id="f-bulkStaff" required>${staffOptions}</select>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="f-bulkDate" required value="${defaultDate}">
        </div>
      </div>
      <div id="taskRows"></div>
      <button type="button" class="secondary-btn" id="addRowBtn" style="margin-top:4px">+ Add another task</button>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="closeBulkBtn">Done</button>
        <button type="submit" class="primary-btn">Assign to this employee</button>
      </div>
    </form>
  `, body => {
    const rowsContainer = body.querySelector('#taskRows');

    function addRow() {
      const row = document.createElement('div');
      row.className = 'task-row';
      row.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;position:relative';
      row.innerHTML = `
        <button type="button" class="icon-btn row-remove" style="position:absolute;top:6px;right:8px;font-size:16px">&times;</button>
        <div class="form-group" style="margin-bottom:8px">
          <label>Task</label>
          <select class="row-title-select">
            <option value="">-- Choose from task list --</option>
            ${taskCatalogOptionsHtml()}
            <option value="__custom__">Other (type a new task)</option>
          </select>
          <input type="text" class="row-title-custom" placeholder="Type the task title" style="margin-top:6px" hidden>
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <label>Description (optional)</label>
          <input type="text" class="row-desc" placeholder="Description">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>Related store(s)</label>
          <div class="row-store-slot"></div>
        </div>
      `;
      rowsContainer.appendChild(row);
      const sel = row.querySelector('.row-title-select');
      const custom = row.querySelector('.row-title-custom');
      sel.addEventListener('change', () => {
        custom.hidden = sel.value !== '__custom__';
        if (!custom.hidden) custom.focus();
      });
      row.querySelector('.row-remove').addEventListener('click', () => {
        if (rowsContainer.children.length > 1) row.remove();
      });
      const storeMs = buildStoreMultiSelect([]);
      row.querySelector('.row-store-slot').appendChild(storeMs.el);
      row.storeMultiSelect = storeMs;
    }

    body.querySelector('#addRowBtn').addEventListener('click', addRow);
    body.querySelector('#closeBulkBtn').addEventListener('click', closeModal);
    addRow();

    body.querySelector('#bulkTaskForm').addEventListener('submit', e => {
      e.preventDefault();
      const staffId = document.getElementById('f-bulkStaff').value;
      const date = document.getElementById('f-bulkDate').value;
      if (!staffId || !date) return;

      const rows = [...rowsContainer.querySelectorAll('.task-row')];
      const newTasks = [];
      rows.forEach(row => {
        const title = resolveTaskTitleFromRow(row.querySelector('.row-title-select'), row.querySelector('.row-title-custom'));
        if (!title) return;
        const description = row.querySelector('.row-desc').value.trim();
        const storeIds = row.storeMultiSelect ? row.storeMultiSelect.getSelected() : [];
        addTitleToCatalogIfNew(title);
        newTasks.push({
          id: uid(), title, description, staffId, date, storeIds,
          status: 'pending', createdAt: new Date().toISOString(), completedAt: null
        });
      });

      if (newTasks.length === 0) { showToast('Choose or type at least one task'); return; }

      state.tasks.push(...newTasks);
      save(); renderTasks(); renderDashboard();
      showToast(`${newTasks.length} task${newTasks.length > 1 ? 's' : ''} assigned to ${staffLabel(staffById(staffId))}`);

      rowsContainer.innerHTML = '';
      addRow();
    });
  });
}

function openTaskForm(editId) {
  const task = state.tasks.find(t => t.id === editId);
  if (!task) return;
  const staffOptions = state.staff.filter(s => s.active !== false)
    .map(s => `<option value="${s.id}" ${task.staffId === s.id ? 'selected' : ''}>${escapeHtml(staffLabel(s))}</option>`).join('');

  const matchingCatalog = state.taskCatalog.find(c => c.name.toLowerCase() === task.title.toLowerCase());
  const isCustom = !matchingCatalog;

  openModal('Edit task', `
    <form id="taskForm">
      <div class="form-group">
        <label>Task</label>
        <select id="f-titleSelect">
          <option value="">-- Choose from task list --</option>
          ${taskCatalogOptionsHtml(matchingCatalog ? matchingCatalog.id : null)}
          <option value="__custom__" ${isCustom ? 'selected' : ''}>Other (type a new task)</option>
        </select>
        <input type="text" id="f-titleCustom" placeholder="Type the task title" style="margin-top:6px" ${isCustom ? '' : 'hidden'} value="${isCustom ? escapeHtml(task.title) : ''}">
      </div>
      <div class="form-group">
        <label>Description (optional)</label>
        <textarea id="f-desc" rows="2">${escapeHtml(task.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Related store(s)</label>
        <div id="f-storeSlot"></div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Assign to</label>
          <select id="f-staff" required>${staffOptions}</select>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="f-date" required value="${task.date}">
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">Save changes</button>
      </div>
    </form>
  `, body => {
    const titleSelect = body.querySelector('#f-titleSelect');
    const titleCustom = body.querySelector('#f-titleCustom');
    titleSelect.addEventListener('change', () => {
      titleCustom.hidden = titleSelect.value !== '__custom__';
      if (!titleCustom.hidden) titleCustom.focus();
    });
    const storeMs = buildStoreMultiSelect(task.storeIds || []);
    body.querySelector('#f-storeSlot').appendChild(storeMs.el);
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#taskForm').addEventListener('submit', e => {
      e.preventDefault();
      const title = resolveTaskTitleFromRow(titleSelect, titleCustom);
      const description = document.getElementById('f-desc').value.trim();
      const staffId = document.getElementById('f-staff').value;
      const date = document.getElementById('f-date').value;
      if (!title || !staffId || !date) { showToast('Choose or type a task title'); return; }

      addTitleToCatalogIfNew(title);
      task.title = title; task.description = description; task.staffId = staffId; task.date = date;
      task.storeIds = storeMs.getSelected();

      save(); closeModal(); renderTasks(); renderDashboard();
      showToast('Task updated');
    });
  });
}

document.getElementById('manageTaskCatalogBtn').addEventListener('click', openTaskCatalogManager);

function openTaskCatalogManager() {
  openModal('Manage task list', `
    <div class="form-group">
      <label>Add a new task type</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="f-newCatalogTask" placeholder="e.g. Load delivery van" style="flex:1">
        <button type="button" class="primary-btn" id="addCatalogTaskBtn">Add</button>
      </div>
    </div>
    <table class="data-table" style="margin-top:10px">
      <tbody id="catalogTableBody"></tbody>
    </table>
  `, body => {
    function renderCatalogRows() {
      const tbody = body.querySelector('#catalogTableBody');
      tbody.innerHTML = state.taskCatalog.map(c => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td class="row-actions">
            <button class="link-btn" data-rename-cat="${c.id}">Rename</button>
            <button class="danger-btn" data-del-cat="${c.id}">Delete</button>
          </td>
        </tr>
      `).join('') || `<tr><td><div class="empty-state">No task types yet. Add one above.</div></td></tr>`;

      tbody.querySelectorAll('[data-rename-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = state.taskCatalog.find(c => c.id === btn.dataset.renameCat);
          const name = prompt('Task name', entry.name);
          if (name && name.trim()) { entry.name = name.trim(); save(); renderCatalogRows(); }
        });
      });
      tbody.querySelectorAll('[data-del-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (confirm('Remove this task type from the list? Tasks already assigned are not affected.')) {
            state.taskCatalog = state.taskCatalog.filter(c => c.id !== btn.dataset.delCat);
            save(); renderCatalogRows();
          }
        });
      });
    }
    body.querySelector('#addCatalogTaskBtn').addEventListener('click', () => {
      const input = body.querySelector('#f-newCatalogTask');
      const name = input.value.trim();
      if (!name) return;
      if (state.taskCatalog.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        showToast('That task is already in the list');
        return;
      }
      state.taskCatalog.push({ id: uid(), name });
      save(); input.value = ''; renderCatalogRows();
    });
    renderCatalogRows();
  });
}

/* =========================================================
   DELIVERIES
   ========================================================= */
function populateDeliveryFilters() {
  const staffSel = document.getElementById('deliveryFilterStaff');
  const staffCurrent = staffSel.value;
  staffSel.innerHTML = '<option value="">All delivery staff</option><option value="__unassigned__">Unassigned only</option>' +
    state.deliveryStaff.filter(s => s.active !== false).map(s => `<option value="${s.id}">${escapeHtml(deliveryPersonLabel(s))}</option>`).join('');
  staffSel.value = staffCurrent;

  const storeSel = document.getElementById('deliveryFilterStore');
  const storeCurrent = storeSel.value;
  storeSel.innerHTML = '<option value="">All stores</option>' +
    state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  storeSel.value = storeCurrent;
}

document.getElementById('deliveryFilterStaff').addEventListener('change', renderDeliveries);
document.getElementById('deliveryFilterStore').addEventListener('change', renderDeliveries);
document.getElementById('deliveryFilterStatus').addEventListener('change', renderDeliveries);

function stockItemLabel(item) {
  const category = categoryById(item.categoryId);
  return `${item.serialNumber || 'SN-?'} · ${category ? category.name : 'Uncategorized'}`;
}

const DELIVERY_STATUS_LABELS = { pending: 'Pending', in_transit: 'In Transit', delivered: 'Delivered' };
const DELIVERY_STATUS_BADGE_CLASS = { pending: 'badge-pending', in_transit: 'badge-transit', delivered: 'badge-completed' };
function deliveryStatusBadgeHtml(status) {
  const cls = DELIVERY_STATUS_BADGE_CLASS[status] || 'badge-pending';
  const label = DELIVERY_STATUS_LABELS[status] || 'Pending';
  return `<span class="badge ${cls}">${label}</span>`;
}
/* Assigning a delivery person auto-advances Pending -> In Transit; clearing
   the assignment reverts In Transit -> Pending. Never overrides Delivered. */
function changeDeliveryStatus(deliveryId, newStatus) {
  const delivery = state.deliveries.find(d => d.id === deliveryId);
  if (!delivery) return;
  delivery.status = newStatus;
  delivery.deliveredAt = newStatus === 'delivered' ? new Date().toISOString() : null;
  save(); renderDeliveries(); renderDashboard();
}

let deliveryTab = 'active';
document.querySelectorAll('.chip[data-delivery-tab]').forEach(chip => {
  chip.addEventListener('click', () => {
    deliveryTab = chip.dataset.deliveryTab;
    document.querySelectorAll('.chip[data-delivery-tab]').forEach(c => c.classList.toggle('active', c === chip));
    renderDeliveries();
  });
});

function renderDeliveries() {
  populateDeliveryFilters();
  const staffFilter = document.getElementById('deliveryFilterStaff').value;
  const storeFilter = document.getElementById('deliveryFilterStore').value;
  const statusFilter = document.getElementById('deliveryFilterStatus').value;

  let deliveries = [...state.deliveries];
  deliveries = deliveries.filter(d => {
    const delivered = d.status === 'delivered';
    const delayed = isDeliveryDelayed(d);
    if (deliveryTab === 'delivered') return delivered;
    if (deliveryTab === 'delayed') return delayed;
    return !delivered && !delayed;
  });
  if (staffFilter === '__unassigned__') deliveries = deliveries.filter(d => !d.staffIds || d.staffIds.length === 0);
  else if (staffFilter) deliveries = deliveries.filter(d => (d.staffIds || []).includes(staffFilter));
  if (storeFilter) deliveries = deliveries.filter(d => d.storeId === storeFilter);
  if (statusFilter) deliveries = deliveries.filter(d => d.status === statusFilter);

  deliveries.sort(deliveryTab === 'delayed'
    ? (a, b) => daysSince(b.date) - daysSince(a.date)
    : (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const tbody = document.getElementById('deliveryTableBody');
  tbody.innerHTML = deliveries.map(delivery => {
    const staffNames = deliveryStaffLabel(delivery);
    const store = storeById(delivery.storeId);
    const stockItem = delivery.stockItemId ? state.stockItems.find(i => i.id === delivery.stockItemId) : null;
    const subtitleParts = [stockItem ? stockItemLabel(stockItem) : null, delivery.notes || null].filter(Boolean).join(' · ');
    const days = daysSince(delivery.date);
    const delayed = isDeliveryDelayed(delivery);
    return `
      <tr${delayed ? ' style="background:var(--red-soft)"' : ''}>
        <td><strong>${escapeHtml(delivery.deliveryId || '—')}</strong></td>
        <td><strong>${escapeHtml(store ? store.name : 'Unknown store')}</strong>${subtitleParts ? `<div style="color:var(--text-muted);font-size:11.5px;margin-top:2px">${escapeHtml(subtitleParts)}</div>` : ''}</td>
        <td>${escapeHtml(deliveryTransferIdsLabel(delivery) || '—')}</td>
        <td>${escapeHtml(delivery.packages)}</td>
        <td>${staffNames
          ? `${escapeHtml(staffNames)} <button class="link-btn" data-assign-delivery="${delivery.id}">Edit</button>`
          : `<span class="badge badge-pending">Unassigned</span> <button class="link-btn" data-assign-delivery="${delivery.id}">Assign</button>`}</td>
        <td>${fmtDate(delivery.date)}</td>
        <td style="${delayed ? 'color:var(--red);font-weight:600' : ''}">${days}d</td>
        <td>
          <select class="delivery-status-select" data-id="${delivery.id}">
            ${Object.keys(DELIVERY_STATUS_LABELS).map(s => `<option value="${s}" ${s === delivery.status ? 'selected' : ''}>${DELIVERY_STATUS_LABELS[s]}</option>`).join('')}
          </select>
        </td>
        <td class="row-actions">
          <button class="link-btn" data-print-delivery="${delivery.id}">Print</button>
          <button class="link-btn" data-edit-delivery="${delivery.id}">Edit</button>
          <button class="danger-btn" data-del-delivery="${delivery.id}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  const emptyEl = document.getElementById('deliveryEmpty');
  emptyEl.hidden = deliveries.length !== 0;
  emptyEl.textContent = deliveryTab === 'delivered'
    ? 'No delivered deliveries yet.'
    : deliveryTab === 'delayed'
    ? `Nothing delayed — no active delivery has been pending more than ${DELAY_THRESHOLD_DAYS} days.`
    : 'No active deliveries. Click "Create delivery" to log one.';

  const allDeliveredCount = state.deliveries.filter(d => d.status === 'delivered').length;
  const allDelayedCount = state.deliveries.filter(isDeliveryDelayed).length;
  const allActiveCount = state.deliveries.length - allDeliveredCount - allDelayedCount;
  document.querySelector('.chip[data-delivery-tab="active"]').textContent = `Active (${allActiveCount})`;
  document.querySelector('.chip[data-delivery-tab="delayed"]').textContent = `Delayed (${DELAY_THRESHOLD_DAYS}+ days) (${allDelayedCount})`;
  document.querySelector('.chip[data-delivery-tab="delivered"]').textContent = `Delivered (${allDeliveredCount})`;

  tbody.querySelectorAll('.delivery-status-select').forEach(sel => {
    sel.addEventListener('change', () => changeDeliveryStatus(sel.dataset.id, sel.value));
  });
  tbody.querySelectorAll('[data-assign-delivery]').forEach(btn => {
    btn.addEventListener('click', () => openAssignDeliveryPersonForm(btn.dataset.assignDelivery));
  });
  tbody.querySelectorAll('[data-print-delivery]').forEach(btn => {
    btn.addEventListener('click', () => printDeliverySlip(btn.dataset.printDelivery));
  });
  tbody.querySelectorAll('[data-edit-delivery]').forEach(btn => {
    btn.addEventListener('click', () => openDeliveryForm(btn.dataset.editDelivery));
  });
  tbody.querySelectorAll('[data-del-delivery]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this delivery record?')) {
        state.deliveries = state.deliveries.filter(d => d.id !== btn.dataset.delDelivery);
        save(); renderDeliveries(); renderDashboard();
        showToast('Delivery deleted');
      }
    });
  });
}

document.getElementById('addDeliveryBtn').addEventListener('click', () => openCreateDeliveryForm());

function storeOptionsHtml(selectedId) {
  return state.stores.map(s => `<option value="${s.id}" ${selectedId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
}

/* Create deliveries WITHOUT a delivery person yet -- store/stock/item/box/packages
   are logged first; a person is assigned afterward via openAssignDeliveryPersonForm. */
function openCreateDeliveryForm() {
  if (state.stores.length === 0) {
    showToast('Add at least one store first');
    switchView('stores');
    return;
  }
  const defaultDate = todayStr();

  openModal('Create delivery', `
    <form id="bulkDeliveryForm">
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="f-bulkDeliveryDate" required value="${defaultDate}">
      </div>
      <p class="hint" style="margin-top:0">Add one row per store/item going out. You'll assign a delivery person to each afterward.</p>
      <div id="deliveryRows"></div>
      <button type="button" class="secondary-btn" id="addDeliveryRowBtn" style="margin-top:4px">+ Add another delivery</button>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="closeBulkDeliveryBtn">Done</button>
        <button type="submit" class="primary-btn">Create delivery</button>
      </div>
    </form>
  `, body => {
    const rowsContainer = body.querySelector('#deliveryRows');

    function addRow() {
      const row = document.createElement('div');
      row.className = 'delivery-row';
      row.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;position:relative';
      row.innerHTML = `
        <button type="button" class="icon-btn row-remove" style="position:absolute;top:6px;right:8px;font-size:16px">&times;</button>
        <div class="form-group">
          <label>Store</label>
          <select class="row-store">${storeOptionsHtml()}</select>
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <label>Transfer ID(s)</label>
          <div class="row-transfer-slot"></div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>Packages</label>
          <input type="number" class="row-packages" min="1" step="1" placeholder="e.g. 5">
        </div>
      `;
      rowsContainer.appendChild(row);
      const transferInput = buildTagInput([], 'e.g. 1024');
      row.querySelector('.row-transfer-slot').appendChild(transferInput.el);
      row.transferInput = transferInput;
      row.querySelector('.row-remove').addEventListener('click', () => {
        if (rowsContainer.children.length > 1) row.remove();
      });
    }

    body.querySelector('#addDeliveryRowBtn').addEventListener('click', addRow);
    body.querySelector('#closeBulkDeliveryBtn').addEventListener('click', closeModal);
    addRow();

    body.querySelector('#bulkDeliveryForm').addEventListener('submit', e => {
      e.preventDefault();
      const date = document.getElementById('f-bulkDeliveryDate').value;
      if (!date) return;

      const rows = [...rowsContainer.querySelectorAll('.delivery-row')];
      const newDeliveries = [];
      rows.forEach(row => {
        const storeId = row.querySelector('.row-store').value;
        const packages = row.querySelector('.row-packages').value;
        if (!storeId || !packages) return;
        const transferIds = row.transferInput.getValues();
        newDeliveries.push({
          id: uid(), deliveryId: nextDeliverySerial(state), staffIds: [], storeId, stockItemId: null, transferIds, packages, date, notes: '',
          status: 'pending', createdAt: new Date().toISOString(), deliveredAt: null
        });
      });

      if (newDeliveries.length === 0) { showToast('Choose a store and enter packages for at least one row'); return; }

      state.deliveries.push(...newDeliveries);
      save(); renderDeliveries(); renderDashboard();
      showToast(`${newDeliveries.length} deliver${newDeliveries.length > 1 ? 'ies' : 'y'} created — assign a delivery person when ready`);

      rowsContainer.innerHTML = '';
      addRow();
    });
  });
}

function openAssignDeliveryPersonForm(deliveryId) {
  const delivery = state.deliveries.find(d => d.id === deliveryId);
  if (!delivery) return;
  const activeDeliveryStaff = state.deliveryStaff.filter(s => s.active !== false);
  if (activeDeliveryStaff.length === 0) {
    showToast('Add at least one delivery staff member first');
    switchView('deliveryStaff');
    return;
  }
  const store = storeById(delivery.storeId);

  openModal('Assign delivery staff', `
    <form id="assignPersonForm">
      <p class="hint" style="margin-top:0">${escapeHtml(store ? store.name : 'Unknown store')} — ${escapeHtml(delivery.packages)} package(s) on ${fmtDate(delivery.date)}</p>
      <div class="form-group">
        <label>Delivery staff (choose one or more)</label>
        <div id="f-assignStaffSlot"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">Assign</button>
      </div>
    </form>
  `, body => {
    const staffMs = buildDeliveryStaffMultiSelect(delivery.staffIds || []);
    body.querySelector('#f-assignStaffSlot').appendChild(staffMs.el);
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#assignPersonForm').addEventListener('submit', e => {
      e.preventDefault();
      const staffIds = staffMs.getSelected();
      if (staffIds.length === 0) { showToast('Choose at least one delivery staff member'); return; }
      delivery.staffIds = staffIds;
      if (delivery.status === 'pending') delivery.status = 'in_transit';
      save(); closeModal(); renderDeliveries(); renderDashboard();
      showToast(`Assigned to ${staffIds.map(id => deliveryPersonLabel(deliveryPersonById(id))).join(', ')} — moved to In Transit`);
    });
  });
}

function openDeliveryForm(editId) {
  const delivery = state.deliveries.find(d => d.id === editId);
  if (!delivery) return;

  openModal('Edit delivery', `
    <form id="deliveryForm">
      <div class="form-group">
        <label>Delivery ID</label>
        <input type="text" value="${escapeHtml(delivery.deliveryId || '—')}" disabled style="background:#f4f6f8;color:var(--text-muted)">
      </div>
      <div class="form-group">
        <label>Store</label>
        <select id="f-deliveryStore" required>${storeOptionsHtml(delivery.storeId)}</select>
      </div>
      <div class="form-group">
        <label>Transfer ID(s)</label>
        <div id="f-deliveryTransferSlot"></div>
      </div>
      <div class="form-group">
        <label>Number of packages</label>
        <input type="number" id="f-packages" min="1" step="1" required value="${delivery.packages}">
      </div>
      <div class="form-group">
        <label>Delivery staff</label>
        <div id="f-deliveryStaffSlot"></div>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="f-deliveryDate" required value="${delivery.date}">
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <textarea id="f-deliveryNotes" rows="2">${escapeHtml(delivery.notes || '')}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">Save changes</button>
      </div>
    </form>
  `, body => {
    const staffMs = buildDeliveryStaffMultiSelect(delivery.staffIds || []);
    body.querySelector('#f-deliveryStaffSlot').appendChild(staffMs.el);
    const transferInput = buildTagInput(delivery.transferIds || [], 'e.g. 1024');
    body.querySelector('#f-deliveryTransferSlot').appendChild(transferInput.el);
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#deliveryForm').addEventListener('submit', e => {
      e.preventDefault();
      const storeId = document.getElementById('f-deliveryStore').value;
      const transferIds = transferInput.getValues();
      const packages = document.getElementById('f-packages').value;
      const staffIds = staffMs.getSelected();
      const date = document.getElementById('f-deliveryDate').value;
      const notes = document.getElementById('f-deliveryNotes').value.trim();
      if (!storeId || !packages || !date) return;

      const wasAssigned = (delivery.staffIds || []).length > 0;
      const nowAssigned = staffIds.length > 0;
      if (nowAssigned && !wasAssigned && delivery.status === 'pending') delivery.status = 'in_transit';
      if (!nowAssigned && wasAssigned && delivery.status === 'in_transit') delivery.status = 'pending';

      delivery.storeId = storeId; delivery.transferIds = transferIds;
      delivery.packages = packages; delivery.staffIds = staffIds; delivery.date = date; delivery.notes = notes;

      save(); closeModal(); renderDeliveries(); renderDashboard();
      showToast('Delivery updated');
    });
  });
}

/* Prints an 80mm thermal-printer slip for one delivery via the hidden
   #printSlip element (see the @media print rule in style.css, which
   hides everything else on the page and shows only this). */
function printDeliverySlip(deliveryId) {
  const delivery = state.deliveries.find(d => d.id === deliveryId);
  if (!delivery) return;
  const store = storeById(delivery.storeId);
  document.getElementById('printSlip').innerHTML = `
    <div style="text-align:center;font-weight:bold;font-size:14px;margin-bottom:6px">TechB Warehouse</div>
    <div style="text-align:center;margin-bottom:8px">Delivery Slip</div>
    <div>Delivery ID: ${escapeHtml(delivery.deliveryId || '—')}</div>
    <div>Date: ${fmtDate(delivery.date)}</div>
    <div>From: TechB Warehouse</div>
    <div>To: ${escapeHtml(store ? store.name : 'Unknown store')}</div>
    <div>Transfer ID(s): ${escapeHtml(deliveryTransferIdsLabel(delivery) || '—')}</div>
    <div>Packages: ${escapeHtml(delivery.packages)}</div>
  `;
  window.print();
}

/* =========================================================
   REPORTS
   ========================================================= */
function currentReportRange() {
  return {
    from: document.getElementById('reportFrom').value,
    to: document.getElementById('reportTo').value
  };
}
function inReportRange(dateStr, from, to) {
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

document.getElementById('reportFrom').addEventListener('change', renderReports);
document.getElementById('reportTo').addEventListener('change', renderReports);
document.querySelectorAll('.chip[data-report-range]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-report-range]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const today = new Date();
    let from = toInputDate(today), to = toInputDate(today);
    if (chip.dataset.reportRange === 'week') {
      const day = today.getDay();
      const diffToMonday = (day === 0 ? 6 : day - 1);
      const monday = new Date(today); monday.setDate(today.getDate() - diffToMonday);
      from = toInputDate(monday);
    } else if (chip.dataset.reportRange === 'month') {
      from = toInputDate(new Date(today.getFullYear(), today.getMonth(), 1));
    } else if (chip.dataset.reportRange === 'all') {
      from = ''; to = '';
    }
    document.getElementById('reportFrom').value = from;
    document.getElementById('reportTo').value = to;
    renderReports();
  });
});

document.querySelectorAll('.chip[data-report-type]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-report-type]').forEach(c => c.classList.toggle('active', c === chip));
    document.querySelectorAll('.report-panel[data-report-panel]').forEach(panel => {
      panel.hidden = panel.dataset.reportPanel !== chip.dataset.reportType;
    });
  });
});

function renderReports() {
  renderEmployeeReport();
  renderDeliveryEmployeeReport();
  renderTaskReport();
  renderDeliveryReport();
  renderStockReport();
  renderStockCategoryReport();
  renderStockDealerReport();
  renderLpReport();
  renderLpItemReport();
  renderLpBrandReport();
  renderLpDealerReport();
  renderLpReturnReport();
  renderStoreReport();
}

function renderEmployeeReport() {
  const { from, to } = currentReportRange();
  const activeStaff = state.staff.filter(s => s.active !== false);

  const rows = activeStaff.map(person => {
    const tasks = state.tasks.filter(t => t.staffId === person.id && inReportRange(t.date, from, to));
    const tasksDone = tasks.filter(t => t.status === 'completed').length;
    return {
      person,
      tasks: tasks.length, tasksDone,
      taskPct: tasks.length ? Math.round(tasksDone / tasks.length * 100) : null
    };
  });

  const active = rows.filter(r => r.tasks > 0)
    .sort((a, b) => (b.taskPct - a.taskPct) || (b.tasks - a.tasks));
  const inactive = rows.filter(r => r.tasks === 0);

  const top = active[0];
  document.getElementById('topPerformerCard').innerHTML = top ? `
    <div class="spotlight">
      <div class="spotlight-medal">&#127942;</div>
      <div>
        <div class="spotlight-name">${escapeHtml(staffLabel(top.person))}</div>
        <div class="spotlight-meta">Top performing employee in this period</div>
      </div>
      <div class="spotlight-stats">
        <div class="spotlight-stat"><div class="v">${top.taskPct}%</div><div class="l">Task %</div></div>
        <div class="spotlight-stat"><div class="v">${top.tasksDone}/${top.tasks}</div><div class="l">Tasks</div></div>
      </div>
    </div>` : '';

  const orderedRows = [...active, ...inactive];
  const tbody = document.getElementById('employeeReportBody');
  tbody.innerHTML = orderedRows.map((r, idx) => {
    const rank = idx < active.length ? idx + 1 : null;
    const rankHtml = rank ? `<span class="rank-badge${rank <= 3 ? ' rank-' + rank : ''}">${rank}</span>` : '<span class="rank-badge">—</span>';
    return `
      <tr>
        <td>${rankHtml}</td>
        <td><strong>${escapeHtml(staffLabel(r.person))}</strong></td>
        <td>${r.tasksDone}/${r.tasks}</td>
        <td>${r.taskPct !== null ? r.taskPct + '%' : '—'}</td>
      </tr>`;
  }).join('');

  document.getElementById('employeeReportEmpty').hidden = orderedRows.length !== 0;
}

function renderDeliveryEmployeeReport() {
  const { from, to } = currentReportRange();
  const activeDeliveryStaff = state.deliveryStaff.filter(s => s.active !== false);

  const rows = activeDeliveryStaff.map(person => {
    const deliveries = state.deliveries.filter(d => (d.staffIds || []).includes(person.id) && inReportRange(d.date, from, to));
    const done = deliveries.filter(d => d.status === 'delivered').length;
    const packages = deliveries.filter(d => d.status === 'delivered')
      .reduce((sum, d) => sum + (Number(d.packages) || 0), 0);
    return {
      person,
      deliveries: deliveries.length, done, packages,
      pct: deliveries.length ? Math.round(done / deliveries.length * 100) : null
    };
  });

  const active = rows.filter(r => r.deliveries > 0)
    .sort((a, b) => (b.pct - a.pct) || (b.deliveries - a.deliveries));
  const inactive = rows.filter(r => r.deliveries === 0);

  const top = active[0];
  document.getElementById('topDeliveryPerformerCard').innerHTML = top ? `
    <div class="spotlight">
      <div class="spotlight-medal">&#127942;</div>
      <div>
        <div class="spotlight-name">${escapeHtml(deliveryPersonLabel(top.person))}</div>
        <div class="spotlight-meta">Top delivery performer in this period</div>
      </div>
      <div class="spotlight-stats">
        <div class="spotlight-stat"><div class="v">${top.pct}%</div><div class="l">Delivered</div></div>
        <div class="spotlight-stat"><div class="v">${top.done}/${top.deliveries}</div><div class="l">Deliveries</div></div>
        <div class="spotlight-stat"><div class="v">${top.packages}</div><div class="l">Packages</div></div>
      </div>
    </div>` : '';

  const orderedRows = [...active, ...inactive];
  const tbody = document.getElementById('deliveryEmployeeReportBody');
  tbody.innerHTML = orderedRows.map((r, idx) => {
    const rank = idx < active.length ? idx + 1 : null;
    const rankHtml = rank ? `<span class="rank-badge${rank <= 3 ? ' rank-' + rank : ''}">${rank}</span>` : '<span class="rank-badge">—</span>';
    return `
      <tr>
        <td>${rankHtml}</td>
        <td><strong>${escapeHtml(deliveryPersonLabel(r.person))}</strong></td>
        <td>${r.done}/${r.deliveries}</td>
        <td>${r.pct !== null ? r.pct + '%' : '—'}</td>
        <td>${r.packages}</td>
      </tr>`;
  }).join('');

  document.getElementById('deliveryEmployeeReportEmpty').hidden = orderedRows.length !== 0;
}

function populateReportStockFilters() {
  const catSel = document.getElementById('reportFilterCategory');
  const dealerSel = document.getElementById('reportFilterDealer');
  const statusSel = document.getElementById('reportFilterStatus');
  const catCurrent = catSel.value, dealerCurrent = dealerSel.value, statusCurrent = statusSel.value;
  catSel.innerHTML = '<option value="">All categories</option>' +
    state.productCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  dealerSel.innerHTML = '<option value="">All dealers</option>' +
    state.dealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  statusSel.innerHTML = '<option value="">All statuses</option>' +
    state.statuses.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  catSel.value = catCurrent; dealerSel.value = dealerCurrent; statusSel.value = statusCurrent;
}
document.getElementById('reportFilterCategory').addEventListener('change', renderStockReport);
document.getElementById('reportFilterDealer').addEventListener('change', renderStockReport);
document.getElementById('reportFilterStatus').addEventListener('change', renderStockReport);

function renderStockReport() {
  populateReportStockFilters();
  const { from, to } = currentReportRange();
  const catFilter = document.getElementById('reportFilterCategory').value;
  const dealerFilter = document.getElementById('reportFilterDealer').value;
  const statusFilter = document.getElementById('reportFilterStatus').value;

  let items = state.stockItems.filter(i => inReportRange(i.receivedDate, from, to));
  if (catFilter) items = items.filter(i => i.categoryId === catFilter);
  if (dealerFilter) items = items.filter(i => (i.dealerId || null) === dealerFilter);
  if (statusFilter) items = items.filter(i => i.statusId === statusFilter);
  items = [...items].sort((a, b) => (b.receivedDate || '').localeCompare(a.receivedDate || ''));

  const lastStatus = state.statuses[state.statuses.length - 1];
  const transferredCount = items.filter(i => lastStatus && i.statusId === lastStatus.id).length;
  const delayedCount = items.filter(isStockDelayed).length;

  document.getElementById('stockReportCards').innerHTML = `
    <div class="card"><div class="card-value">${items.length}</div><div class="card-label">Stock entries received</div></div>
    <div class="card"><div class="card-value">${transferredCount}</div><div class="card-label">Transferred to office</div></div>
    <div class="card"><div class="card-value">${items.length - transferredCount}</div><div class="card-label">Still in pipeline</div></div>
    <div class="card" style="${delayedCount ? 'border-color:#f4c6c5' : ''}"><div class="card-value" style="${delayedCount ? 'color:var(--red)' : ''}">${delayedCount}</div><div class="card-label">Delayed (${DELAY_THRESHOLD_DAYS}+ days)</div></div>
  `;

  const tbody = document.getElementById('stockReportBody');
  tbody.innerHTML = items.map(item => {
    const category = categoryById(item.categoryId);
    const status = statusById(item.statusId);
    const delayed = isStockDelayed(item);
    return `
      <tr${delayed ? ' style="background:var(--red-soft)"' : ''}>
        <td><strong>${escapeHtml(item.serialNumber || '—')}</strong>${delayed ? ' <span style="color:var(--red);font-size:11px;font-weight:600">DELAYED</span>' : ''}</td>
        <td>${escapeHtml(category ? category.name : 'Uncategorized')}</td>
        <td>${escapeHtml(dealerLabel(item))}</td>
        <td>${packagesCountLabel(item)}</td>
        <td>${stockQuantityLabel(item)}</td>
        <td>${fmtDate(item.receivedDate)}</td>
        <td>${escapeHtml(status ? status.name : '—')}</td>
        <td>${progressBarHtml(statusProgressPct(item.statusId))}</td>
      </tr>`;
  }).join('');

  document.getElementById('stockReportEmpty').hidden = items.length !== 0;
}

function populateTaskReportFilters() {
  const staffSel = document.getElementById('taskReportFilterStaff');
  const storeSel = document.getElementById('taskReportFilterStore');
  const staffCurrent = staffSel.value, storeCurrent = storeSel.value;
  staffSel.innerHTML = '<option value="">All staff</option>' +
    state.staff.filter(s => s.active !== false).map(s => `<option value="${s.id}">${escapeHtml(staffLabel(s))}</option>`).join('');
  storeSel.innerHTML = '<option value="">All stores</option>' +
    state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  staffSel.value = staffCurrent; storeSel.value = storeCurrent;
}
document.getElementById('taskReportFilterStaff').addEventListener('change', renderTaskReport);
document.getElementById('taskReportFilterStore').addEventListener('change', renderTaskReport);
document.getElementById('taskReportFilterStatus').addEventListener('change', renderTaskReport);

function renderTaskReport() {
  populateTaskReportFilters();
  const { from, to } = currentReportRange();
  const staffFilter = document.getElementById('taskReportFilterStaff').value;
  const storeFilter = document.getElementById('taskReportFilterStore').value;
  const statusFilter = document.getElementById('taskReportFilterStatus').value;

  let tasks = state.tasks.filter(t => inReportRange(t.date, from, to));
  if (staffFilter) tasks = tasks.filter(t => t.staffId === staffFilter);
  if (storeFilter) tasks = tasks.filter(t => (t.storeIds || []).includes(storeFilter));
  if (statusFilter) tasks = tasks.filter(t => t.status === statusFilter);
  tasks = [...tasks].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const doneCount = tasks.filter(t => t.status === 'completed').length;
  const partialCount = tasks.filter(t => t.status === 'partial').length;
  const pendingCount = tasks.length - doneCount - partialCount;
  document.getElementById('taskReportCards').innerHTML = `
    <div class="card"><div class="card-value">${tasks.length}</div><div class="card-label">Total tasks</div></div>
    <div class="card"><div class="card-value">${doneCount}</div><div class="card-label">Completed</div></div>
    <div class="card"><div class="card-value">${partialCount}</div><div class="card-label">Partially completed</div></div>
    <div class="card"><div class="card-value">${pendingCount}</div><div class="card-label">Pending</div></div>
    <div class="card"><div class="card-value">${tasks.length ? Math.round(doneCount / tasks.length * 100) : 0}%</div><div class="card-label">Completion rate</div></div>
  `;

  const tbody = document.getElementById('taskReportBody');
  tbody.innerHTML = tasks.map(t => {
    const person = staffById(t.staffId);
    const storeNames = (t.storeIds || []).map(id => storeById(id)).filter(Boolean).map(s => s.name).join(', ');
    return `
      <tr>
        <td><strong>${escapeHtml(t.title)}</strong>${t.description ? `<div style="color:var(--text-muted);font-size:11.5px;margin-top:2px">${escapeHtml(t.description)}</div>` : ''}</td>
        <td>${escapeHtml(person ? staffLabel(person) : 'Unassigned')}</td>
        <td>${escapeHtml(storeNames || '—')}</td>
        <td>${fmtDate(t.date)}</td>
        <td>${taskStatusBadgeHtml(t.status)}</td>
      </tr>`;
  }).join('');

  document.getElementById('taskReportEmpty').hidden = tasks.length !== 0;
}

function populateDeliveryReportFilters() {
  const staffSel = document.getElementById('deliveryReportFilterStaff');
  const storeSel = document.getElementById('deliveryReportFilterStore');
  const staffCurrent = staffSel.value, storeCurrent = storeSel.value;
  staffSel.innerHTML = '<option value="">All delivery staff</option><option value="__unassigned__">Unassigned only</option>' +
    state.deliveryStaff.filter(s => s.active !== false).map(s => `<option value="${s.id}">${escapeHtml(deliveryPersonLabel(s))}</option>`).join('');
  storeSel.innerHTML = '<option value="">All stores</option>' +
    state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  staffSel.value = staffCurrent; storeSel.value = storeCurrent;
}
document.getElementById('deliveryReportFilterStaff').addEventListener('change', renderDeliveryReport);
document.getElementById('deliveryReportFilterStore').addEventListener('change', renderDeliveryReport);
document.getElementById('deliveryReportFilterStatus').addEventListener('change', renderDeliveryReport);
document.getElementById('deliveryReportSearchTransfer').addEventListener('input', renderDeliveryReport);

function renderDeliveryReport() {
  populateDeliveryReportFilters();
  const { from, to } = currentReportRange();
  const staffFilter = document.getElementById('deliveryReportFilterStaff').value;
  const storeFilter = document.getElementById('deliveryReportFilterStore').value;
  const statusFilter = document.getElementById('deliveryReportFilterStatus').value;
  const transferSearch = document.getElementById('deliveryReportSearchTransfer').value.trim().toLowerCase();

  let deliveries = state.deliveries.filter(d => inReportRange(d.date, from, to));
  if (staffFilter === '__unassigned__') deliveries = deliveries.filter(d => !d.staffIds || d.staffIds.length === 0);
  else if (staffFilter) deliveries = deliveries.filter(d => (d.staffIds || []).includes(staffFilter));
  if (storeFilter) deliveries = deliveries.filter(d => d.storeId === storeFilter);
  if (statusFilter) deliveries = deliveries.filter(d => d.status === statusFilter);
  if (transferSearch) deliveries = deliveries.filter(d => deliveryTransferIdsLabel(d).toLowerCase().includes(transferSearch));
  deliveries = [...deliveries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const deliveredCount = deliveries.filter(d => d.status === 'delivered').length;
  const unassignedCount = deliveries.filter(d => !d.staffIds || d.staffIds.length === 0).length;
  const packages = deliveries.reduce((sum, d) => sum + (Number(d.packages) || 0), 0);
  document.getElementById('deliveryReportCards').innerHTML = `
    <div class="card"><div class="card-value">${deliveries.length}</div><div class="card-label">Total deliveries</div></div>
    <div class="card"><div class="card-value">${deliveredCount}</div><div class="card-label">Delivered</div></div>
    <div class="card"><div class="card-value">${deliveries.length - deliveredCount}</div><div class="card-label">Pending</div></div>
    <div class="card"><div class="card-value">${packages}</div><div class="card-label">Total packages</div></div>
    <div class="card"><div class="card-value">${unassignedCount}</div><div class="card-label">Awaiting a delivery person</div></div>
  `;

  const tbody = document.getElementById('deliveryReportBody');
  tbody.innerHTML = deliveries.map(d => {
    const staffNames = deliveryStaffLabel(d);
    const store = storeById(d.storeId);
    const stockItem = d.stockItemId ? state.stockItems.find(i => i.id === d.stockItemId) : null;
    return `
      <tr>
        <td>${escapeHtml(d.deliveryId || '—')}</td>
        <td>${escapeHtml(deliveryTransferIdsLabel(d) || '—')}</td>
        <td><strong>${escapeHtml(store ? store.name : 'Unknown store')}</strong></td>
        <td>${escapeHtml(stockItem ? stockItemLabel(stockItem) : '—')}</td>
        <td>${escapeHtml(d.packages)}</td>
        <td>${staffNames ? escapeHtml(staffNames) : '<span class="badge badge-pending">Unassigned</span>'}</td>
        <td>${fmtDate(d.date)}</td>
        <td>${deliveryStatusBadgeHtml(d.status)}</td>
      </tr>`;
  }).join('');

  document.getElementById('deliveryReportEmpty').hidden = deliveries.length !== 0;
}

function populateStockCategoryReportFilters() {
  const sel = document.getElementById('stockCategoryReportFilterDealer');
  const current = sel.value;
  sel.innerHTML = '<option value="">All dealers</option>' +
    state.dealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  sel.value = current;
}
document.getElementById('stockCategoryReportFilterDealer').addEventListener('change', renderStockCategoryReport);

function renderStockCategoryReport() {
  populateStockCategoryReportFilters();
  const { from, to } = currentReportRange();
  const dealerFilter = document.getElementById('stockCategoryReportFilterDealer').value;

  let items = state.stockItems.filter(i => inReportRange(i.receivedDate, from, to));
  if (dealerFilter) items = items.filter(i => (i.dealerId || null) === dealerFilter);

  const rows = state.productCategories.map(cat => {
    const catItems = items.filter(i => i.categoryId === cat.id);
    const qty = catItems.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    const completed = catItems.filter(i => statusProgressPct(i.statusId) === 100).length;
    const delayed = catItems.filter(isStockDelayed).length;
    return { cat, count: catItems.length, qty, completed, pipeline: catItems.length - completed, delayed };
  }).filter(r => r.count > 0).sort((a, b) => b.count - a.count);

  document.getElementById('stockCategoryReportBody').innerHTML = rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.cat.name)}</strong></td>
      <td>${r.count}</td>
      <td>${r.qty}</td>
      <td>${r.completed}</td>
      <td>${r.pipeline}</td>
      <td style="${r.delayed ? 'color:var(--red);font-weight:600' : ''}">${r.delayed}</td>
    </tr>`).join('');

  document.getElementById('stockCategoryReportEmpty').hidden = rows.length !== 0;
}

function populateStockDealerReportFilters() {
  const sel = document.getElementById('stockDealerReportFilterCategory');
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    state.productCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value = current;
}
document.getElementById('stockDealerReportFilterCategory').addEventListener('change', renderStockDealerReport);

function renderStockDealerReport() {
  populateStockDealerReportFilters();
  const { from, to } = currentReportRange();
  const catFilter = document.getElementById('stockDealerReportFilterCategory').value;

  let items = state.stockItems.filter(i => inReportRange(i.receivedDate, from, to));
  if (catFilter) items = items.filter(i => i.categoryId === catFilter);

  const rows = state.dealers.map(dealer => {
    const dItems = items.filter(i => i.dealerId === dealer.id);
    const qty = dItems.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    const completed = dItems.filter(i => statusProgressPct(i.statusId) === 100).length;
    const delayed = dItems.filter(isStockDelayed).length;
    return { dealer, count: dItems.length, qty, completed, pipeline: dItems.length - completed, delayed };
  }).filter(r => r.count > 0).sort((a, b) => b.count - a.count);

  document.getElementById('stockDealerReportBody').innerHTML = rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.dealer.name)}</strong></td>
      <td>${escapeHtml(r.dealer.phone || '—')}</td>
      <td>${r.count}</td>
      <td>${r.qty}</td>
      <td>${r.completed}</td>
      <td>${r.pipeline}</td>
      <td style="${r.delayed ? 'color:var(--red);font-weight:600' : ''}">${r.delayed}</td>
    </tr>`).join('');

  document.getElementById('stockDealerReportEmpty').hidden = rows.length !== 0;
}

/* =========================================================
   LOCAL PURCHASES REPORTS
   ========================================================= */
function populateLpReportFilters() {
  const storeSel = document.getElementById('lpReportFilterStore');
  const dealerSel = document.getElementById('lpReportFilterDealer');
  const storeCurrent = storeSel.value, dealerCurrent = dealerSel.value;
  storeSel.innerHTML = '<option value="">All stores</option>' +
    state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  dealerSel.innerHTML = '<option value="">All dealers</option>' +
    state.localDealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  storeSel.value = storeCurrent;
  dealerSel.value = dealerCurrent;
}
document.getElementById('lpReportFilterStore').addEventListener('change', renderLpReport);
document.getElementById('lpReportFilterDealer').addEventListener('change', renderLpReport);
document.getElementById('lpReportFilterStatus').addEventListener('change', renderLpReport);

function renderLpReport() {
  populateLpReportFilters();
  const { from, to } = currentReportRange();
  const storeFilter = document.getElementById('lpReportFilterStore').value;
  const dealerFilter = document.getElementById('lpReportFilterDealer').value;
  const statusFilter = document.getElementById('lpReportFilterStatus').value;

  let rows = state.localPurchases.filter(p => inReportRange(p.date, from, to));
  if (storeFilter) rows = rows.filter(p => p.storeId === storeFilter);
  if (dealerFilter) rows = rows.filter(p => p.dealerId === dealerFilter);
  if (statusFilter) rows = rows.filter(p => (p.status || 'RECEIVED') === statusFilter);
  rows = [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const usedCount = rows.filter(p => p.status === 'USED').length;
  const returnedCount = rows.filter(p => p.status === 'RETURNED').length;
  const onHandCount = rows.filter(p => (p.status || 'RECEIVED') === 'RECEIVED' || p.status === 'CHECKING').length;
  const totalQty = rows.reduce((sum, p) => sum + (Number(p.quantity) || 1), 0);
  document.getElementById('lpReportCards').innerHTML = `
    <div class="card"><div class="card-value">${rows.length}</div><div class="card-label">Total entries</div></div>
    <div class="card"><div class="card-value">${totalQty}</div><div class="card-label">Total quantity</div></div>
    <div class="card"><div class="card-value">${onHandCount}</div><div class="card-label">On hand (received/checking)</div></div>
    <div class="card"><div class="card-value">${usedCount}</div><div class="card-label">Used</div></div>
    <div class="card"><div class="card-value">${returnedCount}</div><div class="card-label">Returned</div></div>
  `;

  document.getElementById('lpReportBody').innerHTML = rows.map(p => `
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td>${escapeHtml((storeById(p.storeId) || {}).name || '—')}</td>
      <td><strong>${escapeHtml(p.itemName)}</strong></td>
      <td>${escapeHtml(p.brand || '—')}</td>
      <td>${escapeHtml(p.model || '—')}</td>
      <td>${escapeHtml(localDealerLabel(p))}</td>
      <td>${escapeHtml(p.jobCardNumber || '—')}</td>
      <td>${p.quantity ?? 1}</td>
      <td>${escapeHtml(p.deliveryPerson || '—')}</td>
      <td>${escapeHtml(lpStatusLabel(p.status || 'RECEIVED'))}</td>
    </tr>`).join('');

  document.getElementById('lpReportEmpty').hidden = rows.length !== 0;
}

/* Shared grouping for the item/brand/dealer breakdown reports below --
   buckets purchases by keyFn(purchase) and tallies quantity split by
   status (used / returned / still on hand). */
function groupLocalPurchases(rows, keyFn) {
  const groups = new Map();
  rows.forEach(p => {
    const key = keyFn(p);
    if (!groups.has(key)) groups.set(key, { key, count: 0, totalQty: 0, usedQty: 0, returnedQty: 0, onHandQty: 0 });
    const g = groups.get(key);
    const qty = Number(p.quantity) || 1;
    g.count++;
    g.totalQty += qty;
    const status = p.status || 'RECEIVED';
    if (status === 'USED') g.usedQty += qty;
    else if (status === 'RETURNED') g.returnedQty += qty;
    else g.onHandQty += qty;
  });
  return [...groups.values()].sort((a, b) => b.totalQty - a.totalQty);
}

function renderLpItemReport() {
  const { from, to } = currentReportRange();
  const rows = state.localPurchases.filter(p => inReportRange(p.date, from, to));
  const list = groupLocalPurchases(rows, p => p.itemName || '—');

  document.getElementById('lpItemReportBody').innerHTML = list.map(g => `
    <tr>
      <td><strong>${escapeHtml(g.key)}</strong></td>
      <td>${g.count}</td>
      <td>${g.totalQty}</td>
      <td>${g.usedQty}</td>
      <td>${g.returnedQty}</td>
      <td>${g.onHandQty}</td>
    </tr>`).join('');

  document.getElementById('lpItemReportEmpty').hidden = list.length !== 0;
}

function renderLpBrandReport() {
  const { from, to } = currentReportRange();
  const rows = state.localPurchases.filter(p => inReportRange(p.date, from, to));
  const list = groupLocalPurchases(rows, p => p.brand || '—');

  document.getElementById('lpBrandReportBody').innerHTML = list.map(g => `
    <tr>
      <td><strong>${escapeHtml(g.key)}</strong></td>
      <td>${g.count}</td>
      <td>${g.totalQty}</td>
      <td>${g.usedQty}</td>
      <td>${g.returnedQty}</td>
      <td>${g.onHandQty}</td>
    </tr>`).join('');

  document.getElementById('lpBrandReportEmpty').hidden = list.length !== 0;
}

function renderLpDealerReport() {
  const { from, to } = currentReportRange();
  const rows = state.localPurchases.filter(p => inReportRange(p.date, from, to));
  const list = groupLocalPurchases(rows, p => p.dealerId || '');

  document.getElementById('lpDealerReportBody').innerHTML = list.map(g => {
    const dealer = localDealerById(g.key);
    return `
    <tr>
      <td><strong>${escapeHtml(dealer ? dealer.name : 'Unknown dealer')}</strong></td>
      <td>${escapeHtml(dealer ? (dealer.phone || '—') : '—')}</td>
      <td>${g.count}</td>
      <td>${g.totalQty}</td>
      <td>${g.usedQty}</td>
      <td>${g.returnedQty}</td>
      <td>${g.onHandQty}</td>
    </tr>`;
  }).join('');

  document.getElementById('lpDealerReportEmpty').hidden = list.length !== 0;
}

function populateLpReturnReportFilters() {
  const storeSel = document.getElementById('lpReturnReportFilterStore');
  const dealerSel = document.getElementById('lpReturnReportFilterDealer');
  const reasonSel = document.getElementById('lpReturnReportFilterReason');
  const storeCurrent = storeSel.value, dealerCurrent = dealerSel.value, reasonCurrent = reasonSel.value;
  storeSel.innerHTML = '<option value="">All stores</option>' +
    state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  dealerSel.innerHTML = '<option value="">All dealers returned to</option>' +
    state.localDealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  reasonSel.innerHTML = '<option value="">All reasons</option>' +
    state.lpReturnReasons.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  storeSel.value = storeCurrent;
  dealerSel.value = dealerCurrent;
  reasonSel.value = reasonCurrent;
}
document.getElementById('lpReturnReportFilterStore').addEventListener('change', renderLpReturnReport);
document.getElementById('lpReturnReportFilterDealer').addEventListener('change', renderLpReturnReport);
document.getElementById('lpReturnReportFilterReason').addEventListener('change', renderLpReturnReport);

/* Returned local purchases, reported by returnDate (not the original
   purchase date) -- this is when the item actually went back out. */
function renderLpReturnReport() {
  populateLpReturnReportFilters();
  const { from, to } = currentReportRange();
  const storeFilter = document.getElementById('lpReturnReportFilterStore').value;
  const dealerFilter = document.getElementById('lpReturnReportFilterDealer').value;
  const reasonFilter = document.getElementById('lpReturnReportFilterReason').value;

  let rows = state.localPurchases.filter(p => p.status === 'RETURNED' && inReportRange(p.returnDate, from, to));
  if (storeFilter) rows = rows.filter(p => p.storeId === storeFilter);
  if (dealerFilter) rows = rows.filter(p => p.returnDealerId === dealerFilter);
  if (reasonFilter) rows = rows.filter(p => p.returnReasonId === reasonFilter);
  rows = [...rows].sort((a, b) => (b.returnDate || '').localeCompare(a.returnDate || ''));

  const totalQty = rows.reduce((sum, p) => sum + (Number(p.quantity) || 1), 0);
  const dealerCount = new Set(rows.map(p => p.returnDealerId).filter(Boolean)).size;
  document.getElementById('lpReturnReportCards').innerHTML = `
    <div class="card"><div class="card-value">${rows.length}</div><div class="card-label">Total returns</div></div>
    <div class="card"><div class="card-value">${totalQty}</div><div class="card-label">Total returned quantity</div></div>
    <div class="card"><div class="card-value">${dealerCount}</div><div class="card-label">Dealers returned to</div></div>
  `;

  document.getElementById('lpReturnReportBody').innerHTML = rows.map(p => {
    const boughtFrom = localDealerById(p.dealerId);
    const returnedTo = localDealerById(p.returnDealerId);
    const reason = lpReturnReasonById(p.returnReasonId);
    return `
    <tr>
      <td>${fmtDate(p.returnDate)}</td>
      <td>${escapeHtml((storeById(p.storeId) || {}).name || '—')}</td>
      <td><strong>${escapeHtml(p.itemName)}</strong></td>
      <td>${escapeHtml(p.brand || '—')}</td>
      <td>${escapeHtml(p.model || '—')}</td>
      <td>${escapeHtml(p.jobCardNumber || '—')}</td>
      <td>${p.quantity ?? 1}</td>
      <td>${escapeHtml(boughtFrom ? boughtFrom.name : '—')}</td>
      <td>${escapeHtml(returnedTo ? returnedTo.name : '—')}</td>
      <td>${escapeHtml(reason ? reason.name : '—')}</td>
    </tr>`;
  }).join('');

  document.getElementById('lpReturnReportEmpty').hidden = rows.length !== 0;
}

function renderStoreReport() {
  const { from, to } = currentReportRange();
  const tasksInRange = state.tasks.filter(t => inReportRange(t.date, from, to));
  const deliveriesInRange = state.deliveries.filter(d => inReportRange(d.date, from, to));

  const rows = state.stores.map(store => {
    const storeTasks = tasksInRange.filter(t => (t.storeIds || []).includes(store.id));
    const taskDone = storeTasks.filter(t => t.status === 'completed').length;
    const storeDeliveries = deliveriesInRange.filter(d => d.storeId === store.id);
    const deliveryDone = storeDeliveries.filter(d => d.status === 'delivered').length;
    const packages = storeDeliveries.filter(d => d.status === 'delivered')
      .reduce((sum, d) => sum + (Number(d.packages) || 0), 0);
    return {
      store, tasks: storeTasks.length, taskDone,
      taskPct: storeTasks.length ? Math.round(taskDone / storeTasks.length * 100) : null,
      deliveries: storeDeliveries.length, deliveryDone,
      deliveryPct: storeDeliveries.length ? Math.round(deliveryDone / storeDeliveries.length * 100) : null,
      packages
    };
  }).filter(r => r.tasks > 0 || r.deliveries > 0);

  document.getElementById('storeReportBody').innerHTML = rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.store.name)}</strong></td>
      <td>${r.taskDone}/${r.tasks}</td>
      <td>${r.taskPct !== null ? r.taskPct + '%' : '—'}</td>
      <td>${r.deliveryDone}/${r.deliveries}</td>
      <td>${r.deliveryPct !== null ? r.deliveryPct + '%' : '—'}</td>
      <td>${r.packages}</td>
    </tr>`).join('');

  document.getElementById('storeReportEmpty').hidden = rows.length !== 0;
}

/* =========================================================
   STAFF
   ========================================================= */
function renderStaff() {
  const tbody = document.getElementById('staffTableBody');
  tbody.innerHTML = state.staff.map(person => `
    <tr>
      <td>${escapeHtml(person.empId || '—')}</td>
      <td><strong>${escapeHtml(person.name)}</strong></td>
      <td>${escapeHtml(person.role || '—')}</td>
      <td><span class="badge ${person.active === false ? 'badge-pending' : 'badge-completed'}">${person.active === false ? 'Inactive' : 'Active'}</span></td>
      <td class="row-actions">
        <button class="link-btn" data-edit-staff="${person.id}">Edit</button>
        <button class="link-btn" data-toggle-staff="${person.id}">${person.active === false ? 'Reactivate' : 'Deactivate'}</button>
        <button class="danger-btn" data-del-staff="${person.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  if (state.staff.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No staff added yet.</div></td></tr>`;
  }

  tbody.querySelectorAll('[data-edit-staff]').forEach(btn => {
    btn.addEventListener('click', () => openStaffForm(btn.dataset.editStaff));
  });
  tbody.querySelectorAll('[data-toggle-staff]').forEach(btn => {
    btn.addEventListener('click', () => {
      const person = staffById(btn.dataset.toggleStaff);
      person.active = person.active === false ? true : false;
      save(); renderStaff();
    });
  });
  tbody.querySelectorAll('[data-del-staff]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hasTasks = state.tasks.some(t => t.staffId === btn.dataset.delStaff);
      if (hasTasks) {
        showToast('Cannot delete: staff has tasks. Deactivate instead.');
        return;
      }
      if (confirm('Delete this staff member?')) {
        state.staff = state.staff.filter(s => s.id !== btn.dataset.delStaff);
        save(); renderStaff();
        showToast('Staff deleted');
      }
    });
  });
}

document.getElementById('addStaffBtn').addEventListener('click', () => openStaffForm());

function openStaffForm(editId) {
  const person = editId ? staffById(editId) : null;
  openModal(person ? 'Edit staff' : 'Add staff', `
    <form id="staffForm">
      <div class="form-group">
        <label>Employee ID</label>
        <input type="text" id="f-empId" placeholder="e.g. EMP001" value="${person ? escapeHtml(person.empId || '') : ''}">
      </div>
      <div class="form-group">
        <label>Full name</label>
        <input type="text" id="f-name" required value="${person ? escapeHtml(person.name) : ''}">
      </div>
      <div class="form-group">
        <label>Role (optional)</label>
        <input type="text" id="f-role" placeholder="e.g. Loader, Packer, Supervisor" value="${person ? escapeHtml(person.role || '') : ''}">
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${person ? 'Save changes' : 'Add staff'}</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#staffForm').addEventListener('submit', e => {
      e.preventDefault();
      const empId = document.getElementById('f-empId').value.trim();
      const name = document.getElementById('f-name').value.trim();
      const role = document.getElementById('f-role').value.trim();
      if (!name) return;
      const duplicate = empId && state.staff.some(s => s.empId && s.empId.toLowerCase() === empId.toLowerCase() && (!person || s.id !== person.id));
      if (duplicate) {
        showToast('That Employee ID is already in use');
        return;
      }
      if (person) {
        person.empId = empId; person.name = name; person.role = role;
      } else {
        state.staff.push({ id: uid(), empId, name, role, active: true });
      }
      save(); closeModal(); renderStaff();
      showToast(person ? 'Staff updated' : 'Staff added');
    });
  });
}

/* =========================================================
   DELIVERY STAFF (separate roster from Staff -- deliveries only)
   ========================================================= */
function renderDeliveryStaff() {
  const tbody = document.getElementById('deliveryStaffTableBody');
  tbody.innerHTML = state.deliveryStaff.map(person => `
    <tr>
      <td>${escapeHtml(person.empId || '—')}</td>
      <td><strong>${escapeHtml(person.name)}</strong></td>
      <td>${escapeHtml(person.phone || '—')}</td>
      <td><span class="badge ${person.active === false ? 'badge-pending' : 'badge-completed'}">${person.active === false ? 'Inactive' : 'Active'}</span></td>
      <td class="row-actions">
        <button class="link-btn" data-edit-delivery-staff="${person.id}">Edit</button>
        <button class="link-btn" data-toggle-delivery-staff="${person.id}">${person.active === false ? 'Reactivate' : 'Deactivate'}</button>
        <button class="danger-btn" data-del-delivery-staff="${person.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  if (state.deliveryStaff.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No delivery staff added yet.</div></td></tr>`;
  }

  tbody.querySelectorAll('[data-edit-delivery-staff]').forEach(btn => {
    btn.addEventListener('click', () => openDeliveryStaffForm(btn.dataset.editDeliveryStaff));
  });
  tbody.querySelectorAll('[data-toggle-delivery-staff]').forEach(btn => {
    btn.addEventListener('click', () => {
      const person = deliveryPersonById(btn.dataset.toggleDeliveryStaff);
      person.active = person.active === false ? true : false;
      save(); renderDeliveryStaff();
    });
  });
  tbody.querySelectorAll('[data-del-delivery-staff]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hasDeliveries = state.deliveries.some(d => (d.staffIds || []).includes(btn.dataset.delDeliveryStaff));
      if (hasDeliveries) {
        showToast('Cannot delete: this person has deliveries. Deactivate instead.');
        return;
      }
      if (confirm('Delete this delivery staff member?')) {
        state.deliveryStaff = state.deliveryStaff.filter(s => s.id !== btn.dataset.delDeliveryStaff);
        save(); renderDeliveryStaff();
        showToast('Delivery staff deleted');
      }
    });
  });
}

document.getElementById('addDeliveryStaffBtn').addEventListener('click', () => openDeliveryStaffForm());

function openDeliveryStaffForm(editId) {
  const person = editId ? deliveryPersonById(editId) : null;
  openModal(person ? 'Edit delivery staff' : 'Add delivery staff', `
    <form id="deliveryStaffForm">
      <div class="form-group">
        <label>Employee ID</label>
        <input type="text" id="f-empId" placeholder="e.g. EMP001" value="${person ? escapeHtml(person.empId || '') : ''}">
      </div>
      <div class="form-group">
        <label>Full name</label>
        <input type="text" id="f-name" required value="${person ? escapeHtml(person.name) : ''}">
      </div>
      <div class="form-group">
        <label>Phone (optional)</label>
        <input type="text" id="f-phone" value="${person ? escapeHtml(person.phone || '') : ''}">
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${person ? 'Save changes' : 'Add delivery staff'}</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#deliveryStaffForm').addEventListener('submit', e => {
      e.preventDefault();
      const empId = document.getElementById('f-empId').value.trim();
      const name = document.getElementById('f-name').value.trim();
      const phone = document.getElementById('f-phone').value.trim();
      if (!name) return;
      const duplicate = empId && state.deliveryStaff.some(s => s.empId && s.empId.toLowerCase() === empId.toLowerCase() && (!person || s.id !== person.id));
      if (duplicate) {
        showToast('That Employee ID is already in use');
        return;
      }
      if (person) {
        person.empId = empId; person.name = name; person.phone = phone;
      } else {
        state.deliveryStaff.push({ id: uid(), empId, name, phone, active: true });
      }
      save(); closeModal(); renderDeliveryStaff();
      showToast(person ? 'Delivery staff updated' : 'Delivery staff added');
    });
  });
}

/* =========================================================
   STORES
   ========================================================= */
function renderStores() {
  const tbody = document.getElementById('storeTableBody');
  tbody.innerHTML = state.stores.map(store => `
    <tr>
      <td><strong>${escapeHtml(store.name)}</strong></td>
      <td class="row-actions">
        <button class="link-btn" data-edit-store="${store.id}">Rename</button>
        <button class="danger-btn" data-del-store="${store.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-edit-store]').forEach(btn => {
    btn.addEventListener('click', () => {
      const store = storeById(btn.dataset.editStore);
      const name = prompt('Store name', store.name);
      if (name && name.trim()) { store.name = name.trim(); save(); renderStores(); }
    });
  });
  tbody.querySelectorAll('[data-del-store]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this store?')) {
        state.stores = state.stores.filter(s => s.id !== btn.dataset.delStore);
        save(); renderStores();
      }
    });
  });
}

document.getElementById('addStoreBtn').addEventListener('click', () => {
  const name = prompt('New store name');
  if (name && name.trim()) {
    state.stores.push({ id: uid(), name: name.trim() });
    save(); renderStores();
  }
});

/* =========================================================
   DEALERS
   ========================================================= */
function renderDealers() {
  const tbody = document.getElementById('dealerTableBody');
  tbody.innerHTML = state.dealers.map(dealer => `
    <tr>
      <td><strong>${escapeHtml(dealer.name)}</strong></td>
      <td>${escapeHtml(dealer.phone || '—')}</td>
      <td class="row-actions">
        <button class="link-btn" data-edit-dealer="${dealer.id}">Edit</button>
        <button class="danger-btn" data-del-dealer="${dealer.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('dealerEmpty').hidden = state.dealers.length !== 0;

  tbody.querySelectorAll('[data-edit-dealer]').forEach(btn => {
    btn.addEventListener('click', () => openDealerForm(btn.dataset.editDealer));
  });
  tbody.querySelectorAll('[data-del-dealer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inUse = state.stockItems.some(i => i.dealerId === btn.dataset.delDealer);
      if (inUse) { showToast('Cannot delete: dealer is used by stock entries.'); return; }
      if (confirm('Delete this dealer?')) {
        state.dealers = state.dealers.filter(d => d.id !== btn.dataset.delDealer);
        save(); renderDealers();
        showToast('Dealer deleted');
      }
    });
  });
}

document.getElementById('addDealerBtn').addEventListener('click', () => openDealerForm());

function openDealerForm(editId) {
  const dealer = editId ? dealerById(editId) : null;
  openModal(dealer ? 'Edit dealer' : 'Add dealer', `
    <form id="dealerForm">
      <div class="form-group">
        <label>Dealer name</label>
        <input type="text" id="f-dealerFormName" required value="${dealer ? escapeHtml(dealer.name) : ''}">
      </div>
      <div class="form-group">
        <label>Phone (optional)</label>
        <input type="text" id="f-dealerFormPhone" value="${dealer ? escapeHtml(dealer.phone || '') : ''}">
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${dealer ? 'Save changes' : 'Add dealer'}</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#dealerForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = document.getElementById('f-dealerFormName').value.trim();
      const phone = document.getElementById('f-dealerFormPhone').value.trim();
      if (!name) return;
      const duplicate = state.dealers.some(d => d.name.toLowerCase() === name.toLowerCase() && (!dealer || d.id !== dealer.id));
      if (duplicate) { showToast('That dealer already exists'); return; }

      if (dealer) {
        dealer.name = name; dealer.phone = phone;
      } else {
        state.dealers.push({ id: uid(), name, phone });
      }
      save(); closeModal(); renderDealers();
      showToast(dealer ? 'Dealer updated' : 'Dealer added');
    });
  });
}

/* =========================================================
   LOCAL PURCHASES -- each store's accountant logs their own
   local service-spare purchases here; a user with an assigned
   store (currentUser.storeId) only ever sees/adds for that one
   store, while everyone else (Administrator, Manager, Viewer --
   "the warehouse") sees every store and can filter across them.

   Dealers here are a SEPARATE list (state.localDealers) from the
   main warehouse Stock dealers (state.dealers) -- local purchase
   dealers are the small local vendors each store buys spares
   from, not the bulk suppliers the central warehouse deals with.
   Like the item name and brand/model catalogs, dealers are also
   office-only: store-locked users can pick from the list but the
   "Manage dealers"/"Manage items"/"Manage brand & model" buttons
   are hidden for them in renderLocalPurchases().
   ========================================================= */
function localPurchaseById(id) { return state.localPurchases.find(p => p.id === id); }
function localDealerById(id) { return state.localDealers.find(d => d.id === id); }
function localDealerLabel(item) {
  const dealer = item.dealerId ? localDealerById(item.dealerId) : null;
  return dealer ? dealer.name : '—';
}
function lpItemCatalogById(id) { return state.lpItemCatalog.find(i => i.id === id); }
function lpBrandModelById(id) { return state.lpBrandModelCatalog.find(bm => bm.id === id); }
function lpBrandList() {
  return [...new Set(state.lpBrandModelCatalog.map(bm => bm.brand))].sort((a, b) => a.localeCompare(b));
}
function lpBrandModelLabel(bm) { return `${bm.brand} — ${bm.model}`; }

/* Reads an uploaded .xlsx/.xls/.csv File (via the vendored SheetJS
   library, vendor/xlsx.full.min.js) into an array of plain objects
   keyed by the first row's headers, e.g. [{Brand:"Voltas",Model:"VC-2200"}].
   Blank rows are dropped. Used for bulk-importing catalogs. */
async function readSpreadsheetRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => String(h || '').trim());
  return rows.slice(1)
    .filter(r => r.some(cell => String(cell ?? '').trim() !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = String(r[i] ?? '').trim(); });
      return obj;
    });
}
function findColumn(headers, name) {
  return headers.find(h => h.toLowerCase() === name.toLowerCase());
}
function localDealerOptionsHtml(selectedId) {
  return state.localDealers
    .map(d => `<option value="${d.id}" ${selectedId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
}

function myStore() {
  return currentUser && currentUser.storeId ? storeById(currentUser.storeId) : null;
}

/* Purchase lifecycle: RECEIVED -> CHECKING -> USED / RETURNED.
   Unlike the generic Stock status list, these four are fixed and drive
   real behavior (not just cosmetic labels): moving to USED asks for a
   job card number, moving to RETURNED opens a return form, and both
   remove the item from on-hand stock (see computeLocalStock()). */
const LP_STATUSES = [
  { id: 'RECEIVED', label: 'Received' },
  { id: 'CHECKING', label: 'Checking' },
  { id: 'USED', label: 'Used' },
  { id: 'RETURNED', label: 'Returned' }
];
function lpStatusLabel(statusId) {
  const s = LP_STATUSES.find(s => s.id === statusId);
  return s ? s.label : (statusId || '—');
}
function lpReturnReasonById(id) { return state.lpReturnReasons.find(r => r.id === id); }

function openLocalDealerManager() {
  openModal('Manage local purchase dealers', `
    <div class="form-group">
      <label>Add a new dealer</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="f-newLocalDealerName" placeholder="Dealer name" style="flex:1">
        <input type="text" id="f-newLocalDealerPhone" placeholder="Phone (optional)" style="flex:1">
        <button type="button" class="primary-btn" id="addLocalDealerBtn">Add</button>
      </div>
    </div>
    <table class="data-table" style="margin-top:10px">
      <tbody id="localDealerTableBody"></tbody>
    </table>
  `, body => {
    function renderLocalDealerRows() {
      const tbody = body.querySelector('#localDealerTableBody');
      tbody.innerHTML = state.localDealers.map(d => `
        <tr>
          <td><strong>${escapeHtml(d.name)}</strong></td>
          <td>${escapeHtml(d.phone || '—')}</td>
          <td class="row-actions">
            <button class="link-btn" data-rename-ld="${d.id}">Edit</button>
            <button class="danger-btn" data-del-ld="${d.id}">Delete</button>
          </td>
        </tr>
      `).join('') || `<tr><td colspan="3"><div class="empty-state">No dealers yet. Add one above.</div></td></tr>`;

      tbody.querySelectorAll('[data-rename-ld]').forEach(btn => {
        btn.addEventListener('click', () => {
          const dealer = localDealerById(btn.dataset.renameLd);
          const name = prompt('Dealer name', dealer.name);
          if (!name || !name.trim()) return;
          const phone = prompt('Phone (optional)', dealer.phone || '') || '';
          dealer.name = name.trim(); dealer.phone = phone.trim();
          save(); renderLocalDealerRows(); renderLocalPurchases();
        });
      });
      tbody.querySelectorAll('[data-del-ld]').forEach(btn => {
        btn.addEventListener('click', () => {
          const inUse = state.localPurchases.some(p => p.dealerId === btn.dataset.delLd);
          if (inUse) { showToast('Cannot delete: dealer is used by a purchase entry.'); return; }
          if (confirm('Delete this dealer?')) {
            state.localDealers = state.localDealers.filter(d => d.id !== btn.dataset.delLd);
            save(); renderLocalDealerRows(); renderLocalPurchases();
          }
        });
      });
    }
    body.querySelector('#addLocalDealerBtn').addEventListener('click', () => {
      const nameInput = body.querySelector('#f-newLocalDealerName');
      const phoneInput = body.querySelector('#f-newLocalDealerPhone');
      const name = nameInput.value.trim();
      const phone = phoneInput.value.trim();
      if (!name) return;
      if (state.localDealers.some(d => d.name.toLowerCase() === name.toLowerCase())) {
        showToast('That dealer already exists');
        return;
      }
      state.localDealers.push({ id: uid(), name, phone });
      save(); nameInput.value = ''; phoneInput.value = ''; renderLocalDealerRows(); renderLocalPurchases();
    });
    renderLocalDealerRows();
  });
}

document.getElementById('manageLocalDealersBtn').addEventListener('click', openLocalDealerManager);

/* Item name catalog and brand/model catalog for Local Purchases --
   maintained by office (warehouse-level users, no assigned store);
   store accountants can only pick from these, never type free text,
   so item names stay consistent across all 8 stores. Management UI
   is hidden from store-locked users in renderLocalPurchases(). */
function openLpItemCatalogManager() {
  openModal('Manage item names', `
    <div class="form-group">
      <label>Add a new item name</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="f-newLpItem" placeholder="e.g. AC Compressor" style="flex:1">
        <button type="button" class="primary-btn" id="addLpItemBtn">Add</button>
      </div>
    </div>
    <table class="data-table" style="margin-top:10px">
      <tbody id="lpItemCatalogTableBody"></tbody>
    </table>
  `, body => {
    function renderRows() {
      const tbody = body.querySelector('#lpItemCatalogTableBody');
      tbody.innerHTML = state.lpItemCatalog.map(it => `
        <tr>
          <td>${escapeHtml(it.name)}</td>
          <td class="row-actions">
            <button class="link-btn" data-rename-lpi="${it.id}">Rename</button>
            <button class="danger-btn" data-del-lpi="${it.id}">Delete</button>
          </td>
        </tr>
      `).join('') || `<tr><td><div class="empty-state">No item names yet. Add one above.</div></td></tr>`;

      tbody.querySelectorAll('[data-rename-lpi]').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = lpItemCatalogById(btn.dataset.renameLpi);
          const name = prompt('Item name', entry.name);
          if (name && name.trim()) { entry.name = name.trim(); save(); renderRows(); renderLocalPurchases(); }
        });
      });
      tbody.querySelectorAll('[data-del-lpi]').forEach(btn => {
        btn.addEventListener('click', () => {
          const inUse = state.localPurchases.some(p => p.itemId === btn.dataset.delLpi);
          if (inUse) { showToast('Cannot delete: item is used by a purchase entry.'); return; }
          if (confirm('Delete this item name?')) {
            state.lpItemCatalog = state.lpItemCatalog.filter(it => it.id !== btn.dataset.delLpi);
            save(); renderRows(); renderLocalPurchases();
          }
        });
      });
    }
    body.querySelector('#addLpItemBtn').addEventListener('click', () => {
      const input = body.querySelector('#f-newLpItem');
      const name = input.value.trim();
      if (!name) return;
      if (state.lpItemCatalog.some(it => it.name.toLowerCase() === name.toLowerCase())) {
        showToast('That item name already exists');
        return;
      }
      state.lpItemCatalog.push({ id: uid(), name });
      save(); input.value = ''; renderRows(); renderLocalPurchases();
    });
    renderRows();
  });
}
document.getElementById('manageLpItemsBtn').addEventListener('click', openLpItemCatalogManager);

function openLpBrandModelCatalogManager() {
  openModal('Manage brand & model', `
    <div class="form-group">
      <label>Add a new brand + model</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="f-newLpBrand" placeholder="Brand, e.g. Voltas" style="flex:1">
        <input type="text" id="f-newLpModel" placeholder="Model, e.g. VC-2200" style="flex:1">
        <button type="button" class="primary-btn" id="addLpBrandModelBtn">Add</button>
      </div>
    </div>
    <div class="form-group" style="border-top:1px solid var(--border);padding-top:14px">
      <label>Or bulk upload from Excel / CSV</label>
      <input type="file" id="f-lpBrandModelFile" accept=".xlsx,.xls,.csv">
      <p class="hint" style="margin:6px 0 0">
        First row must be column headers, with a <strong>Brand</strong> column and a <strong>Model</strong> column
        (any order, other columns are ignored). Rows already in the list below are skipped automatically.
      </p>
    </div>
    <table class="data-table" style="margin-top:10px">
      <tbody id="lpBrandModelTableBody"></tbody>
    </table>
  `, body => {
    body.querySelector('#f-lpBrandModelFile').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const rows = await readSpreadsheetRows(file);
        if (rows.length === 0) { showToast('That file has no data rows'); return; }
        const headers = Object.keys(rows[0]);
        const brandKey = findColumn(headers, 'Brand');
        const modelKey = findColumn(headers, 'Model');
        if (!brandKey || !modelKey) { showToast('Could not find "Brand" and "Model" columns in that file'); return; }

        let added = 0, skipped = 0;
        rows.forEach(r => {
          const brand = (r[brandKey] || '').trim();
          const model = (r[modelKey] || '').trim();
          if (!brand || !model) { skipped++; return; }
          const exists = state.lpBrandModelCatalog.some(bm =>
            bm.brand.toLowerCase() === brand.toLowerCase() && bm.model.toLowerCase() === model.toLowerCase());
          if (exists) { skipped++; return; }
          state.lpBrandModelCatalog.push({ id: uid(), brand, model });
          added++;
        });

        if (added > 0) save();
        renderRows(); renderLocalPurchases();
        showToast(`${added} added${skipped ? `, ${skipped} skipped (blank or already in the list)` : ''}`);
      } catch (err) {
        showToast('Could not read that file — check it\'s a valid Excel or CSV file');
      }
    });

    function renderRows() {
      const tbody = body.querySelector('#lpBrandModelTableBody');
      tbody.innerHTML = state.lpBrandModelCatalog.map(bm => `
        <tr>
          <td><strong>${escapeHtml(bm.brand)}</strong></td>
          <td>${escapeHtml(bm.model)}</td>
          <td class="row-actions">
            <button class="link-btn" data-rename-lpbm="${bm.id}">Edit</button>
            <button class="danger-btn" data-del-lpbm="${bm.id}">Delete</button>
          </td>
        </tr>
      `).join('') || `<tr><td colspan="3"><div class="empty-state">No brand/model entries yet. Add one above.</div></td></tr>`;

      tbody.querySelectorAll('[data-rename-lpbm]').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = lpBrandModelById(btn.dataset.renameLpbm);
          const brand = prompt('Brand', entry.brand);
          if (!brand || !brand.trim()) return;
          const model = prompt('Model', entry.model);
          if (!model || !model.trim()) return;
          entry.brand = brand.trim(); entry.model = model.trim();
          save(); renderRows(); renderLocalPurchases();
        });
      });
      tbody.querySelectorAll('[data-del-lpbm]').forEach(btn => {
        btn.addEventListener('click', () => {
          const inUse = state.localPurchases.some(p => p.brandModelId === btn.dataset.delLpbm);
          if (inUse) { showToast('Cannot delete: used by a purchase entry.'); return; }
          if (confirm('Delete this brand/model entry?')) {
            state.lpBrandModelCatalog = state.lpBrandModelCatalog.filter(bm => bm.id !== btn.dataset.delLpbm);
            save(); renderRows(); renderLocalPurchases();
          }
        });
      });
    }
    body.querySelector('#addLpBrandModelBtn').addEventListener('click', () => {
      const brandInput = body.querySelector('#f-newLpBrand');
      const modelInput = body.querySelector('#f-newLpModel');
      const brand = brandInput.value.trim();
      const model = modelInput.value.trim();
      if (!brand || !model) return;
      if (state.lpBrandModelCatalog.some(bm => bm.brand.toLowerCase() === brand.toLowerCase() && bm.model.toLowerCase() === model.toLowerCase())) {
        showToast('That brand/model already exists');
        return;
      }
      state.lpBrandModelCatalog.push({ id: uid(), brand, model });
      save(); brandInput.value = ''; modelInput.value = ''; renderRows(); renderLocalPurchases();
    });
    renderRows();
  });
}
document.getElementById('manageLpBrandModelBtn').addEventListener('click', openLpBrandModelCatalogManager);

/* Return reasons -- office-only catalog, picked from a dropdown when a
   purchase's status is changed to RETURNED (see openLocalPurchaseReturnForm). */
function openLpReturnReasonManager() {
  openModal('Manage return reasons', `
    <div class="form-group">
      <label>Add a new return reason</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="f-newLpReturnReason" placeholder="e.g. Defective part" style="flex:1">
        <button type="button" class="primary-btn" id="addLpReturnReasonBtn">Add</button>
      </div>
    </div>
    <table class="data-table" style="margin-top:10px">
      <tbody id="lpReturnReasonTableBody"></tbody>
    </table>
  `, body => {
    function renderRows() {
      const tbody = body.querySelector('#lpReturnReasonTableBody');
      tbody.innerHTML = state.lpReturnReasons.map(r => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="row-actions">
            <button class="link-btn" data-rename-lprr="${r.id}">Rename</button>
            <button class="danger-btn" data-del-lprr="${r.id}">Delete</button>
          </td>
        </tr>
      `).join('') || `<tr><td><div class="empty-state">No return reasons yet. Add one above.</div></td></tr>`;

      tbody.querySelectorAll('[data-rename-lprr]').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = lpReturnReasonById(btn.dataset.renameLprr);
          const name = prompt('Return reason', entry.name);
          if (name && name.trim()) { entry.name = name.trim(); save(); renderRows(); renderLocalPurchases(); }
        });
      });
      tbody.querySelectorAll('[data-del-lprr]').forEach(btn => {
        btn.addEventListener('click', () => {
          const inUse = state.localPurchases.some(p => p.returnReasonId === btn.dataset.delLprr);
          if (inUse) { showToast('Cannot delete: used by a return record.'); return; }
          if (confirm('Delete this return reason?')) {
            state.lpReturnReasons = state.lpReturnReasons.filter(r => r.id !== btn.dataset.delLprr);
            save(); renderRows(); renderLocalPurchases();
          }
        });
      });
    }
    body.querySelector('#addLpReturnReasonBtn').addEventListener('click', () => {
      const input = body.querySelector('#f-newLpReturnReason');
      const name = input.value.trim();
      if (!name) return;
      if (state.lpReturnReasons.some(r => r.name.toLowerCase() === name.toLowerCase())) {
        showToast('That reason already exists');
        return;
      }
      state.lpReturnReasons.push({ id: uid(), name });
      save(); input.value = ''; renderRows(); renderLocalPurchases();
    });
    renderRows();
  });
}
document.getElementById('manageLpReturnReasonsBtn').addEventListener('click', openLpReturnReasonManager);

/* Computes current on-hand stock per store+item+brand/model, derived
   entirely from purchases still in RECEIVED or CHECKING status -- USED
   and RETURNED purchases are excluded, so stock updates automatically
   as statuses change. No separate stock storage to keep in sync. */
function computeLocalStock() {
  const locked = myStore();
  const onHand = state.localPurchases.filter(p => (p.status || 'RECEIVED') === 'RECEIVED' || p.status === 'CHECKING');
  const scoped = locked ? onHand.filter(p => p.storeId === locked.id) : onHand;
  const groups = new Map();
  scoped.forEach(p => {
    const key = `${p.storeId}|${p.itemId}|${p.brandModelId}`;
    if (!groups.has(key)) {
      groups.set(key, { storeId: p.storeId, itemName: p.itemName, brand: p.brand, model: p.model, qty: 0 });
    }
    groups.get(key).qty += Number(p.quantity) || 0;
  });
  return [...groups.values()].filter(g => g.qty > 0).sort((a, b) => a.itemName.localeCompare(b.itemName));
}

function openLocalStockView() {
  const rows = computeLocalStock();
  openModal('Local purchase stock on hand', `
    <table class="data-table">
      <thead><tr><th>Store</th><th>Item</th><th>Brand</th><th>Model</th><th>Qty</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml((storeById(r.storeId) || {}).name || '—')}</td>
            <td><strong>${escapeHtml(r.itemName)}</strong></td>
            <td>${escapeHtml(r.brand || '—')}</td>
            <td>${escapeHtml(r.model || '—')}</td>
            <td>${r.qty}</td>
          </tr>
        `).join('') || `<tr><td colspan="5"><div class="empty-state">No stock on hand.</div></td></tr>`}
      </tbody>
    </table>
  `, () => {});
}
document.getElementById('viewLpStockBtn').addEventListener('click', openLocalStockView);

/* Return form -- opened when a purchase's status select is changed to
   RETURNED. Dealer defaults to the purchase's own dealer ("same dealer
   who sold it to us") but stays editable. */
function openLocalPurchaseReturnForm(purchase) {
  openModal('Return item', `
    <form id="lpReturnForm">
      <div class="form-group">
        <label>Dealer (who we bought it from)</label>
        <select id="f-lpReturnDealer" required>${localDealerOptionsHtml(purchase.dealerId)}</select>
      </div>
      <div class="form-group">
        <label>Return date</label>
        <input type="date" id="f-lpReturnDate" required value="${todayStr()}">
      </div>
      <div class="form-group">
        <label>Reason for return</label>
        <select id="f-lpReturnReason" required>
          <option value="">Select reason...</option>
          ${state.lpReturnReasons.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">Confirm return</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#lpReturnForm').addEventListener('submit', e => {
      e.preventDefault();
      const returnDealerId = document.getElementById('f-lpReturnDealer').value;
      const returnDate = document.getElementById('f-lpReturnDate').value;
      const returnReasonId = document.getElementById('f-lpReturnReason').value;
      if (!returnDealerId || !returnDate || !returnReasonId) return;
      purchase.status = 'RETURNED';
      purchase.returnDealerId = returnDealerId;
      purchase.returnDate = returnDate;
      purchase.returnReasonId = returnReasonId;
      save(); closeModal(); renderLocalPurchases();
      showToast('Marked as returned');
    });
  });
}

/* Called on change of a purchase row's status <select>. USED and
   RETURNED need extra info first, so the select is reverted to its old
   value immediately and only actually changes once that info is saved
   (renderLocalPurchases() then rebuilds the row with the real value). */
function changeLocalPurchaseStatus(id, newStatus, selectEl) {
  const purchase = localPurchaseById(id);
  const oldStatus = purchase.status || 'RECEIVED';
  if (newStatus === oldStatus) return;

  if (newStatus === 'USED') {
    selectEl.value = oldStatus;
    const jobCard = prompt('Job card number for this usage', purchase.jobCardNumber || '');
    if (jobCard === null || !jobCard.trim()) return;
    purchase.status = 'USED';
    purchase.jobCardNumber = jobCard.trim();
    save(); renderLocalPurchases();
    showToast('Marked as used');
    return;
  }

  if (newStatus === 'RETURNED') {
    selectEl.value = oldStatus;
    const locked = myStore();
    if (state.lpReturnReasons.length === 0) {
      if (locked) { showToast('No return reasons set up yet — ask the office to add some.'); return; }
      showToast('Add at least one return reason first');
      openLpReturnReasonManager();
      return;
    }
    openLocalPurchaseReturnForm(purchase);
    return;
  }

  purchase.status = newStatus;
  save(); renderLocalPurchases();
}

function renderLocalPurchases() {
  const locked = myStore();
  const hint = document.getElementById('localPurchaseStoreHint');
  hint.hidden = !locked;
  if (locked) hint.textContent = `Showing purchases for ${locked.name} only.`;

  // Item names, brand/model and return reasons are office-maintained
  // catalogs -- store accountants only ever pick from them, never
  // manage the lists.
  document.getElementById('manageLpItemsBtn').hidden = !!locked;
  document.getElementById('manageLpBrandModelBtn').hidden = !!locked;
  document.getElementById('manageLocalDealersBtn').hidden = !!locked;
  document.getElementById('manageLpReturnReasonsBtn').hidden = !!locked;

  const storeSel = document.getElementById('lpFilterStore');
  const dealerSel = document.getElementById('lpFilterDealer');
  const storeCurrent = storeSel.value, dealerCurrent = dealerSel.value;

  if (locked) {
    storeSel.innerHTML = `<option value="${locked.id}">${escapeHtml(locked.name)}</option>`;
    storeSel.value = locked.id;
    storeSel.disabled = true;
  } else {
    storeSel.innerHTML = '<option value="">All stores</option>' +
      state.stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    storeSel.disabled = false;
    storeSel.value = storeCurrent;
  }
  dealerSel.innerHTML = '<option value="">All dealers</option>' +
    state.localDealers.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  dealerSel.value = dealerCurrent;

  const storeFilter = locked ? locked.id : storeSel.value;
  const dealerFilter = dealerSel.value;
  const from = document.getElementById('lpFilterFrom').value;
  const to = document.getElementById('lpFilterTo').value;
  const search = document.getElementById('lpSearch').value.trim().toLowerCase();

  let rows = state.localPurchases.slice();
  if (storeFilter) rows = rows.filter(p => p.storeId === storeFilter);
  if (dealerFilter) rows = rows.filter(p => p.dealerId === dealerFilter);
  if (from) rows = rows.filter(p => p.date >= from);
  if (to) rows = rows.filter(p => p.date <= to);
  if (search) {
    rows = rows.filter(p =>
      (p.itemName || '').toLowerCase().includes(search) ||
      (p.brand || '').toLowerCase().includes(search) ||
      (p.model || '').toLowerCase().includes(search) ||
      (p.jobCardNumber || '').toLowerCase().includes(search)
    );
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const tbody = document.getElementById('localPurchaseTableBody');
  tbody.innerHTML = rows.map(p => {
    const status = p.status || 'RECEIVED';
    let returnNote = '';
    if (status === 'RETURNED') {
      const dealer = localDealerById(p.returnDealerId);
      const reason = lpReturnReasonById(p.returnReasonId);
      returnNote = `<div style="color:var(--text-muted);font-size:11.5px;margin-top:2px">
        Returned to ${escapeHtml(dealer ? dealer.name : '—')} on ${fmtDate(p.returnDate)} — ${escapeHtml(reason ? reason.name : '—')}
      </div>`;
    }
    return `
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td>${escapeHtml((storeById(p.storeId) || {}).name || '—')}</td>
      <td><strong>${escapeHtml(p.itemName)}</strong>${returnNote}</td>
      <td>${escapeHtml(p.brand || '—')}</td>
      <td>${escapeHtml(p.model || '—')}</td>
      <td>${escapeHtml(localDealerLabel(p))}</td>
      <td>${escapeHtml(p.jobCardNumber || '—')}</td>
      <td>${p.quantity ?? 1}</td>
      <td>${escapeHtml(p.deliveryPerson || '—')}</td>
      <td>
        <select class="lp-status-select" data-id="${p.id}">
          ${LP_STATUSES.map(s => `<option value="${s.id}" ${s.id === status ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
        </select>
      </td>
      <td class="row-actions">
        <button class="link-btn" data-edit-lp="${p.id}">Edit</button>
        <button class="danger-btn" data-del-lp="${p.id}">Delete</button>
      </td>
    </tr>
  `;
  }).join('');
  document.getElementById('localPurchaseEmpty').hidden = rows.length !== 0;

  tbody.querySelectorAll('.lp-status-select').forEach(sel => {
    sel.addEventListener('change', () => changeLocalPurchaseStatus(sel.dataset.id, sel.value, sel));
  });
  tbody.querySelectorAll('[data-edit-lp]').forEach(btn => {
    btn.addEventListener('click', () => openLocalPurchaseForm(btn.dataset.editLp));
  });
  tbody.querySelectorAll('[data-del-lp]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this purchase entry?')) {
        state.localPurchases = state.localPurchases.filter(p => p.id !== btn.dataset.delLp);
        save(); renderLocalPurchases();
        showToast('Purchase deleted');
      }
    });
  });
}

['lpFilterStore', 'lpFilterDealer', 'lpFilterFrom', 'lpFilterTo'].forEach(id => {
  document.getElementById(id).addEventListener('change', renderLocalPurchases);
});
document.getElementById('lpSearch').addEventListener('input', renderLocalPurchases);

document.getElementById('addLocalPurchaseBtn').addEventListener('click', () => openLocalPurchaseForm());

function openLocalPurchaseForm(editId) {
  const purchase = editId ? localPurchaseById(editId) : null;
  const locked = myStore();

  if (state.localDealers.length === 0) {
    if (locked) { showToast('No dealers set up yet — ask the office to add some.'); return; }
    showToast('Add at least one dealer first');
    openLocalDealerManager();
    return;
  }
  if (state.lpItemCatalog.length === 0) {
    if (locked) { showToast('No item names set up yet — ask the office to add some.'); return; }
    showToast('Add at least one item name first');
    openLpItemCatalogManager();
    return;
  }
  if (state.lpBrandModelCatalog.length === 0) {
    if (locked) { showToast('No brand/model entries set up yet — ask the office to add some.'); return; }
    showToast('Add at least one brand/model first');
    openLpBrandModelCatalogManager();
    return;
  }

  const storeFieldHtml = locked
    ? `<input type="hidden" id="f-lpStore" value="${locked.id}"><input type="text" disabled value="${escapeHtml(locked.name)}">`
    : `<select id="f-lpStore" required>
        <option value="">Select store...</option>
        ${state.stores.map(s => `<option value="${s.id}" ${purchase && purchase.storeId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>`;

  openModal(purchase ? 'Edit purchase' : 'Add local purchase', `
    <form id="localPurchaseForm">
      <div class="form-group">
        <label>Store</label>
        ${storeFieldHtml}
      </div>
      <div class="form-group">
        <label>Item name</label>
        <div id="f-lpItemWrap"></div>
      </div>
      <div class="form-group">
        <label>Brand</label>
        <div id="f-lpBrandWrap"></div>
      </div>
      <div class="form-group">
        <label>Model</label>
        <div id="f-lpModelWrap"></div>
      </div>
      <div class="form-group">
        <label>Dealer</label>
        <select id="f-lpDealer" required>${localDealerOptionsHtml(purchase ? purchase.dealerId : null)}</select>
      </div>
      <div class="form-group">
        <label>Job card number</label>
        <input type="text" id="f-lpJobCard" required value="${purchase ? escapeHtml(purchase.jobCardNumber || '') : ''}">
      </div>
      <div class="form-group">
        <label>Quantity</label>
        <input type="number" id="f-lpQuantity" min="1" step="1" value="${purchase ? purchase.quantity ?? 1 : 1}">
      </div>
      <div class="form-group">
        <label>Delivery person name</label>
        <input type="text" id="f-lpDeliveryPerson" required value="${purchase ? escapeHtml(purchase.deliveryPerson || '') : ''}">
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="f-lpDate" required value="${purchase ? purchase.date : todayStr()}">
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <input type="text" id="f-lpNotes" value="${purchase ? escapeHtml(purchase.notes || '') : ''}">
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${purchase ? 'Save changes' : 'Add purchase'}</button>
      </div>
    </form>
  `, body => {
    const itemSelect = buildSearchSelect({
      items: state.lpItemCatalog,
      getId: it => it.id,
      getLabel: it => it.name,
      initialId: purchase ? purchase.itemId : null,
      placeholder: 'Search item name...'
    });
    body.querySelector('#f-lpItemWrap').appendChild(itemSelect.el);

    const existingBrandModel = purchase ? lpBrandModelById(purchase.brandModelId) : null;
    const initialBrand = existingBrandModel ? existingBrandModel.brand : null;

    let modelSelect = null;
    function renderModelOptions(brand, initialModelId) {
      const modelWrap = body.querySelector('#f-lpModelWrap');
      modelWrap.innerHTML = '';
      const models = brand ? state.lpBrandModelCatalog.filter(bm => bm.brand === brand) : [];
      modelSelect = buildSearchSelect({
        items: models,
        getId: bm => bm.id,
        getLabel: bm => bm.model,
        initialId: initialModelId || null,
        placeholder: brand ? 'Search model...' : 'Select a brand first',
        disabled: !brand
      });
      modelWrap.appendChild(modelSelect.el);
    }

    const brandSelect = buildSearchSelect({
      items: lpBrandList().map(b => ({ id: b, name: b })),
      getId: b => b.id,
      getLabel: b => b.name,
      initialId: initialBrand,
      placeholder: 'Search brand...',
      onSelect: b => renderModelOptions(b.id, null)
    });
    body.querySelector('#f-lpBrandWrap').appendChild(brandSelect.el);
    renderModelOptions(initialBrand, purchase ? purchase.brandModelId : null);

    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#localPurchaseForm').addEventListener('submit', e => {
      e.preventDefault();
      const storeId = document.getElementById('f-lpStore').value;
      const itemId = itemSelect.getValue();
      const brandModelId = modelSelect ? modelSelect.getValue() : null;
      const dealerId = document.getElementById('f-lpDealer').value;
      const jobCardNumber = document.getElementById('f-lpJobCard').value.trim();
      const quantity = Number(document.getElementById('f-lpQuantity').value) || 1;
      const deliveryPerson = document.getElementById('f-lpDeliveryPerson').value.trim();
      const date = document.getElementById('f-lpDate').value;
      const notes = document.getElementById('f-lpNotes').value.trim();
      if (!storeId || !dealerId || !date || !deliveryPerson || !jobCardNumber) return;
      if (!itemId) { showToast('Pick an item name from the list'); return; }
      if (!brandSelect.getValue()) { showToast('Pick a brand from the list'); return; }
      if (!brandModelId) { showToast('Pick a model from the list'); return; }

      const item = lpItemCatalogById(itemId);
      const brandModel = lpBrandModelById(brandModelId);
      const fields = {
        storeId, itemId, itemName: item.name,
        brandModelId, brand: brandModel.brand, model: brandModel.model,
        dealerId, jobCardNumber, quantity, deliveryPerson, date, notes
      };

      if (purchase) {
        Object.assign(purchase, fields);
      } else {
        state.localPurchases.push({
          id: uid(), ...fields, status: 'RECEIVED',
          createdBy: currentUser ? currentUser.id : null, createdAt: new Date().toISOString()
        });
      }
      save(); closeModal(); renderLocalPurchases();
      showToast(purchase ? 'Purchase updated' : 'Purchase added');
    });
  });
}

/* =========================================================
   SETTINGS: STATUS LIST
   ========================================================= */
function renderSettings() {
  const tbody = document.getElementById('statusTableBody');
  tbody.innerHTML = state.statuses.map((st, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(st.name)}</strong></td>
      <td><span class="status-dot" style="display:inline-block;background:${st.color}"></span></td>
      <td class="row-actions">
        <button class="link-btn" data-move-up="${st.id}" ${idx === 0 ? 'disabled' : ''}>&uarr;</button>
        <button class="link-btn" data-move-down="${st.id}" ${idx === state.statuses.length - 1 ? 'disabled' : ''}>&darr;</button>
        <button class="link-btn" data-edit-status="${st.id}">Rename</button>
        <button class="danger-btn" data-del-status="${st.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-move-up]').forEach(btn => btn.addEventListener('click', () => moveStatus(btn.dataset.moveUp, -1)));
  tbody.querySelectorAll('[data-move-down]').forEach(btn => btn.addEventListener('click', () => moveStatus(btn.dataset.moveDown, 1)));
  tbody.querySelectorAll('[data-edit-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      const st = statusById(btn.dataset.editStatus);
      const name = prompt('Status name', st.name);
      if (name && name.trim()) { st.name = name.trim(); save(); renderSettings(); renderStock(); renderDashboard(); }
    });
  });
  tbody.querySelectorAll('[data-del-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inUse = state.stockItems.some(i => i.statusId === btn.dataset.delStatus);
      if (inUse) { showToast('Cannot delete: status is in use by stock entries.'); return; }
      if (state.statuses.length <= 1) { showToast('Keep at least one status.'); return; }
      if (confirm('Delete this status?')) {
        state.statuses = state.statuses.filter(s => s.id !== btn.dataset.delStatus);
        save(); renderSettings(); renderDashboard();
      }
    });
  });
}

function moveStatus(id, dir) {
  const idx = state.statuses.findIndex(s => s.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.statuses.length) return;
  [state.statuses[idx], state.statuses[newIdx]] = [state.statuses[newIdx], state.statuses[idx]];
  save(); renderSettings(); renderDashboard();
}

document.getElementById('addStatusBtn').addEventListener('click', () => {
  const name = prompt('New status name');
  if (name && name.trim()) {
    const color = DEFAULT_STATUS_COLORS[state.statuses.length % DEFAULT_STATUS_COLORS.length];
    state.statuses.push({ id: uid(), name: name.trim(), color });
    save(); renderSettings(); renderDashboard();
  }
});

/* =========================================================
   BACKUP / RESTORE
   ========================================================= */
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `warehouse-tracker-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ---- Automatic hourly backup to a chosen folder (File System Access API) ----
   Writes a timestamped JSON file directly into the folder every hour, no
   download prompt. Only Chrome/Edge support this; other browsers fall back
   to a note explaining manual export still works. Requires this browser
   tab to stay open on some device to fire on schedule. */
const AUTO_BACKUP_SUPPORTED = typeof window.showDirectoryPicker === 'function';
const AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
let autoBackupDirHandle = null;
let autoBackupTimer = null;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('warehouseTrackerFS', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function autoBackupFilename() {
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    '_' + String(d.getHours()).padStart(2, '0') + '-' + String(d.getMinutes()).padStart(2, '0');
  return `warehouse-tracker-backup-${stamp}.json`;
}

async function writeAutoBackup() {
  if (!autoBackupDirHandle) return;
  try {
    const fileHandle = await autoBackupDirHandle.getFileHandle(autoBackupFilename(), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
    localStorage.setItem('autoBackupLastAt', new Date().toISOString());
    updateAutoBackupStatusUI();
  } catch (e) {
    console.error('Auto-backup write failed', e);
    showToast('Auto-backup failed — check folder access');
  }
}

function startAutoBackupTimer() {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  autoBackupTimer = setInterval(writeAutoBackup, AUTO_BACKUP_INTERVAL_MS);
}

function updateAutoBackupStatusUI() {
  const btn = document.getElementById('autoBackupBtn');
  const status = document.getElementById('autoBackupStatus');
  if (!AUTO_BACKUP_SUPPORTED) {
    btn.disabled = true;
    btn.textContent = 'Auto-backup not supported';
    status.textContent = 'Use Chrome or Edge for automatic hourly backups. Manual export still works.';
    return;
  }
  if (autoBackupDirHandle) {
    btn.textContent = 'Change auto-backup folder...';
    const lastAt = localStorage.getItem('autoBackupLastAt');
    status.textContent = lastAt
      ? `Auto-backup on — every hour · last saved ${fmtDateTime(lastAt)}`
      : 'Auto-backup on — every hour (first save pending)';
  } else {
    btn.textContent = 'Choose auto-backup folder...';
    status.textContent = 'Not set up — pick a folder to save an hourly backup automatically.';
  }
}

/* Set when a previously-chosen folder needs its permission re-confirmed
   (browsers can forget grants across sessions). The single button click
   handler below checks this first, so only one action is ever wired up. */
let autoBackupPendingReauth = null;

async function pickNewAutoBackupFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    autoBackupDirHandle = handle;
    autoBackupPendingReauth = null;
    await idbSet('backupDir', handle);
    updateAutoBackupStatusUI();
    startAutoBackupTimer();
    await writeAutoBackup();
    showToast('Auto-backup folder set — saving every hour');
  } catch (e) {
    if (e.name !== 'AbortError') { console.error(e); showToast('Could not access that folder'); }
  }
}

async function reauthorizeAutoBackupFolder() {
  const handle = autoBackupPendingReauth;
  try {
    const granted = await handle.requestPermission({ mode: 'readwrite' });
    if (granted === 'granted') {
      autoBackupDirHandle = handle;
      autoBackupPendingReauth = null;
      updateAutoBackupStatusUI();
      startAutoBackupTimer();
      await writeAutoBackup();
    }
  } catch (e) {
    console.error('Could not re-authorize auto-backup folder', e);
  }
}

document.getElementById('autoBackupBtn').addEventListener('click', () => {
  if (!AUTO_BACKUP_SUPPORTED) return;
  if (autoBackupPendingReauth) reauthorizeAutoBackupFolder();
  else pickNewAutoBackupFolder();
});

async function restoreAutoBackupFolder() {
  if (!AUTO_BACKUP_SUPPORTED) { updateAutoBackupStatusUI(); return; }
  try {
    const handle = await idbGet('backupDir');
    if (!handle) { updateAutoBackupStatusUI(); return; }
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
      autoBackupDirHandle = handle;
      updateAutoBackupStatusUI();
      startAutoBackupTimer();
    } else {
      autoBackupPendingReauth = handle;
      document.getElementById('autoBackupBtn').textContent = 'Re-enable auto-backup...';
      document.getElementById('autoBackupStatus').textContent = 'A folder was set previously — click to re-confirm access.';
    }
  } catch (e) {
    console.error('Could not restore auto-backup folder', e);
    updateAutoBackupStatusUI();
  }
}
restoreAutoBackupFolder();

document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.stores || !parsed.statuses) throw new Error('Invalid backup file');
      if (confirm('This will replace all current data (on this device and the shared server) with the backup file. Continue?')) {
        state = normalizeState(parsed);
        save();
        switchView('dashboard');
        showToast('Backup restored');
      }
    } catch (err) {
      alert('Could not read this file as a valid backup: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* =========================================================
   AUTH (login, session, role-based UI)
   ========================================================= */
let currentUser = null;
let currentRoleName = '';
let currentPermissions = {};
let currentModules = [];

function showLoginScreen() {
  document.getElementById('loginScreen').hidden = false;
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').hidden = true;
  document.getElementById('loginUsername').focus();
}
function hideLoginScreen() {
  document.getElementById('loginScreen').hidden = true;
}

function applyRolePermissions() {
  views.forEach(v => {
    const btn = document.querySelector(`.nav-btn[data-view="${v}"]`);
    if (btn) btn.hidden = (currentPermissions[v] || 'none') === 'none';
  });
  document.getElementById('currentUserBadge').textContent =
    `${currentUser.name || currentUser.username} · ${currentRoleName}`;
}

/* Called after every switchView(): locks down mutation controls within
   the CURRENTLY OPEN view only, when that module's permission is "view"
   rather than "edit". */
function applyModuleReadonly(viewName) {
  const level = currentPermissions[viewName] || 'none';
  document.body.classList.toggle('module-readonly', level !== 'edit');
}

function canView(moduleId) { return (currentPermissions[moduleId] || 'none') !== 'none'; }
function canEdit(moduleId) { return (currentPermissions[moduleId] || 'none') === 'edit'; }

function handleSessionExpired() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  currentUser = null;
  showToast('Session expired — please log in again');
  showLoginScreen();
}

async function fetchMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  const submitBtn = document.getElementById('loginSubmitBtn');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      errorEl.textContent = res.status === 401 ? 'Incorrect username or password.' : 'Could not log in — try again.';
      errorEl.hidden = false;
      return;
    }
    const data = await res.json();
    applyAuthData(data);
    hideLoginScreen();
    applyRolePermissions();
    switchView(canView('dashboard') ? 'dashboard' : (views.find(canView) || 'dashboard'));
    bootFromServer();
  } catch (err) {
    errorEl.textContent = 'Could not reach the server.';
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

function applyAuthData(data) {
  currentUser = data.user;
  currentRoleName = data.roleName;
  currentPermissions = data.permissions || {};
  currentModules = data.modules || [];
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  currentUser = null;
  closeMobileSidebar();
  showLoginScreen();
});

/* ---- Users & Roles tab switcher ---- */
document.querySelectorAll('.chip[data-users-tab]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-users-tab]').forEach(c => c.classList.toggle('active', c === chip));
    document.querySelectorAll('.users-tab-panel').forEach(p => p.hidden = p.dataset.usersPanel !== chip.dataset.usersTab);
    if (chip.dataset.usersTab === 'roles') renderRoles();
  });
});

/* ---- User management (talks to /api/users directly, not the general
   save()/state blob, since passwords never live there) ---- */
let cachedRoles = [];

async function fetchRoles() {
  try {
    const res = await fetch('/api/roles');
    if (res.status === 401) { handleSessionExpired(); return []; }
    if (!res.ok) return [];
    const data = await res.json();
    cachedRoles = data.roles || [];
    return cachedRoles;
  } catch (e) {
    return [];
  }
}

async function renderUsers() {
  const tbody = document.getElementById('userTableBody');
  tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Loading...</div></td></tr>`;
  try {
    const [usersRes] = await Promise.all([fetch('/api/users'), fetchRoles()]);
    if (usersRes.status === 401) { handleSessionExpired(); return; }
    if (usersRes.status === 403) { tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">You don't have access to manage users.</div></td></tr>`; return; }
    const data = await usersRes.json();
    const users = data.users || [];
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(u.name || '—')}</td>
        <td>${escapeHtml(u.roleName)}</td>
        <td>${escapeHtml((storeById(u.storeId) || {}).name || 'All stores')}</td>
        <td><span class="badge ${u.active === false ? 'badge-pending' : 'badge-completed'}">${u.active === false ? 'Inactive' : 'Active'}</span></td>
        <td class="row-actions">
          <button class="link-btn" data-edit-user="${u.id}">Edit</button>
          <button class="link-btn" data-toggle-user="${u.id}" data-currently-active="${u.active !== false}">${u.active === false ? 'Reactivate' : 'Deactivate'}</button>
          <button class="danger-btn" data-del-user="${u.id}">Delete</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="6"><div class="empty-state">No users yet.</div></td></tr>`;

    tbody.querySelectorAll('[data-edit-user]').forEach(btn => {
      btn.addEventListener('click', () => openUserForm(btn.dataset.editUser, users.find(u => u.id === btn.dataset.editUser)));
    });
    tbody.querySelectorAll('[data-toggle-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const active = btn.dataset.currentlyActive !== 'true';
        const res2 = await fetch(`/api/users/${btn.dataset.toggleUser}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active })
        });
        if (res2.status === 401) { handleSessionExpired(); return; }
        if (!res2.ok) { const err = await res2.json().catch(() => ({})); showToast(err.error === 'must_keep_one_user_manager' ? 'Cannot deactivate: at least one active user must be able to manage Users' : 'Could not update user'); return; }
        renderUsers();
      });
    });
    tbody.querySelectorAll('[data-del-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this user? They will no longer be able to log in.')) return;
        const res2 = await fetch(`/api/users/${btn.dataset.delUser}`, { method: 'DELETE' });
        if (res2.status === 401) { handleSessionExpired(); return; }
        if (!res2.ok) { const err = await res2.json().catch(() => ({})); showToast(err.error === 'must_keep_one_user_manager' ? 'Cannot delete: at least one active user must be able to manage Users' : 'Could not delete user'); return; }
        showToast('User deleted');
        renderUsers();
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Could not load users.</div></td></tr>`;
  }
}

document.getElementById('addUserBtn').addEventListener('click', async () => {
  await fetchRoles();
  openUserForm();
});

function openUserForm(editId, existingUser) {
  if (cachedRoles.length === 0) { showToast('No roles available — add a role first'); return; }
  const roleOptions = cachedRoles.map(r =>
    `<option value="${r.id}" ${editId ? (existingUser.roleId === r.id ? 'selected' : '') : (r.name === 'Manager' ? 'selected' : '')}>${escapeHtml(r.name)}</option>`
  ).join('');

  openModal(editId ? 'Edit user' : 'Add user', `
    <form id="userForm">
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="f-username" required value="${editId ? escapeHtml(existingUser.username) : ''}">
      </div>
      <div class="form-group">
        <label>Full name (optional)</label>
        <input type="text" id="f-userName" value="${editId ? escapeHtml(existingUser.name || '') : ''}">
      </div>
      <div class="form-group">
        <label>${editId ? 'New password (leave blank to keep current)' : 'Password'}</label>
        <input type="password" id="f-userPassword" ${editId ? '' : 'required'} autocomplete="new-password">
      </div>
      <div class="form-group">
        <label>Role</label>
        <select id="f-userRole">${roleOptions}</select>
      </div>
      <div class="form-group">
        <label>Assigned store (optional)</label>
        <select id="f-userStore">
          <option value="">All stores (warehouse-level access)</option>
          ${state.stores.map(s => `<option value="${s.id}" ${editId && existingUser.storeId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <p class="hint" style="margin:4px 0 0">If set, this user's Local Purchases are limited to this one store. Leave blank for warehouse-wide staff.</p>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${editId ? 'Save changes' : 'Add user'}</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#userForm').addEventListener('submit', async e => {
      e.preventDefault();
      const username = document.getElementById('f-username').value.trim();
      const name = document.getElementById('f-userName').value.trim();
      const password = document.getElementById('f-userPassword').value;
      const roleId = document.getElementById('f-userRole').value;
      const storeId = document.getElementById('f-userStore').value || null;
      if (!username || (!editId && !password)) return;

      const payload = { username, name, roleId, storeId };
      if (password) payload.password = password;

      const res = await fetch(editId ? `/api/users/${editId}` : '/api/users', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const messages = { username_taken: 'That username is already taken', must_keep_one_user_manager: 'At least one active user must be able to manage Users' };
        showToast(messages[err.error] || 'Could not save user');
        return;
      }
      closeModal(); renderUsers();
      showToast(editId ? 'User updated' : 'User added');
    });
  });
}

/* ---- Roles (module permission matrix) ---- */
async function renderRoles() {
  const tbody = document.getElementById('roleTableBody');
  tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Loading...</div></td></tr>`;
  try {
    const [rolesRes, usersRes] = await Promise.all([fetch('/api/roles'), fetch('/api/users')]);
    if (rolesRes.status === 401) { handleSessionExpired(); return; }
    if (rolesRes.status === 403) { tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">You don't have access to manage roles.</div></td></tr>`; return; }
    const rolesData = await rolesRes.json();
    const usersData = usersRes.ok ? await usersRes.json() : { users: [] };
    cachedRoles = rolesData.roles || [];
    currentModules = rolesData.modules && rolesData.modules.length ? rolesData.modules : currentModules;

    tbody.innerHTML = cachedRoles.map(r => {
      const count = (usersData.users || []).filter(u => u.roleId === r.id).length;
      return `
        <tr>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          <td>${count}</td>
          <td class="row-actions">
            <button class="link-btn" data-edit-role="${r.id}">Edit</button>
            <button class="danger-btn" data-del-role="${r.id}" data-in-use="${count > 0}">Delete</button>
          </td>
        </tr>`;
    }).join('') || `<tr><td colspan="3"><div class="empty-state">No roles yet.</div></td></tr>`;

    tbody.querySelectorAll('[data-edit-role]').forEach(btn => {
      btn.addEventListener('click', () => openRoleForm(btn.dataset.editRole, cachedRoles.find(r => r.id === btn.dataset.editRole)));
    });
    tbody.querySelectorAll('[data-del-role]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.inUse === 'true') { showToast('Reassign users off this role before deleting it'); return; }
        if (!confirm('Delete this role?')) return;
        const res2 = await fetch(`/api/roles/${btn.dataset.delRole}`, { method: 'DELETE' });
        if (res2.status === 401) { handleSessionExpired(); return; }
        if (!res2.ok) { showToast('Could not delete role'); return; }
        showToast('Role deleted');
        renderRoles();
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Could not load roles.</div></td></tr>`;
  }
}

document.getElementById('addRoleBtn').addEventListener('click', () => openRoleForm());

function permMatrixHtml(existingPermissions) {
  const modules = currentModules.length ? currentModules : views.map(v => ({ id: v, label: v }));
  return `
    <table class="perm-matrix">
      <thead><tr><th>Section</th><th>Access</th></tr></thead>
      <tbody>
        ${modules.map(m => {
          const current = (existingPermissions && existingPermissions[m.id]) || 'none';
          return `
            <tr>
              <td class="module-name">${escapeHtml(m.label)}</td>
              <td>
                <div class="perm-options">
                  ${['none', 'view', 'edit'].map(level => `
                    <label>
                      <input type="radio" name="perm-${m.id}" value="${level}" ${current === level ? 'checked' : ''}>
                      ${level === 'none' ? 'No access' : level === 'view' ? 'View only' : 'Full access'}
                    </label>`).join('')}
                </div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function openRoleForm(editId, existingRole) {
  openModal(editId ? 'Edit role' : 'Add role', `
    <form id="roleForm">
      <div class="form-group">
        <label>Role name</label>
        <input type="text" id="f-roleName" required value="${editId ? escapeHtml(existingRole.name) : ''}">
      </div>
      <div class="form-group">
        <label>Access per section</label>
        ${permMatrixHtml(editId ? existingRole.permissions : null)}
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="primary-btn">${editId ? 'Save changes' : 'Add role'}</button>
      </div>
    </form>
  `, body => {
    body.querySelector('#cancelBtn').addEventListener('click', closeModal);
    body.querySelector('#roleForm').addEventListener('submit', async e => {
      e.preventDefault();
      const name = document.getElementById('f-roleName').value.trim();
      if (!name) return;
      const modules = currentModules.length ? currentModules : views.map(v => ({ id: v, label: v }));
      const permissions = {};
      modules.forEach(m => {
        const checked = body.querySelector(`input[name="perm-${m.id}"]:checked`);
        permissions[m.id] = checked ? checked.value : 'none';
      });

      const res = await fetch(editId ? `/api/roles/${editId}` : '/api/roles', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, permissions })
      });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const messages = { name_taken: 'That role name is already taken', must_keep_one_user_manager: 'This change would leave nobody able to manage Users — adjust it so at least one active user keeps Full access there' };
        showToast(messages[err.error] || 'Could not save role');
        return;
      }
      closeModal(); renderRoles();
      showToast(editId ? 'Role updated' : 'Role added');
      // Refresh nav/permissions in case the editor changed the current user's own role.
      const me = await fetchMe();
      if (me) { applyAuthData(me); applyRolePermissions(); }
    });
  });
}

/* ---------- Init ---------- */
(async function initApp() {
  const data = await fetchMe();
  if (!data) { showLoginScreen(); return; }
  applyAuthData(data);
  hideLoginScreen();
  applyRolePermissions();
  bootFromServer();
})();
