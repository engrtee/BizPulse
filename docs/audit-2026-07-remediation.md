# 2026-07 Market-Fit Audit — Remediation Tracker

Working branch: `feature/market-fit-2026-07`.

This file is the durable record of the audit's numbered fix items (`A1-x` / `A2-x`), so a new
session can pick up the next item without guessing. **Every commit that closes an item should be
tagged `(A#-#)` in its subject line and logged in the table below with its commit hash.**

Track A1 and A2 appear to be two parallel groupings from the original audit (exact split unknown —
see "Unconfirmed numbering" below). If you have the source audit doc/spreadsheet this was generated
from, paste the missing item descriptions in here and delete the "inferred" caveat.

## Completed

| ID | Description | Commit |
|---|---|---|
| A2-4 | Fix image webhook idempotency | `4092c2e` |
| A1-4 | Standardize date-boundary queries on Africa/Lagos | `fd1d075` |
| A2-10 | Remove dormant Google Sheets/OAuth code | `0197ad1` |
| A1-7 | Add margin_basis column to distinguish margin's meaning per row | `3c92c5b` |
| A1-1 | Wire streak advancement into Kemi's write tools | `cae9908` |
| A1-2 | Add streak_14/streak_60 milestones to Kemi, document milestone wiring | `b2009e2` |

## Unconfirmed numbering — gaps in the sequence

These IDs are referenced by the pattern (A1-3, A1-5, A1-6, A2-1, A2-2, A2-3, A2-5 through A2-9) but
their descriptions aren't recoverable from this repo — no plan file, PR, or task list exists for
them. **Tosin: fill these in from your original source, or say "skip/renumber" and I'll drop the ID
scheme and just work the backlog below in priority order.**

- [ ] A1-3 — ?
- [ ] A1-5 — ?
- [ ] A1-6 — ?
- [ ] A2-1 — ?
- [ ] A2-2 — ?
- [ ] A2-3 — ?
- [ ] A2-5 — ?
- [ ] A2-6 — ?
- [ ] A2-7 — ?
- [ ] A2-8 — ?
- [ ] A2-9 — ?

## Inferred backlog (candidates, not yet assigned an ID)

Derived from "Known gap" / "In active build" notes in `CLAUDE.md` as of this file's creation. Not
confirmed to be part of the original numbered audit — could overlap with the gaps above.

- [ ] Low-stock alert parity — `checkAndSendLowStockAlert` only fires on the legacy path; Kemi's
      `log_sale` should trigger the equivalent before any inventory-dependent push feature ships.
- [ ] Debt book consolidation — merge legacy `debts` into canonical `debtors`; fix
      `DebtorModel.markPaid()` to use an append-only ledger instead of UPDATE-in-place.
- [ ] Confirm-before-commit for Kemi's write tools — needed for photo-in extraction to route a draft
      through `pending_entries` and wait for YES, per CLAUDE.md's Kemi section ("Batch 4").
- [ ] Shared per-user weekly send-volume budget across the four cron jobs (`dailySummary.js`,
      `morningCoaching.js`, `digest.js`, `retentionNudge.js`) — currently uncoordinated.
- [ ] Fix 6 tenant-isolation fragility — `TransactionModel.correct()`, `DebtorModel.markPaid()`,
      `ProductModel.getById()`/`applyStockChange()` accept a bare row id with no tenant check in their
      own `WHERE` clause; harden or document the guard so a future caller can't skip it.
- [ ] Remove dead code — `GeminiService.parseWithAI` (no live callers) and the legacy rule-based
      pipeline (`ParserService`, `handleConfirmedEntry`, `handleOversellYes/No`,
      `handleOnDemandSummary`, `buildCalcReply` in `routes/webhook.js`) once nothing still needs it.
- [ ] Receipt generator (Phase 1, 2026-07 market-fit scope per CLAUDE.md).
- [ ] Scheduled pushed insights — profit/debt/stock (Phase 1, 2026-07 market-fit scope per CLAUDE.md).
- [ ] Photo-in with confirmation (Phase 1, 2026-07 market-fit scope per CLAUDE.md — overlaps with the
      confirm-before-commit item above).

## How to use this file

1. Before starting work, check "Unconfirmed numbering" and "Inferred backlog" above and agree the
   next item with Tosin if it's not obvious.
2. Commit with `(A#-#)` in the subject when an ID applies; otherwise use a plain descriptive subject.
3. Move the item from its checklist into the **Completed** table with the commit hash, same session.
4. If a whole item turns out to already be done (like A1-2 partially was), say so in the commit body
   and note it here rather than re-doing the work.
