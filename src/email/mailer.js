// Sends email through an HTTP email API. Providers:
// - "console": development and tests. Nothing leaves the machine; emails are printed and kept in memory
//   (newest first) so you can open them at /dev/outbox.
// - "brevo":  https://brevo.com  (BREVO_API_KEY, EMAIL_FROM must be a verified sender)
// - "resend": https://resend.com (RESEND_API_KEY, EMAIL_FROM on a verified domain)
// - "none":   nothing is sent. Invitations return their link so an Admin can share it.

const OUTBOX_LIMIT = 50;

function createMailer({ provider, from, fromName, brevoApiKey, resendApiKey }, { fetchImpl = fetch, log = console.log } = {}) {
  const outbox = [];

  async function send({ to, subject, text, html }) {
    if (!to || !subject || !text) throw new Error('Email needs to, subject and text');

    if (provider === 'console') {
      outbox.unshift({ to, subject, text, html, sentAt: new Date().toISOString() });
      outbox.length = Math.min(outbox.length, OUTBOX_LIMIT);
      log(`\n[email] To: ${to}\nSubject: ${subject}\n${text}\n`);
      return { id: `console-${Date.now()}` };
    }

    if (provider === 'none') return { id: null, skipped: true };

    if (provider === 'brevo') {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { name: fromName, email: from }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
      });
      if (!res.ok) throw new Error(`Brevo error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    }

    if (provider === 'resend') {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, text, html }),
      });
      if (!res.ok) throw new Error(`Resend error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    }

    throw new Error(`Unknown EMAIL_PROVIDER "${provider}"`);
  }

  return { send, outbox, provider };
}

module.exports = { createMailer };
