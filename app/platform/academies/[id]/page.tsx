import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { getAcademyById } from "@/lib/academies/approve";
import { ApproveAcademyButton } from "./approve-academy-button";

// Same gating as app/platform/academies/page.tsx — see that file's comment
// for why "approveAcademy" (ungrantable, platform_owner-only) is the
// capability used to gate the whole page, not just the Approve action.
const ACADEMIES_CAPABILITY = "approveAcademy";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <strong>{label}: </strong>
      <span>{value ?? "—"}</span>
    </div>
  );
}

export default async function AcademyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, ACADEMIES_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const { id } = await params;
  const academy = await getAcademyById(id);

  if (!academy) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Academy not found</h1>
        <p>
          <Link href="/platform/academies">Back to academies</Link>
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 700,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <p>
        <Link href="/platform/academies">Back to academies</Link>
      </p>
      <h1>{academy.name}</h1>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Profile</h2>
        <Field label="Slug" value={academy.slug} />
        <Field label="Type" value={academy.type} />
        <Field label="Default currency" value={academy.defaultCurrency} />
        <Field label="Address" value={academy.address} />
        <Field label="Phone" value={academy.phone} />
        <Field label="Email" value={academy.email} />
        <Field label="Website" value={academy.website} />
        <Field label="Registration number" value={academy.registrationNumber} />
        <Field label="Primary contact" value={academy.primaryContactName} />
        <Field label="Primary contact phone" value={academy.primaryContactPhone} />
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Onboarding metadata</h2>
        <Field
          label="Created by"
          value={academy.createdByEmail ?? academy.createdBy}
        />
        <Field label="Created" value={academy.createdAt.toLocaleString()} />
        <Field
          label="Approved by"
          value={academy.approvedByEmail ?? academy.approvedBy}
        />
        <Field
          label="Approved"
          value={academy.approvedAt ? academy.approvedAt.toLocaleString() : null}
        />
      </section>

      {/*
        Shell scope (PLAN.md Item 21) — deliberately NOT rendered here:
        - No Onboarding Checklist widget (DESIGN.md §11.3: profile
          complete/plan selected/approved/payment recorded) — plan
          selection and payment verification (Items 22-25) don't exist
          yet, so a checklist today could only fake two of its four rows.
        - No Activate/Suspend/Reactivate/Cancel/Close actions —
          activateAcademy depends on the checklist above; the others are
          Item 26.
        - No Reject button — PLAN.md Phase 1 §4 explicitly says rejection
          reuses cancelAcademy (Item 26), not a separate action; there is
          nothing to wire up yet.
        - No Subscription & Plan / Usage vs. Allowances / Payment History
          tabs — those need Items 22-25's subscriptions/plans/payments,
          none of which exist yet.
        Only the Approve action (below) and the fields above are real,
        wired to actual data — nothing here is a stub with fake values.
      */}
      <section>
        <h2>Approval</h2>
        {academy.status === "approved" ? (
          <p style={{ color: "#0a7d2c" }}>
            Approved on {academy.approvedAt?.toLocaleString()}
            {academy.approvedByEmail ? ` by ${academy.approvedByEmail}` : ""}.
          </p>
        ) : academy.status === "closed" ? (
          <p style={{ color: "#6b7280" }}>This academy is closed.</p>
        ) : (
          <ApproveAcademyButton academyId={academy.id} />
        )}
      </section>
    </main>
  );
}
