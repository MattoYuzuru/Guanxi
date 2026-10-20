# Owner decisions — 2026-10-20

**Status:** accepted · **Date:** 2026-10-20 · **Decisions:** D-123–D-126
**Extends:** [2026-10-19 addendum](2026-10-19-owner-decisions-addendum.md).

The owner asked for a notification center that warns before API balances or subscription
usage windows run out and lets them act from the notification, and decided what to do with
the chosen logo.

| ID | Topic | Decision |
| --- | --- | --- |
| D-123 | Quota alert thresholds | Default alerts at 20%, 10% and 5% remaining for every usage window (5-hour, weekly, daily, monthly) and balance, each once per window instance, plus a forecast alert when the burn rate exhausts the quota before the reset or before dependent runs finish. Configurable per connection. See [ADR-0033](0033-notification-center-and-quota-alerts.md). |
| D-124 | Automatic reactions | Guanxi reacts on its own (switch a role to a fallback connection, pause background runs) only when the run's policy names that reaction; otherwise it recommends an action in the notification. |
| D-125 | Delivery channels | In-app notification center, operating-system notifications and phone push. Other channels (Telegram, email) are not planned now; they can come later as plugins. |
| D-126 | Logo | The chosen logo, concept 05 (`guanxi-gx-v1`), lives in `assets/brand/guanxi-gx-v1/` with its reproducible build scripts; stage U1 wires it into the design system. |
