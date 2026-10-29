// Workspace settings (Admins change them; every member can read them) and each member's out-of-office.
//
//   GET   /api/workspaces/:id/settings
//   PATCH /api/workspaces/:id/settings      { reminder_hours, escalate_hours }        (Admins)
//   PUT   /api/workspaces/:id/away          { away_from, away_until, delegate_id }    (yourself)
//   DELETE /api/workspaces/:id/away
//   PATCH /api/workspaces/:id/settings      { base_currency }                          (Admins; clears the rates)
//   PUT   /api/workspaces/:id/rates         { rates: { EUR: 1.08, ... } }              (Admins)
//   POST  /api/workspaces/:id/rates/refresh                                            (Admins: today's ECB rates)
//   GET   /api/workspaces/:id/departments                                              (members: with budget usage)
//   POST  /api/workspaces/:id/departments    { name, budget_amount, budget_period }    (Admins)
//   PATCH /api/workspaces/:id/departments/:deptId                                      (Admins)
//   DELETE /api/workspaces/:id/departments/:deptId                                     (Admins)

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');
const { audit } = require('../audit');
const { activateStep, awayInfo } = require('../routing');
const { loadRequestInfo } = require('../notifier');
const { CURRENCIES, getFx, refreshRates, setRate } = require('../currency');
const { budgetUsage } = require('../budgets');
const { parseId } = require('../workspaces');

const PERIODS = ['month', 'quarter', 'year'];

function validDepartment(body, partial = false) {
  const out = {};
  if (!partial || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 60) return { error: 'Department name must be 2–60 characters.' };
    out.name = name;
  }
  if (!partial || 'budget_amount' in body) {
    if (body.budget_amount === null || body.budget_amount === '' || body.budget_amount === undefined) out.budget_amount = null;
    else {
      const n = Number(body.budget_amount);
      if (!Number.isFinite(n) || n <= 0 || n > 1e10) return { error: 'Budget must be a positive amount, or empty for no budget.' };
      out.budget_amount = Math.round(n * 100) / 100;
    }
  }
  if (!partial || 'budget_period' in body) {
    const p = body.budget_period || 'quarter';
    if (!PERIODS.includes(p)) return { error: 'Budget period must be month, quarter or year.' };
    out.budget_period = p;
  }
  return { data: out };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Hours between 1 and 30 days, or null (off).
function hoursOrNull(v) {
  if (v === null || v === '' || v === undefined) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 720) return { error: 'Use a whole number of hours between 1 and 720, or leave it empty to turn it off.' };
  return { value: n };
}

async function loadSettings(pool, workspaceId) {
  const { rows } = await pool.query('SELECT reminder_hours, escalate_hours, base_currency FROM workspaces WHERE id = $1', [workspaceId]);
  const fx = await getFx(pool, workspaceId);
  return { ...rows[0], currencies: CURRENCIES, rates: fx.list };
}

function settingsRoutes(pool, notifier, { fetchImpl = fetch } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser);

  router.get('/settings', requireMember(pool), async (req, res, next) => {
    try {
      res.json(await loadSettings(pool, req.workspaceId));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/settings', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const changes = {};
      for (const key of ['reminder_hours', 'escalate_hours']) {
        if (!(key in body)) continue;
        const { value, error } = hoursOrNull(body[key]);
        if (error) return res.status(400).json({ error });
        changes[key] = value;
      }
      const next_ = { ...(await loadSettings(pool, req.workspaceId)), ...changes };
      if (next_.reminder_hours && next_.escalate_hours && next_.escalate_hours <= next_.reminder_hours) {
        return res.status(400).json({ error: 'Escalation should come after the reminder.' });
      }
      if ('base_currency' in body) {
        if (!CURRENCIES.includes(body.base_currency)) return res.status(400).json({ error: `Base currency must be one of ${CURRENCIES.join(', ')}.` });
        const current = (await loadSettings(pool, req.workspaceId)).base_currency;
        if (body.base_currency !== current) {
          changes.base_currency = body.base_currency;
          // Rates are relative to the base currency, so they start over.
          await pool.query('DELETE FROM exchange_rates WHERE workspace_id = $1', [req.workspaceId]);
        }
      }
      for (const [key, value] of Object.entries(changes)) {
        await pool.query(`UPDATE workspaces SET ${key} = $1 WHERE id = $2`, [value, req.workspaceId]); // key is from the fixed list above
      }
      if (Object.keys(changes).length) {
        await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'settings.updated', entityType: 'workspace', entityId: req.workspaceId, details: changes });
      }
      res.json(await loadSettings(pool, req.workspaceId));
    } catch (err) {
      next(err);
    }
  });

  // ---------- Exchange rates ----------
  router.put('/rates', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const rates = req.body?.rates && typeof req.body.rates === 'object' ? req.body.rates : null;
      if (!rates) return res.status(400).json({ error: 'Send { rates: { EUR: 1.08 } }.' });
      const { base } = await getFx(pool, req.workspaceId);
      for (const [currency, value] of Object.entries(rates)) {
        if (!CURRENCIES.includes(currency) || currency === base) return res.status(400).json({ error: `Unsupported currency ${currency}.` });
        if (value === null || value === '') { await pool.query('DELETE FROM exchange_rates WHERE workspace_id = $1 AND currency = $2', [req.workspaceId, currency]); continue; }
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0 || n > 1e6) return res.status(400).json({ error: `The rate for ${currency} must be a positive number.` });
        await setRate(pool, req.workspaceId, currency, n);
      }
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'settings.rates_updated', entityType: 'workspace', entityId: req.workspaceId, details: { rates } });
      res.json(await loadSettings(pool, req.workspaceId));
    } catch (err) {
      next(err);
    }
  });

  router.post('/rates/refresh', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const saved = await refreshRates(pool, req.workspaceId, fetchImpl);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'settings.rates_updated', entityType: 'workspace', entityId: req.workspaceId, details: { source: 'ecb', count: saved } });
      res.json({ ...(await loadSettings(pool, req.workspaceId)), refreshed: saved });
    } catch (err) {
      console.error('Rate refresh failed:', err.message);
      res.status(502).json({ error: "Couldn't reach the exchange rate service. Try again later, or enter rates by hand." });
    }
  });

  // ---------- Departments and budgets ----------
  router.get('/departments', requireMember(pool), async (req, res, next) => {
    try {
      const fx = await getFx(pool, req.workspaceId);
      res.json({ base_currency: fx.base, departments: await budgetUsage(pool, req.workspaceId, { fx }) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/departments', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const { data, error } = validDepartment(req.body || {});
      if (error) return res.status(400).json({ error });
      const dup = await pool.query('SELECT 1 FROM departments WHERE workspace_id = $1 AND LOWER(name) = LOWER($2)', [req.workspaceId, data.name]);
      if (dup.rows.length) return res.status(409).json({ error: `There is already a ${data.name} department.` });
      const { rows: [dept] } = await pool.query(
        'INSERT INTO departments (workspace_id, name, budget_amount, budget_period) VALUES ($1, $2, $3, $4) RETURNING id, name',
        [req.workspaceId, data.name, data.budget_amount, data.budget_period]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'department.created', entityType: 'department', entityId: dept.id, details: data });
      res.status(201).json(dept);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/departments/:deptId', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const deptId = parseId(req.params.deptId);
      const { data, error } = validDepartment(req.body || {}, true);
      if (error) return res.status(400).json({ error });
      const found = await pool.query('SELECT 1 FROM departments WHERE id = $1 AND workspace_id = $2', [deptId, req.workspaceId]);
      if (!found.rows.length) return res.status(404).json({ error: 'Department not found.' });
      for (const [key, value] of Object.entries(data)) {
        await pool.query(`UPDATE departments SET ${key} = $1 WHERE id = $2`, [value, deptId]); // keys come from validDepartment
      }
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'department.updated', entityType: 'department', entityId: deptId, details: data });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/departments/:deptId', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const deptId = parseId(req.params.deptId);
      const { rows: [dept] } = await pool.query('SELECT name FROM departments WHERE id = $1 AND workspace_id = $2', [deptId, req.workspaceId]);
      if (!dept) return res.status(404).json({ error: 'Department not found.' });
      // People and past requests keep working; they just no longer have a department.
      await pool.query('UPDATE memberships SET department_id = NULL WHERE department_id = $1', [deptId]);
      await pool.query('UPDATE requests SET department_id = NULL WHERE department_id = $1', [deptId]);
      await pool.query('DELETE FROM departments WHERE id = $1', [deptId]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'department.deleted', entityType: 'department', entityId: deptId, details: { name: dept.name } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Out of office. Approvals already waiting for you move to your delegate right away (if you're away today).
  router.put('/away', requireMember(pool), async (req, res, next) => {
    try {
      const { away_from: from, away_until: until } = req.body || {};
      const delegateId = Number(req.body?.delegate_id) || null;
      if ((from && !DATE_RE.test(from)) || !DATE_RE.test(until || '')) return res.status(400).json({ error: 'Pick the dates you are away (YYYY-MM-DD).' });
      if (from && until < from) return res.status(400).json({ error: 'The last day must be on or after the first day.' });
      if (!delegateId || delegateId === req.user.id) return res.status(400).json({ error: 'Pick someone to approve for you while you are away.' });
      const member = await pool.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [req.workspaceId, delegateId]);
      if (!member.rows.length) return res.status(400).json({ error: 'The delegate must be a member of this workspace.' });

      await pool.query('UPDATE memberships SET away_from = $1, away_until = $2, delegate_id = $3 WHERE workspace_id = $4 AND user_id = $5',
        [from || null, until, delegateId, req.workspaceId, req.user.id]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.away_set', entityType: 'user', entityId: req.user.id,
        details: { from: from || null, until, delegate_id: delegateId } });

      let moved = 0;
      if (awayInfo({ away_from: from, away_until: until, delegate_id: delegateId }).away) {
        const { rows } = await pool.query(
          `SELECT a.id, r.id AS request_id, r.requester_id FROM request_approvals a JOIN requests r ON r.id = a.request_id
            WHERE r.workspace_id = $1 AND a.approver_id = $2 AND a.status = 'pending' AND r.status = 'pending'`,
          [req.workspaceId, req.user.id]
        );
        for (const step of rows) {
          const routed = await activateStep(pool, step.id, { workspaceId: req.workspaceId, requesterId: step.requester_id, approverId: req.user.id });
          if (routed.delegatedFrom) {
            moved++;
            await notifier.approvalNeeded(await loadRequestInfo(pool, step.request_id), routed.approverId,
              { kind: 'delegated', note: `${req.user.name} is out of office and asked you to approve on their behalf.` });
          }
        }
      }
      res.json({ ok: true, moved });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/away', requireMember(pool), async (req, res, next) => {
    try {
      await pool.query('UPDATE memberships SET away_from = NULL, away_until = NULL, delegate_id = NULL WHERE workspace_id = $1 AND user_id = $2',
        [req.workspaceId, req.user.id]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.away_cleared', entityType: 'user', entityId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { settingsRoutes };
