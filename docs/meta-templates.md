# Meta WhatsApp Message Templates

Templates required for any business-initiated WhatsApp message outside the 24-hour
customer service window — debt reminders to a trader's customer, and scheduled pushes
to the trader (Sunday profit note, Monday debt digest, low-stock alerts). Submit and
maintain these in Meta Business Manager → Account Tools → Message Templates. The exact
names below must match `services/whatsapp.js` (`sendTemplateMessage` callers) — if a
name changes during Meta review, update both places together.

All four: **Category UTILITY**, **Language `en`**, **Footer:** `Automated message via BizPulse`,
no buttons.

## `debt_payment_reminder`
Sent to a **trader's customer** (not the trader) — carries opt-out language per Meta policy.

> Hi {{1}}, this is {{2}} (sent via BizPulse). Our records show ₦{{3}} outstanding from {{4}}.
> If you've already paid, please ignore this message. Reply DISPUTE if this isn't correct,
> or STOP to opt out of reminders.

Variables: {{1}} customer first name · {{2}} shop name · {{3}} amount (formatted, e.g. `5,000`)
· {{4}} date label (e.g. `12 Jun`)

## `weekly_profit_summary`
Sunday evening, to the trader.

> Hi {{1}}, your week at {{2}}: revenue ₦{{3}}, profit ₦{{4}} ({{5}}% margin). {{6}}

Variables: {{1}} trader first name · {{2}} shop name · {{3}} revenue · {{4}} profit
· {{5}} margin percent · {{6}} short contextual line (top product, or the honest-degradation
notice when cost data is missing for >30% of items sold)

## `weekly_debt_digest`
Monday morning, to the trader.

> Hi {{1}}, your debt book for {{2}}: {{3}} customers owe a total of ₦{{4}}.
> Reply REMIND ALL to send reminders, or ask me who owes what.

Variables: {{1}} trader first name · {{2}} shop name · {{3}} customer count · {{4}} total owed

## `low_stock_alert`
Event-driven, to the trader.

> Hi {{1}}, {{2}} is running low — about {{3}} {{4}} left, selling fast.
> Restock before {{5}} to avoid running out.

Variables: {{1}} trader first name · {{2}} product name · {{3}} quantity · {{4}} unit
· {{5}} restock-by label (e.g. `Saturday`)
