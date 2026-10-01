# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are staff at skills-training academies (vocational/skills academies) in Somalia, operating through six academy-level roles: Academy Owner, Academy Administrator, Manager, Admissions Officer, Finance Officer, and Trainer. Each role has a different day-to-day job inside the same academy — enrolling and tracking students, scheduling batches/timetables, entering and approving exam results, issuing certificates, and recording/approving finance (student payments, fee periods, one-off charges, book sales, expenses, income) — scoped by role permission and, for some roles, by assigned branch only.

A separate platform-level audience — Platform Owner and Platform Admin — operates Afoogy itself rather than an academy: approving/activating/suspending academies, managing subscription plans, and verifying subscription payments across every tenant academy.

## Product Purpose

Afoogy is a multi-tenant academy management platform purpose-built for skills-training academies to replace ad hoc spreadsheets, paper records, and WhatsApp-based coordination with one system covering admissions, batches/timetabling, exams & results, certificates, and finance. Success means an academy can run its entire operational and financial lifecycle — enroll a student, schedule their batch, record what they teach and when, grade and publish results, issue a certificate, and reconcile exactly what was paid and by whom — inside one tenant-isolated, role-permissioned system, without the academy's own data ever being visible to another tenant.

## Positioning

An all-in-one system built around the actual operating conditions of local skills-training academies — cash and mobile-money as first-class payment methods, English-language operation, USD pricing, Somalia as the target market — rather than a generic Western school-management SaaS adapted after the fact. A neighboring generic competitor could not truthfully claim the same native fit to cash/mobile-money finance workflows and the locally-relevant operational patterns (branch-limited staff, academy-issued documents carrying the academy's own identity, not the platform's) this product was designed around from the start.

## Operating Context

Academy staff work through role-scoped screens organized as: Students & Admissions, Staff, Academics (Programs / Courses / Batches / Timetable), Exams & Results, Finance (student payments, fee periods, charges, expenses, income, books & book sales, receipts), Certificates & IDs, Reports, Notifications, Audit Log, Settings. Several roles (Trainer, Admissions Officer) are branch-limited — they only see and act on data for their own assigned branch(es), never academy-wide. Every printed or exported document an academy issues to its own students or stakeholders (certificates, payment receipts, weekly timetables) carries that academy's own name, logo, and contact details — never Afoogy's branding.

Platform staff operate a separate surface: approving new academy registrations, activating/suspending/reactivating/closing academies, managing subscription plans, and verifying subscription payments — this is Afoogy operating its own tenants, not a tenant operating its own academy.

## Capabilities and Constraints

- Multi-tenant: every academy's data is isolated from every other academy; tenant scoping is enforced at the application layer as a mandatory rule, not left to database-level row security alone.
- A role-based permission matrix spans six academy roles and two platform roles, with explicit view/manage/full levels per capability, and branch-limited scoping for roles that shouldn't see academy-wide data.
- Money is always stored and reasoned about as integer cents; every user-facing input is entered in dollars and converted at the UI boundary, never floating-point.
- No hard deletes on posted financial or academic-result records — corrections/reversals are new, linked rows; the original record and full history are always preserved.
- Custom authentication (no third-party auth provider): email/password with Argon2id hashing, server-side sessions, mandatory TOTP MFA for platform-level accounts.
- English-language UI; USD is the default currency (configurable per academy); cash and mobile money are the payment methods the system records against, not credit-card/online-gateway checkout.
- File storage (academy logos, book covers, staff/student documents) is tenant-scoped on Cloudflare R2 behind short-lived signed URLs — never a public bucket or a client-trusted path.
- Primary and only currently-targeted market is skills-training academies in Somalia; the product has not been built or validated for other regions.
- Explicitly out of scope today: attendance tracking, a student self-service portal/login, automated online payment-gateway checkout, a general-ledger accounting system, payroll, a native mobile app.

## Brand Commitments

Product/brand name: **Afoogy** (academy-facing areas are referred to as "Afoogy Academy"). The internal repository/package name (`academy-management-saas`) is a technical identifier only and must never surface as the product name in any UI, design, or document work. No logo, color palette, or typography has been confirmed as binding yet.

## Evidence on Hand

None yet. There are no real pilot academies, customer feedback, case studies, press mentions, or confirmed brand assets to date. Future design or content work must not invent testimonials, customer names, benchmarks, or usage claims to fill this gap.

## Product Principles

1. Tenant isolation and role-scoped access are non-negotiable — every screen and action respects the academy boundary and the signed-in role's permission level, with no exceptions for convenience.
2. Money and financial/academic history are authoritative and auditable — amounts are always exact, and nothing financial or result-related is ever silently deleted, only corrected or reversed with a visible trail.
3. Built for the academy's real operating conditions — cash/mobile-money payment, English/USD, Somalia-market workflows — rather than adapted from a generic Western SaaS template.
4. Every document an academy issues to its own students or stakeholders carries that academy's own identity (name, logo, contact info), never Afoogy's.
5. Staff should be able to complete real workflows — enroll a student, schedule a term, record a payment, issue a certificate — without needing to understand the system's internal data model.

## Accessibility & Inclusion

No specific accessibility standard has been confirmed as a requirement yet.
