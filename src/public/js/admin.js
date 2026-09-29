const $ = id => document.getElementById(id);

let CURRENT_USER = null;
let USERS = [];
let pwdTargetId = null;

let STATIC_RECORDS = [];
let staticEditId = null;      // null = creating a new record, else editing this id
let staticSearchTimer = null;

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { t.className = 'toast'; }, 2600);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ─── Bootstrap ─── */
async function init() {
  try {
    const meRes = await fetch('/api/auth/me');
    if (!meRes.ok) { window.location.href = '/login'; return; }
    const me = await meRes.json();
    CURRENT_USER = me.user;

    if (CURRENT_USER.role !== 'admin') {
      window.location.href = '/';
      return;
    }

    $('topUsername').textContent = CURRENT_USER.username;
    $('avatarInitial').textContent = CURRENT_USER.username.slice(0, 1).toUpperCase();

    await loadUsers();
    await loadStaticData();
  } catch (err) {
    console.error(err);
    window.location.href = '/login';
  }
}

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  if (!res.ok) {
    if (res.status === 401) { window.location.href = '/login'; return; }
    showToast('Failed to load users', 'error');
    return;
  }
  const data = await res.json();
  USERS = data.users;
  renderUsers();
}

function renderUsers() {
  const admins = USERS.filter(u => u.role === 'admin').length;
  $('statTotal').textContent = USERS.length;
  $('statAdmins').textContent = admins;
  $('statUsers').textContent = USERS.length - admins;

  if (!USERS.length) {
    $('usersBody').innerHTML = `<tr><td colspan="5" class="empty-state">No users yet.</td></tr>`;
    return;
  }

  $('usersBody').innerHTML = USERS.map(u => `
    <tr>
      <td>
        <div class="u-name">${escHtml(u.username)}${u.id === CURRENT_USER.id ? ' <span style="color:var(--text-dim);font-weight:400;">(you)</span>' : ''}</div>
      </td>
      <td class="u-id">${escHtml(u.id)}</td>
      <td><span class="pill-role ${u.role}">${u.role}</span></td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>
        <div class="row-actions">
          <button class="btn-mini primary" onclick="openPasswordModal('${escHtml(u.id)}','${escHtml(u.username)}')">Reset Password</button>
          <button class="btn-mini" onclick="toggleRole('${escHtml(u.id)}','${u.role}')" ${u.id === CURRENT_USER.id ? 'disabled title="You cannot change your own role"' : ''}>
            Make ${u.role === 'admin' ? 'User' : 'Admin'}
          </button>
          <button class="btn-mini danger" onclick="deleteUser('${escHtml(u.id)}','${escHtml(u.username)}')" ${u.id === CURRENT_USER.id ? 'disabled title="You cannot delete yourself"' : ''}>Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

/* ─── Add user ─── */
$('btnAddUser').addEventListener('click', () => {
  $('newUsername').value = '';
  $('newPassword').value = '';
  $('newRole').value = 'user';
  $('addUserModal').classList.remove('hidden');
  $('newUsername').focus();
});
$('cancelAddUser').addEventListener('click', () => $('addUserModal').classList.add('hidden'));

$('confirmAddUser').addEventListener('click', async () => {
  const username = $('newUsername').value.trim();
  const password = $('newPassword').value;
  const role = $('newRole').value;

  if (username.length < 3) { showToast('Username must be at least 3 characters', 'error'); return; }
  if (password.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }

  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create user');

    $('addUserModal').classList.add('hidden');
    showToast(`User "${username}" created`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ─── Reset password (admin can do this for ANY user) ─── */
function openPasswordModal(id, username) {
  pwdTargetId = id;
  $('pwdModalUsername').textContent = username;
  $('pwdNewPassword').value = '';
  $('pwdModal').classList.remove('hidden');
  $('pwdNewPassword').focus();
}
$('cancelPwd').addEventListener('click', () => $('pwdModal').classList.add('hidden'));

$('confirmPwd').addEventListener('click', async () => {
  const password = $('pwdNewPassword').value;
  if (password.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }

  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(pwdTargetId)}/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reset password');

    $('pwdModal').classList.add('hidden');
    showToast('Password updated', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ─── Toggle role ─── */
async function toggleRole(id, currentRole) {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to change role');
    showToast(`Role updated to ${newRole}`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─── Delete user ─── */
async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete user');
    showToast(`User "${username}" deleted`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ═══════════════ Static Fund Data (Database CRUD) ═══════════════ */

async function loadStaticData(search = '') {
  const url = '/api/admin/fund-static-data' + (search ? `?search=${encodeURIComponent(search)}` : '');
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 401) { window.location.href = '/login'; return; }
    showToast('Failed to load static fund data', 'error');
    return;
  }
  const data = await res.json();
  STATIC_RECORDS = data.records;
  renderStaticData();
}

function renderStaticData() {
  if (!STATIC_RECORDS.length) {
    $('staticBody').innerHTML = `<tr><td colspan="6" class="empty-state">No records found.</td></tr>`;
    return;
  }

  $('staticBody').innerHTML = STATIC_RECORDS.map(r => `
    <tr>
      <td><div class="u-name">${escHtml(r.scheme_name)}</div></td>
      <td>${r.category ? escHtml(r.category) : '<span class="cell-dim">—</span>'}</td>
      <td>${r.exitLoad ? escHtml(r.exitLoad) : '<span class="cell-dim">—</span>'}</td>
      <td>
        <div class="sectors-cell">
          ${(r.amfiSectors || []).length
            ? r.amfiSectors.map(s => `<span class="sector-tag">${escHtml(s)}</span>`).join('')
            : '<span class="cell-dim">—</span>'}
        </div>
      </td>
      <td>${fmtDate(r.updated_at)}</td>
      <td>
        <div class="row-actions">
          <button class="btn-mini primary" onclick="openStaticModal(${r.id})">Edit</button>
          <button class="btn-mini danger" onclick="deleteStaticRecord(${r.id}, '${escHtml(r.scheme_name).replace(/'/g, "\\'")}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

$('staticSearch').addEventListener('input', (e) => {
  clearTimeout(staticSearchTimer);
  const value = e.target.value.trim();
  staticSearchTimer = setTimeout(() => loadStaticData(value), 300);
});

/* ─── Download demo template ─── */
$('btnDownloadTemplate').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/admin/fund-static-data/template');
    if (!res.ok) throw new Error('Could not generate the template');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Static_Fund_Data_Template.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ─── Export ALL current records (same layout as the template/bulk-import,
       so editing and re-uploading this file just works) ─── */
$('btnExportExcel').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/admin/fund-static-data/export');
    if (!res.ok) throw new Error('Could not generate the export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Prefer the server's dated filename (from Content-Disposition); fall back if unavailable.
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    a.download = match ? match[1] : 'Static_Fund_Data_Export.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ─── Bulk upload Excel ─── */
$('btnUploadExcel').addEventListener('click', () => $('staticExcelFile').click());

$('staticExcelFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file next time
  if (!file) return;

  const fileBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });

  showToast(`Uploading "${file.name}"…`, 'success');

  try {
    const res = await fetch('/api/admin/fund-static-data/bulk-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    showToast(`Done: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped (of ${data.totalRows} rows)`, 'success');
    if (data.errors && data.errors.length) {
      alert(`${data.errors.length} row(s) had errors:\n\n` + data.errors.slice(0, 20).join('\n') + (data.errors.length > 20 ? `\n…and ${data.errors.length - 20} more` : ''));
    }
    await loadStaticData($('staticSearch').value.trim());
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ─── Dynamic key/value rows (Risk Measures / Market Cap / Sectors / Exit Load) ─── */
function addKvRow(containerId, name = '', value = '', namePlaceholder = 'Name (e.g. Standard Deviation)', valuePlaceholder = 'Value (e.g. 12.4)') {
  const container = $(containerId);
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.innerHTML = `
    <input type="text" class="kv-name" placeholder="${escHtml(namePlaceholder)}" value="${escHtml(name)}"/>
    <input type="text" class="kv-value" placeholder="${escHtml(valuePlaceholder)}" value="${escHtml(value)}"/>
    <button type="button" class="kv-row-remove" title="Remove">✕</button>
  `;
  row.querySelector('.kv-row-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function readKvRows(containerId) {
  const result = {};
  $(containerId).querySelectorAll('.kv-row').forEach(row => {
    const name = row.querySelector('.kv-name').value.trim();
    const value = row.querySelector('.kv-value').value.trim();
    if (name) result[name] = value;
  });
  return result;
}

/* Existing display formats are kept backward compatible with the rest of
   the app (dashboard, rule-engine, calendar views all read amfiSectors as
   a plain string array and exitLoad as a plain string) — these two
   helpers just turn those flat strings back into editable rows, and the
   inverse conversion happens in confirmStatic() below. */
function parseSectorString(str) {
  const match = String(str || '').match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (match) return { sector: match[1].trim(), percentage: match[2].trim() };
  return { sector: String(str || '').trim(), percentage: '' };
}

function parseExitLoadString(str) {
  const text = String(str || '').trim();
  if (!text) return [];
  return text.split(/;\s*/).filter(Boolean).map(piece => {
    const match = piece.match(/^(.*?)\s—\s(.*)$/);
    if (match) return { condition: match[1].trim(), value: match[2].trim() };
    return { condition: piece.trim(), value: '' };
  });
}

$('addSectorRow').addEventListener('click', () => addKvRow('sectorRows', '', '', 'Sector name', 'Percentage e.g. 25%'));
$('addRiskRow').addEventListener('click', () => addKvRow('riskRows'));
$('addMarketRow').addEventListener('click', () => addKvRow('marketRows', '', '', 'Name (e.g. Large Cap)', 'Percentage e.g. 78%'));
$('addExitLoadRow').addEventListener('click', () => addKvRow('exitLoadRows', '', '', 'Condition / Slab', 'Value e.g. 1% or Nil'));

/* ─── Add / Edit modal ─── */
function openStaticModal(id = null) {
  staticEditId = id;
  $('sectorRows').innerHTML = '';
  $('riskRows').innerHTML = '';
  $('marketRows').innerHTML = '';
  $('exitLoadRows').innerHTML = '';

  if (id) {
    const record = STATIC_RECORDS.find(r => r.id === id);
    if (!record) return;
    $('staticModalTitle').textContent = 'Edit Static Fund Record';
    $('staticSchemeName').value = record.scheme_name || '';
    $('staticCategory').value = record.category || '';
    (record.amfiSectors || []).forEach(s => {
      const { sector, percentage } = parseSectorString(s);
      addKvRow('sectorRows', sector, percentage, 'Sector name', 'Percentage e.g. 25%');
    });
    Object.entries(record.riskMeasures || {}).forEach(([k, v]) => addKvRow('riskRows', k, v));
    Object.entries(record.marketCapitalisation || {}).forEach(([k, v]) =>
      addKvRow('marketRows', k, v, 'Name (e.g. Large Cap)', 'Percentage e.g. 78%'));
    parseExitLoadString(record.exitLoad).forEach(row =>
      addKvRow('exitLoadRows', row.condition, row.value, 'Condition / Slab', 'Value e.g. 1% or Nil'));
  } else {
    $('staticModalTitle').textContent = 'Add Static Fund Record';
    $('staticSchemeName').value = '';
    $('staticCategory').value = '';
    addKvRow('sectorRows', '', '', 'Sector name', 'Percentage e.g. 25%');
    addKvRow('riskRows');
    addKvRow('marketRows', '', '', 'Name (e.g. Large Cap)', 'Percentage e.g. 78%');
    addKvRow('exitLoadRows', '', '', 'Condition / Slab', 'Value e.g. 1% or Nil');
  }

  $('staticModal').classList.remove('hidden');
  $('staticSchemeName').focus();
}

$('btnAddStatic').addEventListener('click', () => openStaticModal(null));
$('cancelStatic').addEventListener('click', () => $('staticModal').classList.add('hidden'));

$('confirmStatic').addEventListener('click', async () => {
  const schemeName = $('staticSchemeName').value.trim();
  if (!schemeName) { showToast('Scheme name is required', 'error'); return; }

  const amfiSectors = Object.entries(readKvRows('sectorRows'))
    .map(([sector, percentage]) => ({ sector, percentage }))
    .slice(0, 10);

  const exitLoad = Object.entries(readKvRows('exitLoadRows'))
    .map(([condition, value]) => ({ condition, value }));

  const payload = {
    schemeName,
    category: $('staticCategory').value.trim(),
    amfiSectors,
    exitLoad,
    riskMeasures: readKvRows('riskRows'),
    marketCapitalisation: readKvRows('marketRows'),
    source: 'admin'
  };

  try {
    const isEdit = !!staticEditId;
    const res = await fetch(
      isEdit ? `/api/admin/fund-static-data/${staticEditId}` : '/api/admin/fund-static-data',
      {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save record');

    $('staticModal').classList.add('hidden');
    showToast(isEdit ? 'Record updated' : 'Record created', 'success');
    await loadStaticData($('staticSearch').value.trim());
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ─── Delete static record ─── */
async function deleteStaticRecord(id, schemeName) {
  if (!confirm(`Delete static data for "${schemeName}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/fund-static-data/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete record');
    showToast('Record deleted', 'success');
    await loadStaticData($('staticSearch').value.trim());
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─── Logout ─── */
$('btnLogout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

init();