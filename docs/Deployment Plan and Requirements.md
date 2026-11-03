# Deployment Plan and Requirements

Oct 20, 2026 · @Calowe

The app can demo on sandbox payments today; a public launch waits on Safaricom approval, Google Play's testing period and a data-protection check, so those start first.

## Release stages and gates

The project moves through three stages, and each stage has a gate that must be met before the next begins.

| Stage | Who uses it | Payments | Gate to pass |
| --- | --- | --- | --- |
| 1. Demo | Lecturer and classmates | Daraja sandbox only | All unit, rules and concurrency tests green; the full concert flow (browse, hold, pay, wallet, offline scan) runs end to end on the emulators |
| 2. Pilot | A small closed group of testers and one or two friendly vendors | Sandbox, then real money in small amounts once Safaricom approves | Staging load test passed; payment chaos tests green; privacy notice published; kill switch and rollback rehearsed |
| 3. Public | Anyone on the Play Store (and iOS if built) | Live M-Pesa | Production credentials issued; store approval; data-protection obligations confirmed; monitoring and alerts live |

A failed gate stops the release; it is never waived by the date.

## Deployment requirements

Every requirement names the evidence that proves it is met, so a reviewer can check it instead of trusting a claim.

| ID | Area | Requirement | Evidence |
| --- | --- | --- | --- |
| DR-01 | Environments | Three separate Firebase projects (dev, staging, production), each mapped to a Flutter flavor; nothing in dev can touch production data | Three project ids in the repo config; a flavor launches against its own project only |
| DR-02 | Secrets | Daraja keys, passkey and the QR signing key live in Secret Manager; none in the repo, the app bundle or logs | Repository secret scan passes; a decompiled build contains no key |
| DR-03 | Secrets | A leaked secret is rotated, never just deleted from the code | Written rotation steps, tried once on staging |
| DR-04 | Payments | The Daraja callback URL is public HTTPS and carries a secret path token; the handler matches the CheckoutRequestID, amount and user to a pending payment before acting | Callback tests: unknown id, wrong amount, replayed callback are all rejected |
| DR-05 | Payments | A scheduled reconciliation function queries Daraja for every order stuck in AWAITING\_PAYMENT and moves it to its true state | Test with a callback that never arrives |
| DR-06 | Payments | Late payments (PAID\_LATE) are refunded or re-ticketed, never ignored | Order machine test and a staging walkthrough |
| DR-07 | Security | App Check enforced on every callable function; client writes to stock, holds, orders, payments and tickets are denied by rules | Rules test suite in CI |
| DR-08 | Security | Tenant isolation: one vendor cannot read another vendor's events, orders or attendees | Rules tests for each tenant boundary |
| DR-09 | Quality gate | CI blocks a merge unless analyze, unit, bloc, rules and function tests pass | Required status checks on the main branch |
| DR-10 | Quality gate | The concurrency test (1,000 buyers, 100 tickets) and the payment chaos suite run on every release candidate | Test report attached to the release |
| DR-11 | Quality gate | A load test (k6) runs against staging before every pilot or public release, because the emulator does not reproduce real contention | Saved k6 results compared with the last run |
| DR-12 | Operations | A budget alert exists on the Blaze plan before the first function is deployed | Alert visible in the billing console |
| DR-13 | Operations | Crash reporting and alerts on function errors, failed callbacks and stuck orders | An alert fires in a staged failure drill |
| DR-14 | Operations | Scheduled Firestore backups and a tested restore into a scratch project | A restore completed and checked |
| DR-15 | Operations | Each mini app can be switched off remotely with Remote Config, without an app update | Kill switch exercised on staging |
| DR-16 | Release | Staged rollout on the store, starting with a small share of users | Rollout percentage recorded per release |
| DR-17 | Data protection | Firestore region chosen and justified in writing before the first production write, because it cannot be changed later | Decision recorded in the design document |
| DR-18 | Data protection | Privacy notice published; each event collects only the fields it declares; sensitive fields are restricted and deleted after the event | Notice live; field-level rules and a deletion job tested |
| DR-19 | Accessibility | Core booking flow usable with large text and a screen reader | Manual check on one low-end Android phone |

## Lean canvas

&#91;embedded content: lean canvas · 9 boxes and how the parts connect\]

Read the nine boxes as a hypothesis; the band at the foot shows the one layer where the promise is enforced and how every other part reaches it.

## How the components integrate

Every connection has one contract, one way of proving who is calling, and one defined behaviour when it fails.

| # | From | To | Contract | Who is trusted | If it fails |
| --- | --- | --- | --- | --- | --- |
| 1 | Mini apps and the events engine | Host shell | Host SDK interfaces (auth, payments, wallet); capabilities declared up front | Compile-time packages; undeclared services throw | The mini app shows its own error state; the host keeps working |
| 2 | Host shell | Cloud Functions | Callable functions with typed requests | Firebase Auth user plus App Check | App shows a retry; no write happened if the call did not return |
| 3 | App | Firestore | Read-only listeners (order status, wallet, events) | Security rules per user and per tenant | The wallet and tickets still show from the offline cache |
| 4 | Cloud Functions | Firestore | Admin SDK transactions: holds, orders, payments, tickets | Server identity | A transaction that keeps colliding aborts and writes nothing; the caller retries |
| 5 | payments-initiate | M-Pesa Daraja | OAuth token, then STK Push with the order reference | Daraja credentials from Secret Manager | Order stays AWAITING\_PAYMENT; reconciliation settles it |
| 6 | M-Pesa Daraja | payments-callback | Public HTTPS callback keyed by CheckoutRequestID | Secret path token, plus a match to a pending payment | Duplicate or late callbacks change nothing; PAID\_LATE handles late money |
| 7 | Cloud Tasks | holds-expire | One task per hold, scheduled for its expiry time | Authenticated task identity | Task retries; expiry only acts on an ACTIVE hold |
| 8 | Firestore change | Fan-out function | Trigger when an occurrence changes | Server identity | Safe to re-run: it sets the new value again |
| 9 | Cloud Functions | FCM | Push to ticket holders and guests | Server identity | Missed push does not change data; the wallet is still correct |
| 10 | Remote Config | App | Flag per mini app id | Firebase project config | If unreachable, the last fetched flags (or safe defaults) apply |
| 11 | Gate device | Firestore | Downloads the valid-ticket list; uploads scans later | Gate staff role claim | Offline scans queue locally; first scan wins when synced |

Two rules sit behind the table. The app never writes money, stock or tickets. And function codebases never import each other: they communicate through Firestore documents and events, for example payments announcing that a payment succeeded.

## External approvals and lead times

Safaricom and Google Play can run in parallel, and the slower one sets the earliest public date; neither starts until its groundwork exists.

| Approval | What it needs | Typical wait | Source |
| --- | --- | --- | --- |
| Safaricom Daraja production | A registered Kenyan business with a KRA PIN, an active paybill or till, public HTTPS callback URLs and a go-live application; individuals get sandbox only | 2 to 10 business days for review, after the paperwork and till already exist | [McTaba Labs go-live checklist](https://mctaba.com/learn/mpesa/daraja-production-checklist) |
| Google Play production access | A personal account created after 13 November 2023 needs a closed test with 12 opted-in testers for 14 continuous days; an organisation account is exempt; also a signed .aab, a privacy policy URL and the data safety form | About three weeks in total | [Testers Community guide](https://www.testerscommunity.com/blog/google-play-closed-testing-requirements-2026); verify on [Google's help page](https://support.google.com/googleplay/android-developer/answer/14151465) |
| Apple App Store | A paid annual developer membership and app review | Not researched here | Check Apple's developer site |
| Data protection | Whether the platform must register with the Office of the Data Protection Commissioner, and what the privacy notice must say | Not researched here | Confirm with the regulator and a legal adviser |

Both sources are third-party guides, and the Play one is written by a company that sells testers, so treat the figures as a plan and confirm each on the official portal before relying on it.

### Requirements these guides add

| ID | Requirement | Evidence |
| --- | --- | --- |
| DR-20 | The callback handler replies HTTP 200 at once and processes afterwards; the raw callback payload is stored before any processing | Callback test checks the stored payload and the response time |
| DR-21 | A startup check refuses to run in production mode with a sandbox URL or sandbox shortcode | Unit test of the configuration loader |
| DR-22 | First live payments are staged: KES 1 to yourself, then 2 to 3 testers, then a match against the M-Pesa statement; rollout is gradual | Signed checklist for the release |
| DR-23 | After launch, a daily reconciliation compares our records with the M-Pesa statement | A daily report from the reconciliation job |

## Rollout, rollback and incident playbook

A release starts with a small share of users and can be undone at three levels: a mini app flag, a function version and an app version.

| Situation | How you notice | First response | Recovery |
| --- | --- | --- | --- |
| A mini app misbehaves | Crash reports, user complaints, error alert | Switch it off with its Remote Config flag | Fix, test on staging, switch back on |
| A bad function release | Error-rate alert, failing smoke checks | Redeploy the previous tagged version of that function codebase | Add a test that reproduces the fault before re-releasing |
| A bad app release | Crash-free rate drops in the staged rollout | Halt the rollout; ship the fix as a new build | Keep the rollout share small until stable |
| M-Pesa is down or slow | STK Push failures, no callbacks | Show "payments are delayed" instead of retry buttons; keep holds from expiring unfairly | Reconciliation settles every AWAITING\_PAYMENT order afterwards |
| Callbacks stop arriving | Stuck-order alert | Run reconciliation now; check the callback URL and its certificate | Settle each order from the true Daraja status |
| Stock counters disagree with holds | Nightly invariant check fails | Pause new holds for that product | Repair function recomputes counters from the holds |
| A secret is leaked | Secret scan, report | Rotate it at once in Secret Manager | Review access logs; record the incident |
| An event is cancelled by its vendor | Vendor action | Orders move to REFUND\_PENDING; holders are notified | Admin processes refunds until the refund API is approved |

Schema changes are additive: new fields are added and old ones are removed only after every app version that reads them is gone, because phones stay on old builds for weeks.

## Open decisions before launch

- [ ] **Whose till collects the money.** If the platform's till collects and pays vendors later, we hold other people's money. One go-live guide says an integration must run under the business that owns the till and cites Central Bank rules; if that holds, each vendor needs their own till. Confirm with Safaricom and a legal adviser, then record the choice and its trade-offs in the design document.
- [ ] **Play account type.** A personal account needs the 12-tester, 14-day closed test; an organisation account avoids it but needs business verification. Decide which route before creating the account.
- [ ] **Firestore region.** Choose and justify it under the KDPA's cross-border transfer rules before the first production write.
- [ ] **Data protection registration.** Confirm whether the platform must register with the Office of the Data Protection Commissioner, and who is controller and who is processor for attendee data.
- [ ] **Refunds.** Apply for M-Pesa refund access, and run refunds by hand through an admin until it is approved.
- [ ] **Revenue model.** Per-ticket fee, subscription for restaurant and conference tools, or both; this is an assumption to test with real vendors.
- [ ] **iOS.** Decide whether the first public release is Android only.
