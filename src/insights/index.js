// Runs the insight pipeline for a request:
//   1. rule checks (synchronous, at submission) -> stored immediately
//   2. AI classification (in the background, if configured) -> merged in
// The final risk is the highest of the rule flags and the AI's view; AI can raise it, never lower it.

const Anthropic = require('@anthropic-ai/sdk').default;
const { detectAnomalies, maxRisk } = require('./rules');
const { audit } = require('../audit');

// JSONB columns can come back as text from some drivers; always return an array.
const asArray = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

async function loadRequest(db, requestId) {
  const { rows } = await db.query('SELECT * FROM requests WHERE id = $1', [requestId]);
  return rows[0] || null;
}

// Step 1. Called right after a request is created. Returns the stored insight.
async function runRuleChecks(pool, requestId, { aiEnabled }) {
  const request = await loadRequest(pool, requestId);
  const amount = request.amount == null ? null : Number(request.amount);
  const flags = await detectAnomalies(pool, { ...request, amount });
  const risk = maxRisk(flags);
  await pool.query(
    `INSERT INTO request_insights (request_id, risk_level, rule_flags, ai_status) VALUES ($1, $2, $3, $4)`,
    [requestId, risk, JSON.stringify(flags), aiEnabled ? 'pending' : 'off']
  );
  return { risk_level: risk, rule_flags: flags };
}

// Step 2. AI classification. Never throws: failures are stored on the insight.
async function runAi(pool, classifier, requestId) {
  try {
    const request = await loadRequest(pool, requestId);
    const { rows: [insight] } = await pool.query('SELECT rule_flags FROM request_insights WHERE request_id = $1', [requestId]);
    const ruleFlags = asArray(insight?.rule_flags);
    const role = await pool.query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [request.workspace_id, request.requester_id]);
    const past = await pool.query('SELECT COUNT(*)::int AS n FROM requests WHERE workspace_id = $1 AND requester_id = $2 AND id <> $3', [request.workspace_id, request.requester_id, requestId]);

    const result = await classifier.classify(
      { ...request, amount: request.amount == null ? null : Number(request.amount),
        start_date: request.start_date && String(request.start_date instanceof Date ? request.start_date.toISOString() : request.start_date).slice(0, 10),
        end_date: request.end_date && String(request.end_date instanceof Date ? request.end_date.toISOString() : request.end_date).slice(0, 10) },
      ruleFlags,
      { requesterRole: role.rows[0]?.role || 'employee', pastCount: past.rows[0].n }
    );
    const risk = maxRisk(ruleFlags, result.risk_level, ...result.flags.map((f) => f.severity));
    await pool.query(
      `UPDATE request_insights SET category = $1, summary = $2, ai_flags = $3, risk_level = $4, ai_status = 'done',
              ai_model = $5, ai_error = NULL, updated_at = NOW() WHERE request_id = $6`,
      [result.category, result.summary, JSON.stringify(result.flags), risk, result.model, requestId]
    );
    await audit(pool, {
      workspaceId: request.workspace_id, actorId: null, action: 'request.analyzed', entityType: 'request', entityId: requestId,
      details: { category: result.category, risk_level: risk, ai_flags: result.flags.map((f) => f.code), model: result.model },
    });
  } catch (err) {
    const reason = err instanceof Anthropic.RateLimitError ? 'Rate limited by the AI provider'
      : err instanceof Anthropic.AuthenticationError ? 'AI credentials are invalid'
      : err instanceof Anthropic.APIError ? `AI provider error ${err.status}`
      : err.message;
    console.error(`AI classification failed for request ${requestId}:`, reason);
    await pool.query(
      "UPDATE request_insights SET ai_status = 'failed', ai_error = $1, updated_at = NOW() WHERE request_id = $2",
      [String(reason).slice(0, 300), requestId]
    ).catch(() => {});
  }
}

async function getInsight(db, requestId) {
  const { rows } = await db.query(
    `SELECT risk_level, rule_flags, category, summary, ai_flags, ai_status, ai_model, ai_error, updated_at
       FROM request_insights WHERE request_id = $1`,
    [requestId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], rule_flags: asArray(rows[0].rule_flags), ai_flags: asArray(rows[0].ai_flags) };
}

module.exports = { runRuleChecks, runAi, getInsight, asArray };
