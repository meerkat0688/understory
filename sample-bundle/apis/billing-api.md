---
type: API Endpoint
title: Billing API
description: REST endpoint that creates and lists customer charges.
resource: https://api.acme.internal/v2/billing
tags:
  - billing
  - rest
timestamp: "2026-07-09T00:00:00.000Z"
---

Monthly charges are created by the scheduler; ad-hoc charges come from support tooling.
Charges reference customers in the [Customers table](/tables/customers.md).

# Schema

* `POST /v2/billing/charges` — create a charge `{ customer_id, amount_cents, currency }`
* `GET /v2/billing/charges?customer_id=` — list charges for a customer

# Citations

[1] [Internal billing runbook](https://wiki.acme.internal/billing/runbook)
