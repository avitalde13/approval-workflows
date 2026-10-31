// "Needs changes" (send back, edit, resubmit) and receipt attachments.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupCompany, send } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f00f0005fe02fe4f2b6b3b0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

// Eli (reports to Mo) submits an expense; Mo is the approver.
async function expense(name) {
  const co = await setupCompany(app, name);
  await send(co.people.ada, 'PATCH', app.base, `/api/workspaces/${co.ws.id}/members/${co.ids.eli}`, { manager_id: co.ids.mo });
  const r = (await co.people.eli.post(`/api/workspaces/${co.ws.id}/requests`, { type: 'expense', title: 'Team lunch', amount: 120, vendor: 'Cafe' })).body;
  return { ...co, r, url: `/api/workspaces/${co.ws.id}/requests/${r.id}` };
}

test('an approver sends a request back; the requester edits and resubmits it for a new round', async () => {
  const { people, r, url } = await expense('Changes');
  assert.equal((await people.mo.post(`${url}/decision`, { decision: 'request_changes', comment: '' })).status, 400, 'needs a comment');
  const back = await people.mo.post(`${url}/decision`, { decision: 'request_changes', comment: 'Please attach the receipt.' });
  assert.equal(back.status, 200);
  assert.equal(back.body.status, 'changes_requested');
  assert.match(app.mailer.outbox[0].subject, /Changes requested: Team lunch/);

  // Nobody can approve it now; only Eli can edit.
  assert.equal((await people.mo.post(`${url}/decision`, { decision: 'approve' })).status, 409);
  const view = (await people.eli.get(url)).body;
  assert.equal(view.can_edit, true);
  assert.equal(view.approvals[0].status, 'returned');
  assert.equal((await people.mo.post(`${url}/resubmit`, { title: 'Team lunch', amount: 100 })).status, 404);

  const again = await people.eli.post(`${url}/resubmit`, { title: 'Team lunch (with receipt)', amount: 95.5, vendor: 'Cafe', type: 'purchase' });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'pending');
  assert.equal(again.body.type, 'expense', 'the type cannot change');
  assert.equal(again.body.amount, 95.5);
  assert.deepEqual(again.body.approvals.map((a) => [a.round, a.status]), [[1, 'returned'], [2, 'pending']]);
  assert.equal((await people.eli.post(`${url}/resubmit`, { title: 'Again', amount: 1 })).status, 409);

  const approved = await people.mo.post(`${url}/decision`, { decision: 'approve' });
  assert.equal(approved.body.status, 'approved');
  const log = (await people.ada.get(`/api/workspaces/${r.workspace_id}/audit-log`)).body.entries.map((e) => e.action);
  assert.ok(log.includes('request.changes_requested') && log.includes('request.resubmitted'));
});

test('the requester can cancel a request that was sent back', async () => {
  const { people, url } = await expense('CancelBack');
  await people.mo.post(`${url}/decision`, { decision: 'request_changes', comment: 'Wrong amount' });
  const res = await people.eli.post(`${url}/cancel`);
  assert.equal(res.status, 200);
  assert.equal((await people.eli.get(url)).body.status, 'cancelled');
});

test('receipts: the requester attaches images or PDFs; approvers can open them', async () => {
  const { people, url } = await expense('Files');
  const add = (who, body) => who.post(`${url}/files`, body);

  const png = await add(people.eli, { filename: 'receipt.png', content_type: 'image/png', data: PNG.toString('base64') });
  assert.equal(png.status, 201);
  assert.equal(png.body.size_bytes, PNG.length);
  assert.equal((await add(people.eli, { filename: 'invoice.pdf', content_type: 'application/pdf', data: PDF.toString('base64') })).status, 201);

  // Wrong type, disguised file, someone else's request
  assert.equal((await add(people.eli, { filename: 'x.html', content_type: 'text/html', data: Buffer.from('<script>').toString('base64') })).status, 400);
  assert.equal((await add(people.eli, { filename: 'fake.png', content_type: 'image/png', data: PDF.toString('base64') })).status, 400);
  assert.equal((await add(people.mo, { filename: 'r.png', content_type: 'image/png', data: PNG.toString('base64') })).status, 403);

  const detail = (await people.mo.get(url)).body;
  assert.deepEqual(detail.files.map((f) => f.filename), ['receipt.png', 'invoice.pdf']);
  const res = await fetch(`${app.base}${url}/files/${png.body.id}`, { headers: { Cookie: [...people.mo.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG));

  // People outside the request can't see it.
  assert.equal((await people.fin.get(`${url}/files/${png.body.id}`)).status, 404);

  // The list shows how many files there are; files are fixed once decided.
  const mine = (await people.eli.get(`/api/workspaces/${detail.workspace_id}/requests?scope=mine`)).body.requests;
  assert.equal(mine[0].file_count, 2);
  await people.mo.post(`${url}/decision`, { decision: 'approve' });
  assert.equal((await send(people.eli, 'DELETE', app.base, `${url}/files/${png.body.id}`)).status, 409);
  // A receipt can still be added after approval (it often arrives later).
  assert.equal((await add(people.eli, { filename: 'late.png', content_type: 'image/png', data: PNG.toString('base64') })).status, 201);
  assert.equal((await people.eli.get(url)).body.can_remove_files, false);
});

test('at most 5 files of up to 5 MB each', async () => {
  const { people, url } = await expense('Limits');
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await people.eli.post(`${url}/files`, { filename: 'big.pdf', content_type: 'application/pdf', data: big.toString('base64') })).status, 413);
  for (let i = 0; i < 5; i++) {
    assert.equal((await people.eli.post(`${url}/files`, { filename: `r${i}.pdf`, content_type: 'application/pdf', data: PDF.toString('base64') })).status, 201);
  }
  assert.equal((await people.eli.post(`${url}/files`, { filename: 'r6.pdf', content_type: 'application/pdf', data: PDF.toString('base64') })).status, 409);
  const one = (await people.eli.get(url)).body.files[0];
  assert.equal((await send(people.eli, 'DELETE', app.base, `${url}/files/${one.id}`)).status, 200);
});
