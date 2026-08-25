# Customer data deletion and retention

PayFlow allows merchants to request deletion of a customer’s personal data. This document explains which data a deletion request must remove, which financial records it must retain, and when the request can be marked complete.

## Customer data and financial records

A deletion request removes a customer’s personal data from every PayFlow-controlled system that actively stores, processes, or exposes it.

PayFlow must retain financial facts needed for payment history, refunds, reconciliation, and accounting. Retained records must remain financially correct, but must no longer identify the deleted customer.

Do not alter data belonging to other customers or merchants. Shared records must remain usable for the people who still need them.

## When deletion is complete

A deletion request can be marked `completed` only after the customer’s personal data is gone from PayFlow’s active systems and normal processing cannot add it back.

Delayed work, retries, provider callbacks, duplicate delivery, restarts, and replayed events must not restore deleted personal data.

## Retained deletion information

PayFlow may retain the minimum information needed to track the request and prevent old work from recreating the customer’s data. The customer’s original identity must not remain in ordinary application records after deletion.

## Safety and recovery

Each request belongs to its authenticated merchant. Data deletion must not expose or affect another merchant’s data.

The workflow must safely resume after a failure or restart. Repeating a request must converge on the same result without duplicating destructive work.
