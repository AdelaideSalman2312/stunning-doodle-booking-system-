# Event Booking Super App — System Design Document

Oct 11, 2026 · @Calowe

## 1. Purpose, scope and methodology

This document specifies a Flutter mobile super app where vendors list ticketed events and attendees book and pay for them with M-Pesa. Two mini apps, restaurant booking and professional (conference) booking, run inside the same host. The backend is restricted to Firebase.

**In scope:** ten event types, two mini apps, M-Pesa payments, a ticket wallet, offline gate check-in, vendor and restaurant tenancy, and Kenya Data Protection Act (KDPA) obligations.

**Out of scope:** betting at race meetings (licensed by the BCLB), resale marketplaces, web clients and native M-Pesa refunds in the first release (handled manually by an admin until the refund API is approved).

### Methodology

The design was produced before any code, using five techniques in this order:

1. **Domain abstraction.** Find the lifecycle all event types share, then isolate what varies. The result is one booking engine with pluggable inventory strategies, not one code path per event type.
2. **Classification test for mini apps.** An event type is a configuration of the core engine. A mini app is a different domain that reuses host services. Restaurants (renewable inventory) and conferences (business buyers, invoices) pass that test; comedy shows do not.
3. **Access-pattern-driven data modelling.** Firestore has no joins, so collections are derived from the questions each screen and function asks, not from a normalised schema.
4. **State machines for every lifecycle that involves money or stock.** Each transition is named, has one trigger and one function that performs it.
5. **Failure-first review.** Each flow was walked through its failure cases: races, duplicate callbacks, late payments, crashes mid-write, offline devices. Section 8 catalogues the results.

Each decision in this document records the alternative considered and why it was rejected (Section 7).

## 2. System requirements

The system must never sell more than capacity, never issue tickets twice for one payment, and must keep working at the gate without a network.

### Actors

| Actor | Main goals |
| --- | --- |
| Attendee | Discover events, book, pay with M-Pesa, hold tickets offline |
| Event vendor | Create events, set pricing and capacity, see sales, receive payouts |
| Restaurant (owner, host staff) | Configure tables and policies, manage daily reservations |
| Organisation admin | Buy conference seats in bulk, assign staff, pay by invoice |
| Gate staff | Scan tickets, including offline |
| Platform admin | Approve tenants, handle disputes, refunds and overrides |

### Functional requirements

| ID | Requirement |
| --- | --- |
| FR-01 | Support ten event types: concerts, cookouts, football, polo, race course viewing, movies, fun fairs, comedy shows, multi-day festivals, marathons/fun runs |
| FR-02 | Each event uses one inventory strategy: general admission, reserved seating, table seating, RSVP or timed entry |
| FR-03 | Sell products of four kinds: ticket, package (e.g. polo table for 8), add-on (e.g. ride credits), pass (spans several occurrences) |
| FR-04 | Enforce eligibility rules per event (minimum age, ID required) |
| FR-05 | Reserve stock with a time-limited hold before payment |
| FR-06 | Take payment through M-Pesa STK Push initiated by the backend |
| FR-07 | Issue a cryptographically signed QR ticket per admitted person |
| FR-08 | Show tickets and reservations offline in one wallet |
| FR-09 | Verify tickets offline at the gate and sync scans later |
| FR-10 | Vendors create drafts; publishing goes through server validation |
| FR-11 | Notify ticket holders when an occurrence changes or is cancelled |
| FR-12 | Restaurant mini app: book time slots on single or combined tables, deposits, group requests with quotes |
| FR-13 | Conference mini app: organisations, bulk seats with deferred assignment, invoice payment, custom registration forms, workshop sessions |
| FR-14 | Platform admin can enable or disable each mini app remotely |
| FR-15 | Waitlist when an event is sold out or temporarily held out |

### Non-functional requirements

| ID | Quality | Requirement |
| --- | --- | --- |
| NFR-01 | Correctness | For every product, sold + held never exceeds capacity |
| NFR-02 | Correctness | Each payment results in tickets at most once |
| NFR-03 | Scalability | Survive a flash sale of thousands of concurrent buyers on one event |
| NFR-04 | Availability | Ticket wallet and gate verification work with no network |
| NFR-05 | Security | Clients never write money, stock or ticket documents; secrets never ship in the app |
| NFR-06 | Privacy | Collect only fields each event type needs; sensitive fields restricted and deleted after the event |
| NFR-07 | Isolation | A tenant can never read another tenant's data |
| NFR-08 | Operability | Separate dev, staging and production Firebase projects; budget alerts on the Blaze plan |
| NFR-09 | Maintainability | Mini apps depend only on the host SDK; a new event type needs configuration, not a rewrite |
| NFR-10 | Testability | Every rule above is backed by an automated test (Section 10) |

## 3. Architecture

One Flutter codebase hosts the events engine and two mini apps; all three reach shared services only through the host SDK, and only Cloud Functions write money, stock or tickets.

&#91;embedded content: system architecture · app, Firebase backend, M-Pesa\]

Read top to bottom: modules call the host, the host calls Firebase, and only Cloud Functions talk to M-Pesa, so no secret ever ships in the app.

### Flutter structure

A Melos monorepo with Clean Architecture inside each feature (presentation → domain → data):

```
packages/
  host_sdk/          interfaces only; mini apps depend on this
  events_core/       the events engine for all ten event types
  mini_restaurants/  mini app
  mini_conferences/  mini app
  design_system/     shared UI
apps/
  super_app/         implements host_sdk with Firebase; launches everything
```

State management uses flutter\_bloc, because booking flows are state machines and bloc\_test makes them testable. Navigation uses go\_router, with each mini app mounted under its own route prefix for deep links. The wallet relies on Firestore offline persistence; the gate scan queue uses drift (SQLite). Flavors map to separate dev, staging and production Firebase projects.

### Host SDK contract

| Service | What a mini app gets | Deliberately excluded |
| --- | --- | --- |
| AuthService | Current user id and display name; user changes stream | Phone number, email |
| PaymentService | `pay(PaymentRequest)` and `watch(referenceId)`, both streams of a sealed PaymentStatus | Any direct call to Daraja |
| WalletService | `upsert` and `remove` its own WalletItems | Reading other modules' items |
| Capabilities | Only services declared in `requiredCapabilities` | Undeclared services throw CapabilityNotGranted |
| Notifications | None on the client | Pushes are sent by backend functions through FCM |

Money is an integer in the smallest unit wrapped in a Money type; PaymentStatus has Pending, Confirming, Succeeded and Failed (with canRetry).

### Backend modules

| Function codebase | Owns collections | Key functions |
| --- | --- | --- |
| payments | payments | payments-initiate, payments-callback, reconciliation |
| events | events, occurrences, products, shards, seats, holds, orders, tickets | events-publish, holds-create, holds-expire, orders-create, tickets-issue, occurrence fan-out |
| restaurants | restaurants, tables, days, combinations, reservations | reservations-create, reservations-release, quotes |
| conferences | conferences, passTypes, sessions, organizations, bulkOrders, registrations | bulk-order, seat assignment, deadline policy |

## 4. Data flow diagrams

All data enters and leaves through one system boundary, and inside it every write to stock, orders, payments and tickets is made by a Cloud Function.

&#91;embedded content: DFD level 0 · context diagram\]

At level 0 the system is a single process; M-Pesa is the only external system; every other outside party is a person in one of five roles.

&#91;embedded content: DFD level 1 · ticket booking and payment\]

At level 1 the booking runs top to bottom; process 3 is highlighted because it must be idempotent. The gate reads the ticket list before doors open and logs scans for later sync.

### Process and store matrix

The diagram shows the main flows; this matrix lists every read (R), create (C) and update (U), including hold expiry, which runs from Cloud Tasks.

| Process | D1 Shards, holds | D2 Orders | D3 Payments | D4 Tickets | D5 Gate scans |
| --- | --- | --- | --- | --- | --- |
| 1 Create hold | R, U shards; C hold |  |  |  |  |
| 2 Start payment | R hold | C | C |  |  |
| 3 Handle callback |  | U | U |  |  |
| 4 Issue tickets | U hold (converted) | R |  | C |  |
| 5 Verify at gate |  |  |  | R, U (used) | C |
| 6 Expire hold | U shards, U hold | U (expired) |  |  |  |
| 7 Occurrence fan-out |  |  |  | U (display data) |  |

## 5. Entity-relationship model and Firestore collections

The core engine has eleven entities; the logical model below maps onto Firestore collections chosen from the access patterns, with display data copied where reads must be cheap or offline.

&#91;embedded content: E-R model · core events engine, 11 entities\]

Products link to occurrences many-to-many through an `occurrenceIds` list, which is how one festival pass covers three days. A seat is claimed by at most one valid ticket at a time.

### Core collections

| Collection path | Key fields | Written by | Why it lives here |
| --- | --- | --- | --- |
| `tenants/{tenantId}` | type (event\_vendor, restaurant), status, payoutTill | Admin function | Tenant identity and approval |
| `events/{eventId}` | tenantId, title, category, inventoryStrategy, status, city, venueName, nextOccurrenceAt, minPrice, eligibility, attendeeFields | Vendor (drafts), publish function | Browsing (A1) and vendor list (V1) read one document |
| `events/{e}/occurrences/{o}` | startsAt, endsAt, status, venueName, location, displayAvailability | Vendor (drafts), functions | Only read within its event |
| `events/{e}/products/{p}` | type, name, price, capacity, occurrenceIds, admitsZones, unitsPerPurchase | Vendor (drafts) | Passes span occurrences, so products sit under the event |
| `events/{e}/products/{p}/shards/{n}` | remaining, sold, held | Functions only | Authoritative stock; clients cannot read or write |
| `events/{e}/occurrences/{o}/seats/{s}` | section, row, number, productId, status, holdId | Functions only | Seat maps load one section at a time |
| `holds/{holdId}` | userId, items, expiresAt, status | Functions only | Queried by user and by expiry |
| `orders/{orderId}` | userId, tenantId, holdId, items, total, status, history | Functions only | Queried across events by user |
| `payments/{checkoutRequestId}` | purpose, sourceModule, referenceId, userId, amount, status | Functions only | Document ID gives idempotency |
| `tickets/{ticketId}` | userId, orderId, eventId, occurrenceId, groupId, display, qrPayload, status, attendee | Functions only | Wallet query by userId, gate query by occurrenceId |

### Restaurant mini app collections

| Collection path | Key fields |
| --- | --- |
| `restaurants/{tenantId}` | opening hours, slot length, dining duration by party size, cleaning buffer, deposit and cancellation policy |
| `restaurants/{t}/tables/{tableId}` | name, minParty, maxParty, area |
| `restaurants/{t}/combinations/{id}` | tableIds, maxParty |
| `restaurants/{t}/tables/{tableId}/days/{date}` | slots map (time → reservationId or empty); created on first booking |
| `reservations/{id}` | userId, tenantId, tableIds, date, slots, partySize, status, policySnapshot |
| `groupRequests/{id}` | partySize, date, preferredTime, status, quote |

### Conference mini app collections

| Collection path | Key fields |
| --- | --- |
| `organizations/{orgId}` | name, kraPin, billingEmail, adminUids |
| `conferences/{confId}` | tenantId, title, dates, venue, formSchema (each field with a purpose and sensitivity flag), policies |
| `conferences/{c}/passTypes/{id}` (+ `shards`) | name, price, capacity |
| `conferences/{c}/sessions/{id}` | title, track, startsAt, endsAt, capacity |
| `bulkOrders/{id}` | orgId, confId, passId, seats, assigned, paymentMethod, status, policySnapshot |
| `registrations/{id}` | confId, bulkOrderId, attendee, formAnswers, sessionIds, ticketId, status |

Rule of thumb: nest a collection when it is only read within its parent; make it top-level when it is queried across parents.

## 6. State machines

Five lifecycles carry money or stock, and each is an explicit state machine: holds track stock, orders and payments track money, and the two mini apps have their own booking machines.

&#91;embedded content: order state machine · 9 states, 13 transitions\]

The happy path runs along the top row. Every other path ends in FULFILLED or REFUNDED, so no customer's money is left unaccounted for.

### Order transitions

| From | To | Trigger | Performed by |
| --- | --- | --- | --- |
| — | CREATED | User checks out an active hold | orders-create |
| CREATED | FULFILLED | Order total is 0 (free RSVP) | orders-create |
| CREATED | AWAITING\_PAYMENT | STK Push sent | payments-initiate |
| AWAITING\_PAYMENT | PAID | Success callback | payments-callback |
| AWAITING\_PAYMENT | PAYMENT\_FAILED | User cancelled the prompt, insufficient funds, timeout | payments-callback |
| PAYMENT\_FAILED | AWAITING\_PAYMENT | Retry while the hold is active, after checking the previous attempt's status | payments-initiate |
| CREATED, AWAITING\_PAYMENT, PAYMENT\_FAILED | EXPIRED | Hold timer fires (including before the STK Push was sent) | holds-expire |
| PAID | FULFILLED | Tickets issued; hold converted | tickets-issue |
| EXPIRED | PAID\_LATE | Success callback after expiry | payments-callback |
| PAID\_LATE | FULFILLED | Stock still available and re-acquired | tickets-issue |
| PAID\_LATE | REFUND\_PENDING | Stock gone | payments-callback |
| FULFILLED | REFUND\_PENDING | Event cancelled, or holder rejects a time change | refunds-request |
| REFUND\_PENDING | REFUNDED | Refund confirmed | refunds-callback (admin until the refund API is approved) |

An expired order is never reopened; the customer starts again with a new hold, because the released stock may already belong to someone else.

### How the machine is enforced

Every status change goes through one helper, `transitionOrder(orderId, expectedFrom, to)`, which runs in a Firestore transaction:

1. Read the order.
2. Reject if its status is not `expectedFrom` (someone else moved it).
3. Reject if `expectedFrom → to` is not in the allowed-transitions map.
4. Write the new status and append `{from, to, at, by}` to the order's history.

This closes check-then-act races, makes illegal paths impossible, and gives an audit trail for disputes.

### Supporting machines

&#91;embedded content: hold, payment, reservation and bulk order state machines\]

Each supporting machine reuses the same idea: claim first with an expiry, take money second, release automatically if the money never comes.

- **Hold:** CONVERTED when its order is paid; EXPIRED when the Cloud Task fires on an unpaid hold; RELEASED when the user cancels. Expiry and release return stock to the shards in the same transaction.
- **Payment:** a second successful payment for an already-paid order becomes DUPLICATE and is refunded (edge case E09).
- **Restaurant reservation:** bookings without a deposit start at CONFIRMED. Group requests run REQUESTED → QUOTED → (guest accepts) → PENDING\_DEPOSIT, or end in DECLINED or QUOTE\_EXPIRED; slots are claimed when the quote is sent.
- **Conference bulk order:** seats are assigned to named attendees after payment; at the assignment deadline a scheduled function applies the snapshotted policy to unassigned seats.

## 7. Key design decisions and trade-offs

Every decision below favours correctness of money and stock over simplicity, and simplicity over premature scale.

| # | Decision | Alternative rejected | Why | Cost accepted |
| --- | --- | --- | --- | --- |
| D1 | One events engine with inventory strategies | A code path per event type | New event types become configuration; comedy fits with no new code | Strategies must be general enough for all ten types |
| D2 | Restaurants and conferences are mini apps | Treat them as event types | Different domains: renewable inventory; business buyers and invoices | Two more modules to maintain |
| D3 | Mini apps as compile-time Flutter packages, enabled by Remote Config | Runtime-loaded web mini apps in a WebView | App stores forbid downloading new native code; we build both mini apps ourselves | A new mini app needs an app release |
| D4 | Firebase backend, modular by function codebase and collection ownership | Spring Boot modular monolith (preferred before the constraint) | Lecturer constraint | No SQL joins or row locks; hotspot limits shape the model |
| D5 | Clients never write money, stock or tickets | Client-side writes guarded by rules | Rules cannot express transactional business logic safely | Every such action is a Cloud Function call |
| D6 | Sharded stock with a configurable shard count | One counter document per product | A single document sustains about one write per second | Display availability is approximate |
| D7 | Displayed availability separate from authoritative stock | Live exact count on the event | Would recreate the hotspot | Buyers can see "3 left" and then hit sold out |
| D8 | Hold expiry by Cloud Tasks, checked again on read | Firestore TTL policies | TTL deletion can lag by hours and does not restore stock | Extra infrastructure per hold |
| D9 | Payment document ID = M-Pesa CheckoutRequestID | Auto-generated IDs | Duplicate callbacks land on one document: idempotency by design | IDs are not under our control |
| D10 | One transactional transitionOrder helper with an allowed-transitions map | Status writes scattered across functions | Blocks races and illegal transitions; gives an audit trail | All status changes funnel through one path |
| D11 | QR payload signs identifiers only (ticketId, occurrenceId) | Signing time, seat and name too | Changing a show time must not invalidate tickets | Gate needs the synced ticket list for display details |
| D12 | Denormalise display data onto events and tickets | Read related documents per screen | Offline wallet and one-query browsing | Fan-out updates when source data changes |
| D13 | A table bought for 8 = 1 unit of stock, 8 individual tickets | One group ticket admitting 8 | Single-use tickets keep offline duplicate detection simple | More documents |
| D14 | Restaurant inventory: one document per table per day, slot map inside | Pre-generated slot documents; overlap queries | Atomic multi-slot claims, no pre-generation, low contention | Availability search reads several day documents |
| D15 | Policies are data, snapshotted onto each booking | Hard-coded or live policies | Terms cannot change after the customer paid | Policy versions stored per booking |
| D16 | Host SDK exposes minimal identity (no phone or email) | Full user profile to every mini app | Data minimisation enforced by the type | Mini apps ask the user when they need more |

### Extensibility check: four events outside the original ten

None of these needed a new code path or mini app; two exposed small model changes, now reflected in Section 5.

| Event | Fits as | Strategy and products | What it changed in the model |
| --- | --- | --- | --- |
| Open-stage poetry | Event type, alongside comedy | Audience on general admission or table seating; a limited number of performer slots sold or offered as a product | Performer slots need organiser approval before confirmation: a participant product with a curation step |
| Painting session (paint and sip) | Event type | General admission capped by easels; materials and drinks as add-ons; a package for pairs | Nothing new |
| Art exhibition viewing | Event type | Timed entry slots sized to gallery capacity, often free; one occurrence per day across a run of weeks | Vendors generate occurrences from a recurring schedule instead of entering each date |
| Nairobi Design Week | Multi-day festival | One event; each day, talk and workshop is an occurrence; a week pass spans all occurrences; single-workshop tickets | Multi-venue: venue details move from the event to each occurrence |

## 8. Edge case catalogue

Twenty-one edge cases were identified; each has a defined handling and a test (Section 10).

### Stock and concurrency

| ID | Scenario | Handling |
| --- | --- | --- |
| E01 | Thousands buy the last tickets at once | Sharded stock; claims in transactions; invariant sold + held ≤ capacity |
| E02 | The chosen shard is empty but others have stock | Retry with another shard picked at random from those with stock; never report sold out |
| E03 | All shards empty but some stock is only held | Show "currently reserved, may become available" and offer the waitlist |
| E04 | Display says 3 left, buyer reaches checkout and none remain | Friendly "just sold out" message with the waitlist; no raw error |
| E05 | Hold expiry task fires after the hold was paid | Task checks hold status in a transaction; only releases ACTIVE holds |
| E06 | A 40-seat workshop runs a flash sale | Raise its shard count from 1; no code change |

### Payments

| ID | Scenario | Handling |
| --- | --- | --- |
| E07 | M-Pesa sends the same callback twice | Same CheckoutRequestID → same document; transaction sees PAID and stops |
| E08 | Two identical callbacks arrive at the same instant | Firestore re-runs the losing transaction, which then sees PAID |
| E09 | First attempt looked failed but succeeded; customer retried and paid again | Second transition rejected; payment marked DUPLICATE and refunded. Prevention: query the previous attempt's status before allowing a retry |
| E10 | Payment succeeds after the hold expired | Order → PAID\_LATE; re-acquire stock if available, otherwise refund |
| E11 | Callback never arrives | Scheduled reconciliation queries Daraja for orders stuck in AWAITING\_PAYMENT |
| E12 | App killed while waiting for PIN entry | On reopen the mini app calls watch(referenceId) and re-attaches |
| E13 | User changes phone clock to dodge a cancellation fee | Fee computed on server time only |

### Tickets and gates

| ID | Scenario | Handling |
| --- | --- | --- |
| E14 | Screenshot of one ticket shown at two gates offline | First scan wins after sync; duplicate flagged; tickets are single-use |
| E15 | Vendor moves the show time after tickets are sold | Triggered fan-out updates event summary and tickets in batches of up to 500, reschedules reminders, notifies holders; QR remains valid |
| E16 | Refunded ticket presented at an offline gate | Ticket marked void; gate learns on next sync, so gates sync before doors open |

### Restaurants and conferences

| ID | Scenario | Handling |
| --- | --- | --- |
| E17 | Two parties race for a shared table in different combinations | One transaction commits; the other re-runs, finds the table taken, tries its next candidate |
| E18 | Crash between releasing two combined tables | Release is one transaction, so no orphaned slots |
| E19 | Party larger than any combination | Group request → restaurant quote; slots claimed only when the quote is sent |
| E20 | Company names only 12 of 20 seats by the deadline | Automated reminders; the snapshotted policy is applied by a scheduled function; support handles exceptions with an audit entry |
| E21 | Organisation books seats by invoice and never pays | Invoice hold expires after the configured days; per-organisation cap on unpaid seats; vendor approval above it |

## 9. Security, privacy and KDPA compliance

The server is the only security boundary: the Flutter app and host SDK organise honest code, while Cloud Functions and security rules stop dishonest requests.

### Security controls

| Threat | Control |
| --- | --- |
| Tampered client writes stock, orders or tickets | Security rules deny all client writes to these collections; only functions write them |
| Stolen Daraja credentials or signing key | Secrets live in Secret Manager; never in the app bundle |
| Fake clients calling functions | Firebase App Check on all callable functions |
| Vendor reads another vendor's data | Custom claims carry tenantId; rules compare it on every read and write |
| Vendor moves an event to another tenant | Update rule validates the after-state (`request.resource.data.tenantId` unchanged) |
| Vendor publishes a broken event | Clients write drafts only; publishing runs through a validating function |
| Forged ticket | QR payload signed with a private key; gates verify with the public key offline |
| Mini app calls payments directly | Payments function checks the purpose is registered and the referenceId belongs to the user and is payable |
| Mini app overreaches | Capabilities declared up front; undeclared services throw |

Rules are not filters: every client query must include the constraint the rule checks (for example `where userId == uid`), or Firestore rejects the whole query.

### Personal data and the KDPA

| Area | Design response |
| --- | --- |
| Data minimisation | Each event declares `attendeeFields`; conference form fields declare a purpose; HostUser carries no phone or email |
| Sensitive personal data | Restaurant special requests and conference dietary fields can reveal health or religion: restricted to the tenant's staff, deleted after the booking, or replaced by structured options with notice |
| Roles | Open question: whether vendors act as data controllers and the platform as processor for attendee data (Section 11) |
| Access to attendee lists | Vendor reads of attendee lists are logged |
| Retention | Attendee data deleted or anonymised after a defined period after the event; period to be set per data category |
| Cross-border transfer | Firestore location is chosen once and cannot change; the region choice and its justification are recorded before launch |
| Consumer fairness | Cancellation and no-show policies shown before payment and snapshotted onto the booking |

## 10. Testing strategy and acceptance evidence

The two showpiece tests are the concurrency invariant and the payment chaos suite; both run against the Firebase Local Emulator Suite in CI.

| Level | Tool | What it proves | Covers |
| --- | --- | --- | --- |
| Unit (Dart) | `test` | Inventory strategies, pricing, eligibility rules, QR verification, Money type | FR-02 to FR-04, FR-07 |
| Bloc | `bloc_test` | Booking flows: hold expiry mid-payment, failed payment then retry, PaymentConfirming state | E04, E09, E12 |
| Widget and golden | `flutter_test` | Empty, loading, error, offline and sold-out states; seat map; ticket display | E03, E04 |
| Security rules | `@firebase/rules-unit-testing` | Tenant isolation, no client writes to stock/orders/tickets, draft-only vendor writes, tenantId cannot change | NFR-05, NFR-07 |
| Functions | Emulator + test runner | Duplicate, simultaneous, late and missing callbacks; PAID\_LATE path; fan-out on time change | E07 to E11, E15 |
| State machine | Generated matrix | Every (from, to) pair accepted only if in the allowed-transitions map | D10 |
| Concurrency | Emulator, 1,000 parallel hold requests for 100 tickets | Exactly 100 holds; invariant holds | NFR-01, E01, E02 |
| Restaurant races | Emulator, parallel bookings over shared tables | No double-booked slot; no orphaned slots after cancellation | E17, E18 |
| Integration | `integration_test` against emulators | Browse → hold → pay (mocked Daraja) → wallet → scan | End to end |
| Load | k6 against the staging project | Flash-sale behaviour under real contention (the emulator does not reproduce it) | NFR-03 |

The Flutter domain layer depends on repository interfaces, so unit and bloc tests use fakes, including a fake host SDK for mini app tests. Each environment (dev, staging, production) is a separate Firebase project mapped to a Flutter flavor.

## 11. Open questions and future work

- [ ] Data controller vs processor: do vendors control attendee data with the platform as processor, or is the platform a joint controller?
- [ ] Firestore region: which location, and the written justification under the KDPA cross-border transfer rules
- [ ] Retention periods per data category (attendee lists, sensitive fields, payment records)
- [ ] M-Pesa refunds: apply for the Daraja refund/reversal access; admin-handled refunds until then
- [ ] KRA eTIMS: confirm current requirements for conference invoices
- [ ] Discovery search: Firestore has no full-text search; decide between category and city filters only, or a search extension
- [ ] Seat maps for large stadiums: confirm section-by-section loading keeps reads acceptable
- [ ] Waitlist ordering and how long a waitlisted customer has to claim released stock
