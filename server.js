const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// DATA_DIR lets a host with a persistent disk (e.g. a Fly.io volume) point
// storage somewhere durable; defaults to next to the code for local/PC use.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h sliding

function uid() {
  return crypto.randomUUID();
}

/* Every section of the app, in one place. Roles grant a level per
   module; nav + write access are both driven from this same list. */
const MODULES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'stock', label: 'Stock Tracking' },
  { id: 'tasks', label: 'Daily Tasks' },
  { id: 'tasksLateComplete', label: 'Complete Tasks After Due Date' },
  { id: 'deliveries', label: 'Deliveries' },
  { id: 'reports', label: 'Reports' },
  { id: 'staff', label: 'Staff' },
  { id: 'deliveryStaff', label: 'Delivery Staff' },
  { id: 'stores', label: 'Stores' },
  { id: 'dealers', label: 'Dealers' },
  { id: 'localPurchases', label: 'Local Purchases' },
  { id: 'settings', label: 'Status Settings' },
  { id: 'users', label: 'Users & Roles' }
];
const MODULE_IDS = MODULES.map(m => m.id);
const LEVELS = ['none', 'view', 'edit'];
const LEVEL_RANK = { none: 0, view: 1, edit: 2 };

/* Which top-level data.json fields belong to which module -- used to
   reject a write if the user's role lacks edit on the module a field
   belongs to, even though the whole app state travels as one blob. */
const STATE_FIELD_MODULE = {
  stockItems: 'stock', productCategories: 'stock', stockSerialCounter: 'stock',
  tasks: 'tasks', taskCatalog: 'tasks',
  deliveries: 'deliveries',
  staff: 'staff',
  deliveryStaff: 'deliveryStaff',
  stores: 'stores',
  dealers: 'dealers',
  localPurchases: 'localPurchases',
  localDealers: 'localPurchases',
  lpItemCatalog: 'localPurchases',
  lpBrandModelCatalog: 'localPurchases',
  lpReturnReasons: 'localPurchases',
  statuses: 'settings'
};

function normalizePermissions(perms) {
  const out = {};
  MODULE_IDS.forEach(id => {
    const v = perms && perms[id];
    out[id] = LEVELS.includes(v) ? v : 'none';
  });
  return out;
}
function permsAtLevel(level) {
  const perms = {};
  MODULE_IDS.forEach(id => { perms[id] = level; });
  return perms;
}

/* ============================================================
   PASSWORDS -- never stored or sent in plain text, kept in a
   file separate from the synced app data (data.json).
   ============================================================ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return check.length === stored.length && crypto.timingSafeEqual(check, stored);
}
function sanitizeUser(u) {
  return { id: u.id, username: u.username, name: u.name, roleId: u.roleId, storeId: u.storeId || null, active: u.active !== false, createdAt: u.createdAt };
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (e) { console.error('users.json is unreadable:', e.message); return []; }
}
function saveUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}
function loadRoles() {
  if (!fs.existsSync(ROLES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')); }
  catch (e) { console.error('roles.json is unreadable:', e.message); return []; }
}
function saveRoles(roles) {
  const tmp = ROLES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(roles, null, 2));
  fs.renameSync(tmp, ROLES_FILE);
}

function resolvePermissions(user, roles) {
  const role = (roles || loadRoles()).find(r => r.id === user.roleId);
  return role ? normalizePermissions(role.permissions) : permsAtLevel('none');
}

/* At least one active user must keep edit on "users", or nobody could
   ever manage accounts/roles again. Checked before any change that
   could remove that last thread. */
function wouldLoseAllUserManagers(users, roles) {
  return !users.some(u => u.active !== false && resolvePermissions(u, roles).users === 'edit');
}

/* Seed default roles + a first admin account on very first run. */
function ensureSeedRolesAndAdmin() {
  let roles = loadRoles();
  if (roles.length === 0) {
    roles = [
      { id: uid(), name: 'Administrator', permissions: permsAtLevel('edit'), builtIn: true },
      { id: uid(), name: 'Manager', permissions: { ...permsAtLevel('edit'), users: 'none' }, builtIn: true },
      { id: uid(), name: 'Viewer', permissions: permsAtLevel('view'), builtIn: true }
    ];
    saveRoles(roles);
  }
  const adminRole = roles.find(r => r.name === 'Administrator') || roles[0];

  const users = loadUsers();
  let changed = false;
  // Migrate any pre-Roles-module users (plain 'role' string) to the new roleId scheme.
  users.forEach(u => {
    if (!u.roleId) {
      const legacy = u.role;
      const match = roles.find(r => r.name.toLowerCase() === (legacy === 'admin' ? 'administrator' : legacy || '') );
      u.roleId = (match || adminRole).id;
      delete u.role;
      changed = true;
    }
  });
  if (changed) saveUsers(users);

  if (users.length === 0) {
    const password = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const { salt, hash } = hashPassword(password);
    const seeded = [{
      id: uid(), username: 'admin', name: 'Administrator', roleId: adminRole.id,
      salt, hash, active: true, createdAt: new Date().toISOString()
    }];
    saveUsers(seeded);
    console.log('');
    console.log('========================================================');
    console.log('First run: created an initial admin login.');
    console.log('  Username: admin');
    console.log(`  Password: ${password}`);
    console.log('Log in with this once, then change the password or add');
    console.log('your own admin user from the Users & Roles tab.');
    console.log('========================================================');
  }
}

/* ============================================================
   SESSIONS -- in-memory only (server restart logs everyone out,
   which is fine for this internal tool). Sliding 24h expiry.
   ============================================================ */
const sessions = new Map(); // sid -> { userId, expiresAt }

function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}
function getSessionUser(req) {
  const sid = req.cookies && req.cookies.sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS; // sliding renewal
  const users = loadUsers();
  const user = users.find(u => u.id === session.userId && u.active !== false);
  return user || null;
}
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expiresAt < now) sessions.delete(sid);
}, 60 * 60 * 1000).unref();

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  req.user = user;
  req.userPerms = resolvePermissions(user);
  next();
}
function requirePermission(moduleId, level) {
  return (req, res, next) => {
    const have = (req.userPerms && req.userPerms[moduleId]) || 'none';
    if (LEVEL_RANK[have] < LEVEL_RANK[level]) return res.status(403).json({ error: 'forbidden', module: moduleId, need: level });
    next();
  };
}

/* ============================================================
   APP DATA (data.json) -- unrelated to accounts, unchanged shape.
   ============================================================ */
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
    deliveryStaff: []
  };
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = defaultState();
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.stores || !parsed.statuses) throw new Error('Malformed data file');
    return parsed;
  } catch (e) {
    console.error('data.json is unreadable, backing it up and starting fresh:', e.message);
    fs.copyFileSync(DATA_FILE, DATA_FILE + '.broken-' + Date.now());
    const seed = defaultState();
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

function saveState(state) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(__dirname));

/* ---- Auth routes ---- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });
  const users = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === String(username).toLowerCase() && u.active !== false);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const sid = createSession(user.id);
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
  const role = loadRoles().find(r => r.id === user.roleId);
  res.json({ user: sanitizeUser(user), roleName: role ? role.name : 'Unknown role', permissions: resolvePermissions(user), modules: MODULES });
});

app.post('/api/logout', (req, res) => {
  const sid = req.cookies && req.cookies.sid;
  if (sid) sessions.delete(sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const role = loadRoles().find(r => r.id === req.user.roleId);
  res.json({ user: sanitizeUser(req.user), roleName: role ? role.name : 'Unknown role', permissions: req.userPerms, modules: MODULES });
});

/* ---- Roles (module permission matrix) ---- */
app.get('/api/roles', requireAuth, requirePermission('users', 'view'), (req, res) => {
  res.json({ roles: loadRoles(), modules: MODULES });
});

app.post('/api/roles', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const { name, permissions } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const roles = loadRoles();
  if (roles.some(r => r.name.toLowerCase() === String(name).toLowerCase())) {
    return res.status(409).json({ error: 'name_taken' });
  }
  const role = { id: uid(), name, permissions: normalizePermissions(permissions), builtIn: false };
  roles.push(role);
  saveRoles(roles);
  res.json({ role });
});

app.put('/api/roles/:id', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const roles = loadRoles();
  const role = roles.find(r => r.id === req.params.id);
  if (!role) return res.status(404).json({ error: 'not_found' });
  const { name, permissions } = req.body || {};

  const nextPerms = permissions ? normalizePermissions(permissions) : role.permissions;
  const hypothetical = roles.map(r => r.id === role.id ? { ...r, permissions: nextPerms } : r);
  const users = loadUsers();
  if (wouldLoseAllUserManagers(users, hypothetical)) {
    return res.status(400).json({ error: 'must_keep_one_user_manager' });
  }

  if (name && name.toLowerCase() !== role.name.toLowerCase()) {
    if (roles.some(r => r.id !== role.id && r.name.toLowerCase() === String(name).toLowerCase())) {
      return res.status(409).json({ error: 'name_taken' });
    }
    role.name = name;
  }
  role.permissions = nextPerms;
  saveRoles(roles);
  res.json({ role });
});

app.delete('/api/roles/:id', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const roles = loadRoles();
  const role = roles.find(r => r.id === req.params.id);
  if (!role) return res.status(404).json({ error: 'not_found' });
  const users = loadUsers();
  if (users.some(u => u.roleId === role.id)) return res.status(400).json({ error: 'role_in_use' });
  saveRoles(roles.filter(r => r.id !== role.id));
  res.json({ ok: true });
});

/* ---- User management ---- */
app.get('/api/users', requireAuth, requirePermission('users', 'view'), (req, res) => {
  const roles = loadRoles();
  const users = loadUsers().map(u => ({
    ...sanitizeUser(u),
    roleName: (roles.find(r => r.id === u.roleId) || {}).name || 'Unknown role'
  }));
  res.json({ users });
});

app.post('/api/users', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const { username, name, password, roleId, storeId } = req.body || {};
  if (!username || !password || !roleId) return res.status(400).json({ error: 'missing_fields' });
  const roles = loadRoles();
  if (!roles.some(r => r.id === roleId)) return res.status(400).json({ error: 'invalid_role' });
  const users = loadUsers();
  if (users.some(u => u.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: 'username_taken' });
  }
  const { salt, hash } = hashPassword(password);
  const user = { id: uid(), username, name: name || username, roleId, storeId: storeId || null, salt, hash, active: true, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  res.json({ user: sanitizeUser(user) });
});

app.put('/api/users/:id', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const { name, roleId, active, password, username, storeId } = req.body || {};
  const roles = loadRoles();
  if (roleId && !roles.some(r => r.id === roleId)) return res.status(400).json({ error: 'invalid_role' });

  const hypothetical = users.map(u => u.id === user.id
    ? { ...u, roleId: roleId || u.roleId, active: active !== undefined ? active : u.active }
    : u);
  if (wouldLoseAllUserManagers(hypothetical, roles)) {
    return res.status(400).json({ error: 'must_keep_one_user_manager' });
  }

  if (username && username.toLowerCase() !== user.username.toLowerCase()) {
    if (users.some(u => u.id !== user.id && u.username.toLowerCase() === String(username).toLowerCase())) {
      return res.status(409).json({ error: 'username_taken' });
    }
    user.username = username;
  }
  if (name !== undefined) user.name = name;
  if (roleId) user.roleId = roleId;
  if (storeId !== undefined) user.storeId = storeId || null;
  if (active !== undefined) user.active = active;
  if (password) { const { salt, hash } = hashPassword(password); user.salt = salt; user.hash = hash; }

  saveUsers(users);
  res.json({ user: sanitizeUser(user) });
});

app.delete('/api/users/:id', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const remaining = users.filter(u => u.id !== req.params.id);
  if (wouldLoseAllUserManagers(remaining, loadRoles())) {
    return res.status(400).json({ error: 'must_keep_one_user_manager' });
  }
  saveUsers(remaining);
  res.json({ ok: true });
});

/* ---- App data (login required; write blocked per-module by role) ---- */
app.get('/api/state', requireAuth, (req, res) => {
  res.json(loadState());
});

app.post('/api/state', requireAuth, (req, res) => {
  const incoming = req.body;
  if (!incoming || !Array.isArray(incoming.stores) || !Array.isArray(incoming.statuses)) {
    return res.status(400).json({ error: 'Invalid state payload' });
  }
  const current = loadState();
  for (const [field, moduleId] of Object.entries(STATE_FIELD_MODULE)) {
    if (JSON.stringify(incoming[field]) !== JSON.stringify(current[field])) {
      if ((req.userPerms[moduleId] || 'none') !== 'edit') {
        return res.status(403).json({ error: 'forbidden_module', module: moduleId });
      }
    }
  }
  try {
    saveState(incoming);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to save state:', e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// Ensure the data file, default roles, and a seed admin account exist on boot.
loadState();
ensureSeedRolesAndAdmin();

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  console.log('');
  console.log('TechB server is running.');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  addresses.forEach(addr => console.log(`  On phones/other PCs: http://${addr}:${PORT}  (same WiFi)`));
  console.log('');
  console.log('Keep this window open while people are using the app. Press Ctrl+C to stop.');
});
