# Approval Workflows

An approval and purchasing system for organizations. An employee submits a request (a purchase, an expense or time off), and it moves through a chain of approvals: **manager → finance → VP**. Every step sends email notifications and is recorded in an audit log. An AI layer classifies requests automatically and flags anything unusual, like an abnormal amount or a new vendor.

> מערכת אישורים ורכש: עובד מגיש בקשה (רכישה, הוצאה או חופשה), והיא עוברת שרשרת אישורים: מנהל, כספים, סמנכ״ל. בדרך יש התראות במייל, יומן פעולות ותפקידים שונים. שכבת ה-AI מסווגת בקשות ומסמנת חריגות.

## Why

Big organizations keep running into the same problems: processes, permissions, approvals and knowledge spread across people and tools. This project tackles them one layer at a time.

## Build plan

1. **Google Auth and organizations.** Sign in with Google. Every company is a separate Workspace.
2. **Email.** Invite users, and notify people when a request needs their approval or changes status.
3. **Permissions.** Roles (Admin, Manager, Employee) and an audit log of every action.
4. **AI.** Classify requests automatically and flag anomalies (unusual amount, new vendor).

## Status

Just started. Nothing is built yet.
