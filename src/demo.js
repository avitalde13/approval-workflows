// Live demo: one click on the landing page creates a private sample company ("Northwind Studio")
// with people, approval chains and a few months of requests, and signs the visitor in as its Admin.
// Each visitor gets their own copy, so nobody sees anyone else's changes. Everything is deleted after DEMO_HOURS.

const crypto = require('crypto');
const { resolveApprovers } = require('./chains');
const { runRuleChecks } = require('./insights');

const DEMO_HOURS = 24;
const DEMO_DOMAIN = 'demo.greenlight.test'; // never a real mailbox; the mailer skips it

const PEOPLE = [
  { key: 'alex', name: 'Alex Morgan', role: 'admin', title: 'CEO', manager: null },
  { key: 'priya', name: 'Priya Shah', role: 'manager', title: 'Finance lead', manager: 'alex' },
  { key: 'daniel', name: 'Daniel Cohen', role: 'manager', title: 'Engineering lead', manager: 'alex' },
  { key: 'noa', name: 'Noa Katz', role: 'employee', title: 'Marketing', manager: 'alex' },
  { key: 'maya', name: 'Maya Levi', role: 'employee', title: 'Product designer', manager: 'daniel' },
  { key: 'sam', name: 'Sam Rivera', role: 'employee', title: 'Software engineer', manager: 'daniel' },
];

const CHAINS = {
  purchase: [['Manager', 'manager', null, null], ['Finance', 'user', 'priya', 1000], ['CEO', 'user', 'alex', 5000]],
  expense: [['Manager', 'manager', null, null], ['Finance', 'user', 'priya', 500]],
  time_off: [['Manager', 'manager', null, null]],
};

// Oldest first, so the automatic checks see the history that came before each request.
// decisions: one per step that gets decided, in order: 'approve', ['reject', 'reason'] or ['changes', 'what to change'].
// receipt: attach a generated PDF receipt.
const REQUESTS = [
  { by: 'priya', type: 'purchase', title: 'Google Workspace (annual)', amount: 1440, vendor: 'Google', daysAgo: 88, decisions: ['approve', 'approve'] },
  { by: 'maya', type: 'purchase', title: 'Adobe Creative Cloud', amount: 660, vendor: 'Adobe', daysAgo: 81, decisions: ['approve'] },
  { by: 'daniel', type: 'purchase', title: 'GitHub Team (annual)', amount: 1056, vendor: 'GitHub', daysAgo: 76, decisions: ['approve', 'approve'] },
  { by: 'sam', type: 'purchase', title: 'Keyboard and mouse', amount: 129, vendor: 'Logitech', daysAgo: 70, decisions: ['approve'] },
  { by: 'noa', type: 'purchase', title: 'Facebook ads: October campaign', amount: 2100, vendor: 'Meta', daysAgo: 63, decisions: ['approve', 'approve'] },
  { by: 'priya', type: 'purchase', title: 'Notion team plan', amount: 480, vendor: 'Notion', daysAgo: 58, decisions: ['approve'] },
  { by: 'maya', type: 'purchase', title: 'Usability testing sessions', amount: 750, vendor: 'UserTesting', daysAgo: 52, decisions: ['approve'] },
  { by: 'sam', type: 'expense', title: 'Client dinner with the Acme team', amount: 340, vendor: 'Taizu', daysAgo: 47, decisions: ['approve'], receipt: true },
  { by: 'maya', type: 'time_off', title: 'Long weekend', start: -40, end: -39, daysAgo: 45, decisions: ['approve'] },
  { by: 'maya', type: 'purchase', title: 'Figma Organization plan (annual)', amount: 900, vendor: 'Figma', daysAgo: 41, decisions: ['approve'] },
  { by: 'sam', type: 'purchase', title: 'MacBook Pro 16" for new hire', amount: 2499, vendor: 'Apple', daysAgo: 34, decisions: ['approve', 'approve'], receipt: true },
  { by: 'priya', type: 'expense', title: 'Accounting software (monthly)', amount: 78, vendor: 'Xero', daysAgo: 30, decisions: ['approve'] },
  { by: 'sam', type: 'purchase', title: 'External monitor', amount: 389, vendor: 'Dell', daysAgo: 22, decisions: ['approve'] },
  { by: 'noa', type: 'expense', title: 'Team offsite catering', amount: 1280, vendor: 'Green Kitchen Catering', daysAgo: 16,
    decisions: ['approve', ['reject', 'Please split this by event and attach the receipts.']] },
  { by: 'maya', type: 'purchase', title: 'Conference ticket: Config 2026', amount: 1199, vendor: 'Figma', daysAgo: 9, decisions: ['approve'] },
  { by: 'sam', type: 'expense', title: 'Team lunch after the sprint demo', amount: 186, vendor: 'Sababa', daysAgo: 7,
    decisions: [['changes', 'Please attach the receipt so Finance can file it.']] },
  { by: 'daniel', type: 'time_off', title: 'Family vacation', start: 24, end: 30, daysAgo: 6, decisions: [] },
  { by: 'sam', type: 'purchase', title: 'Standing desk', amount: 649, vendor: 'Fully', daysAgo: 4, decisions: [] },
  { by: 'noa', type: 'purchase', title: 'LinkedIn ads: November campaign', amount: 4950, vendor: 'LinkedIn', daysAgo: 3, decisions: [] },
  { by: 'sam', type: 'purchase', title: 'External monitor', amount: 389, vendor: 'Dell', daysAgo: 2, decisions: [] },
  { by: 'sam', type: 'purchase', title: 'Cloud GPU credits for the ML prototype', amount: 12400, vendor: 'Lambda Labs', daysAgo: 1,
    description: 'Training run for the recommendation prototype. Needed before the investor demo.', decisions: [] },
];

const DAY = 24 * 60 * 60 * 1000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

// A small, valid one-page PDF receipt for the demo.
function receiptPdf(vendor, title, amount, date) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
  const lines = [
    ['F2', 20, 760, vendor], ['F1', 11, 738, `Receipt  ·  ${date.toISOString().slice(0, 10)}`],
    ['F1', 12, 690, title], ['F2', 14, 650, `Total paid: $${amount.toFixed(2)}`],
    ['F1', 10, 620, 'Paid by company card ending 4242. Thank you!'],
  ];
  const stream = lines.map(([f, size, y, text]) => `BT /${f} ${size} Tf 60 ${y} Td (${esc(text)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 820] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

async function insertAudit(db, { workspaceId, actorId, action, entityId, details, at }) {
  await db.query(
    `INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, details, created_at)
     VALUES ($1, $2, $3, 'request', $4, $5, $6)`,
    [workspaceId, actorId, action, entityId, JSON.stringify(details), at]
  );
}

async function seedRequest(db, workspaceId, ids, spec) {
  const requesterId = ids[spec.by];
  const createdAt = new Date(Date.now() - spec.daysAgo * DAY - 3 * 60 * 60 * 1000);
  const amount = spec.amount ?? null;
  const steps = await resolveApprovers(db, { workspaceId, type: spec.type, requesterId, amount });
  const { rows } = await db.query(
    `INSERT INTO requests (workspace_id, requester_id, type, title, description, amount, currency, vendor, start_date, end_date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, $9, $10) RETURNING id`,
    [workspaceId, requesterId, spec.type, spec.title, spec.description || null, amount, spec.vendor || null,
      spec.type === 'time_off' ? day(spec.start) : null, spec.type === 'time_off' ? day(spec.end) : null, createdAt]
  );
  const requestId = rows[0].id;
  let first = true;
  for (const s of steps) {
    const status = s.status === 'waiting' && first ? 'pending' : s.status;
    if (s.status === 'waiting') first = false;
    await db.query(
      `INSERT INTO request_approvals (request_id, position, step_name, approver_id, status, comment, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [requestId, s.position, s.name, s.approver_id, status, s.note || null, s.status === 'skipped' ? createdAt : null]
    );
  }
  await insertAudit(db, { workspaceId, actorId: requesterId, action: 'request.submitted', entityId: requestId, at: createdAt,
    details: { type: spec.type, title: spec.title, amount, currency: 'USD', vendor: spec.vendor || null } });
  await runRuleChecks(db, requestId, { aiEnabled: false });
  if (spec.receipt) {
    const pdf = receiptPdf(spec.vendor, spec.title, spec.amount, createdAt);
    await db.query(
      `INSERT INTO request_files (request_id, filename, content_type, size_bytes, data_base64, uploaded_by, created_at)
       VALUES ($1, $2, 'application/pdf', $3, $4, $5, $6)`,
      [requestId, `receipt-${spec.vendor.toLowerCase().replace(/\W+/g, '-')}.pdf`, pdf.length, pdf.toString('base64'), requesterId, createdAt]
    );
  }

  // Play the decisions, a few hours apart.
  let at = createdAt;
  for (const decision of spec.decisions) {
    const [verdict, comment] = Array.isArray(decision) ? decision : [decision, null];
    const stepStatus = { approve: 'approved', reject: 'rejected', changes: 'returned' }[verdict];
    const { rows: [step] } = await db.query(
      "SELECT id, position, step_name, approver_id FROM request_approvals WHERE request_id = $1 AND status = 'pending'", [requestId]);
    if (!step) break;
    at = new Date(at.getTime() + 5 * 60 * 60 * 1000);
    await db.query('UPDATE request_approvals SET status = $1, comment = $2, decided_at = $3 WHERE id = $4',
      [stepStatus, comment, at, step.id]);
    let final = null;
    let next = null;
    if (verdict === 'approve') {
      ({ rows: [next] } = await db.query(
        "SELECT id, step_name FROM request_approvals WHERE request_id = $1 AND status = 'waiting' ORDER BY position LIMIT 1", [requestId]));
      if (next) await db.query("UPDATE request_approvals SET status = 'pending' WHERE id = $1", [next.id]);
      else final = 'approved';
    } else {
      final = verdict === 'reject' ? 'rejected' : null;
      await db.query("UPDATE request_approvals SET status = 'cancelled' WHERE request_id = $1 AND status = 'waiting'", [requestId]);
      if (verdict === 'changes') await db.query("UPDATE requests SET status = 'changes_requested' WHERE id = $1", [requestId]);
    }
    if (final) await db.query('UPDATE requests SET status = $1, decided_at = $2 WHERE id = $3', [final, at, requestId]);
    await insertAudit(db, { workspaceId, actorId: step.approver_id, entityId: requestId, at,
      action: { reject: 'request.rejected', changes: 'request.changes_requested' }[verdict] || (final ? 'request.approved' : 'request.step_approved'),
      details: { step: step.step_name, comment, next_step: next?.step_name || null } });
  }
}

// Creates a fresh demo company and returns { workspaceId, adminId, expiresAt }.
async function createDemo(pool) {
  const tag = crypto.randomBytes(4).toString('hex');
  const expiresAt = new Date(Date.now() + DEMO_HOURS * 60 * 60 * 1000);
  const ids = {};
  for (const p of PEOPLE) {
    const { rows } = await pool.query('INSERT INTO users (email, name, is_demo) VALUES ($1, $2, TRUE) RETURNING id',
      [`${p.key}.${tag}@${DEMO_DOMAIN}`, p.name]);
    ids[p.key] = rows[0].id;
  }
  const started = new Date(Date.now() - 95 * DAY);
  const { rows: [ws] } = await pool.query(
    'INSERT INTO workspaces (name, slug, created_by, demo_expires_at, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    ['Northwind Studio', `northwind-demo-${tag}`, ids.alex, expiresAt, started]
  );
  for (const p of PEOPLE) {
    await pool.query('INSERT INTO memberships (workspace_id, user_id, role, manager_id, created_at) VALUES ($1, $2, $3, $4, $5)',
      [ws.id, ids[p.key], p.role, p.manager ? ids[p.manager] : null, started]);
  }
  for (const [type, steps] of Object.entries(CHAINS)) {
    for (const [i, [name, approverType, who, min]] of steps.entries()) {
      await pool.query(
        `INSERT INTO approval_steps (workspace_id, request_type, position, name, approver_type, approver_user_id, min_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ws.id, type, i + 1, name, approverType, who ? ids[who] : null, min]
      );
    }
  }
  await pool.query(
    `INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, details, created_at)
     VALUES ($1, $2, 'workspace.created', 'workspace', $1, $3, $4)`,
    [ws.id, ids.alex, JSON.stringify({ name: 'Northwind Studio' }), started]
  );
  for (const spec of REQUESTS) await seedRequest(pool, ws.id, ids, spec);
  return { workspaceId: ws.id, adminId: ids.alex, expiresAt };
}

// Deletes expired demo workspaces and the demo users left without one.
async function cleanupDemos(pool) {
  const { rowCount } = await pool.query('DELETE FROM workspaces WHERE demo_expires_at IS NOT NULL AND demo_expires_at < NOW()');
  await pool.query('DELETE FROM users WHERE is_demo = TRUE AND id NOT IN (SELECT user_id FROM memberships)');
  return rowCount;
}

module.exports = { createDemo, cleanupDemos, DEMO_HOURS, DEMO_DOMAIN, PEOPLE };
