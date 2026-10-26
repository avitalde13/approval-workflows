#!/bin/zsh
# Saves your Google OAuth client into .env (which git ignores).
# The client secret is hidden while you paste it and is never printed.
cd "$(dirname "$0")/.." || exit 1

echo "Google sign-in setup for Approval Workflows"
echo
echo "Paste the Client ID (ends with .apps.googleusercontent.com), then press Enter:"
read "client_id?> "
client_id="${client_id//[[:space:]]/}"
if [[ "$client_id" != *.apps.googleusercontent.com ]]; then
  echo "That doesn't look like a Google Client ID. Nothing was saved."
  exit 1
fi

echo "Paste the Client secret, then press Enter (nothing will appear while you paste):"
read -s "client_secret?> "
echo
client_secret="${client_secret//[[:space:]]/}"
if [[ ${#client_secret} -lt 10 ]]; then
  echo "That doesn't look like a client secret. Nothing was saved."
  exit 1
fi

touch .env && chmod 600 .env
# Drop old values for the keys we set, keep everything else.
grep -v -E '^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)=' .env > .env.tmp 2>/dev/null || true
mv .env.tmp .env && chmod 600 .env
grep -q '^APP_URL=' .env || echo "APP_URL=http://localhost:3000" >> .env
grep -q '^SESSION_SECRET=' .env || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
echo "GOOGLE_CLIENT_ID=$client_id" >> .env
echo "GOOGLE_CLIENT_SECRET=$client_secret" >> .env
unset client_secret

echo
echo "Saved to .env. Start the app with:  npm run dev"
echo "Then open http://localhost:3000 and click Continue with Google."
