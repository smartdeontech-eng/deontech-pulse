# WhatsApp message templates — drafts to submit to Meta

WhatsApp Business only lets a business start a conversation with an
**approved template**. Submit these in **WhatsApp Manager → Message
templates → Create template**, category **Utility** (they are alerts about
your own account/service), language **English (UK)**. Until they are
approved, urgent alerts go by SMS — nothing is waiting on this.

Variables are `{{1}}`, `{{2}}`… Meta asks for a sample value for each; use the
samples given. Keep the wording as is: approval is quicker when a template is
plainly transactional and has no marketing language.

---

## 1. `pulse_urgent_alert`

**Body**

> DeonTech Pulse — urgent: {{1}}
> When: {{2}}
> Open Pulse to see what happened and respond.

Samples: `{{1}}` = `pman is down`, `{{2}}` = `04:57 Accra · 00:57 Toronto`

**Button** — *Visit website*, dynamic URL:
`https://monitor.smartdeontech.com/#/alerts/{{1}}` — sample `42`

---

## 2. `pulse_login_check`

**Body**

> DeonTech Pulse: {{1}} signed in to the server from {{2}} at {{3}}. Was this you?

Samples: `{{1}}` = `deploy`, `{{2}}` = `102.176.65.20 (GH)`, `{{3}}` = `03:59 Accra`

**Buttons** — *Quick reply*: `Yes, it was me` · `No, not me`

(Pulse will read the reply through the WhatsApp webhook and treat it exactly
like the Yes/No on a push notification. "No" escalates to urgent.)

---

## 3. `pulse_resolved`

**Body**

> DeonTech Pulse — resolved: {{1}}
> At: {{2}}

Samples: `{{1}}` = `pman is down`, `{{2}}` = `05:12 Accra · 01:12 Toronto`

---

## What Pulse needs once they are approved

Typed on the server with `sudo bash /opt/pulse/scripts/set-secret.sh KEY`:

| Key | From |
|---|---|
| `WHATSAPP_TOKEN` | a permanent System User access token (WhatsApp Manager → System users) |
| `WHATSAPP_PHONE_ID` | the sending number's *Phone number ID* |
| `WHATSAPP_TO` | your WhatsApp number, international format, e.g. `233244000000` |
| `WHATSAPP_VERIFY_TOKEN` | any long random string; also entered in the webhook settings |

The webhook URL for replies will be
`https://monitor.smartdeontech.com/api/hooks/whatsapp`. The sending code is a
phase 3 task; the channel is already switchable on the Settings page.
