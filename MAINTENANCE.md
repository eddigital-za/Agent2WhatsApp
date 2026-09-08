# BTSA Maintenance Agent

Independent monitor for BTSA Make and Railway agents. It records evidence, classifies failures, suppresses alert storms, and invokes recovery only when a recovery hook is explicitly configured and the failure is classified as transient.

## Safety policy

- Duplicate-name, validation, mapping, undefined-field and malformed-JSON failures are never auto-fixed.
- Authentication and WhatsApp QR failures are never auto-fixed.
- Unknown failures are never auto-fixed.
- A transient recovery requires both a transient classification and an explicit `recoveryUrl` for that target.
- Recovery attempts are rate-limited, logged and followed by normal health verification.

## Endpoints

- `GET /health` — public, minimal service health.
- `GET /status` — protected by `Authorization: Bearer $ADMIN_TOKEN`.
- `POST /events` — protected by `X-Maintenance-Secret: $EVENT_SECRET`; accepts Make heartbeats and evidence events.
- `POST /check` — protected manual health-check trigger.

## Configuration

- `MONITORS_JSON`: JSON array of `{id,name,url,expectWhatsappReady,maxLatencyMs?,recoveryUrl?}`.
- `ADMIN_TOKEN`: protects detailed status and manual checks.
- `EVENT_SECRET`: authenticates Make heartbeats.
- `CHECK_INTERVAL_MS`: default `300000`.
- `FAILURE_THRESHOLD`: default `2` consecutive failures.
- `MAKE_HEARTBEAT_MAX_AGE_MS`: default `900000`.
- `STATE_FILE`: optional persistent state file.
- `ALERT_WEBHOOK_URL`: optional alert destination.
- `WHATSAPP_BRIDGE_URL` and `ALERT_CHAT_ID`: direct WhatsApp alert route once the alerts group ID exists.
- `RECOVERY_TOKEN`: optional bearer token used only with explicitly configured recovery hooks.
Deployment source: `maintenance-agent` branch.
