// Small helpers for reading cookies and for signed (tamper-proof) cookie values.

const crypto = require('crypto');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

// Returns the original value if the signature is valid, otherwise null.
function unsign(signed, secret) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value, secret));
  const actual = Buffer.from(signed);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? value : null;
}

module.exports = { readCookie, sign, unsign };
