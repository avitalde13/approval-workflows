-- Slack: an incoming webhook per workspace. Approvals, decisions and budget alerts are posted to its channel.
ALTER TABLE workspaces ADD COLUMN slack_webhook_url TEXT;
