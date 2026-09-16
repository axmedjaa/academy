import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, academySubscriptions, subscriptionPayments, subscriptionPlans } from "@/lib/db/schema";

/**
 * PLAN.md Phase 1, Item 21: "`getOnboardingChecklistStatus` gating
 * `activateAcademy`" + DESIGN.md §11.3: "A widget on
 * `/platform/academies/[id]` listing preconditions (profile complete, plan
 * selected, approved, first payment recorded) with check/cross icons; the
 * Activate button stays disabled with a tooltip until every item is
 * satisfied — never silently clickable-but-failing."
 *
 * Lives in its own file rather than lib/academies/approve.ts: it reads
 * across academies/academy_subscriptions/subscription_plans/
 * subscription_payments (four tables, three of them outside approve.ts's
 * usual academies-table focus), matching the same file-split reasoning
 * lib/academies/lifecycle.ts's own top-of-file comment gives for why it
 * isn't folded into approve.ts either.
 *
 * -----------------------------------------------------------------------
 * Deliberate deviation #1 — "payment recorded" vs. "payment verified"
 * -----------------------------------------------------------------------
 * DESIGN.md §11.3's literal checklist item is "first payment **recorded**".
 * lib/academies/lifecycle.ts's `activateAcademy` (already built, Item 26),
 * however, actually requires a **verified** `subscription_payments` row for
 * any nonzero-price plan before it will let the subscription move to Active
 * — a merely "pending" (recorded-but-not-yet-verified) payment does not
 * satisfy it. If this checklist showed all-green using DESIGN.md's literal
 * wording (any recorded payment, regardless of status) while the recorded
 * payment is still pending, the widget would show every precondition met,
 * the Activate button would be enabled, and clicking it would fail with
 * activateAcademy's `payment_required` error — exactly the "silently
 * clickable-but-failing" outcome DESIGN.md's own sentence, one clause later,
 * says must never happen. Literal-wording compliance and the
 * never-clickable-but-failing rule cannot both hold here, and the latter is
 * the more specific, more load-bearing rule (it's the one guarding actual
 * user-facing correctness) — so this file's `payment_verified` checklist
 * item checks for a `verified` `subscription_payments` row, matching
 * activateAcademy's real gate exactly (same "planId -> priceAmountCents -> 0
 * means no payment needed, else require one verified row for this
 * subscription" logic, copied from lifecycle.ts's activateAcademy body). The
 * item's label reads "Payment verified", not "Payment recorded", and its
 * failure detail explicitly distinguishes "nothing recorded yet" from "a
 * payment is recorded but still pending verification" so a platform owner
 * looking at a red cross understands which of the two is true.
 *
 * -----------------------------------------------------------------------
 * Deliberate judgment call #2 — what "profile complete" means
 * -----------------------------------------------------------------------
 * Neither PLAN.md nor DESIGN.md defines which of `academies`' expanded,
 * all-nullable profile fields (type, address, phone, email, website,
 * logo_ref, registration_number, primary_contact_name,
 * primary_contact_phone — see lib/academies/register.ts's schema and
 * lib/academies/lifecycle.ts's own top-of-file comment, which flags this as
 * exactly this same known, previously-unresolved gap) constitute "complete."
 * This picks the five fields that are actually needed to *operate and
 * reach* the academy once it's live — address, phone, email,
 * primary_contact_name, primary_contact_phone — and requires all five to be
 * set. `type`, `website`, `logo_ref`, and `registration_number` are left out
 * of the requirement: they're either cosmetic/marketing metadata (website,
 * logo) or a business-registration detail that varies a lot by
 * jurisdiction/legal form (registration_number, type) and doesn't answer
 * "can the platform owner reach and administer this academy." This is a
 * judgment call, not a rule the codebase defines anywhere else; if a later
 * item defines an authoritative list, this is the one place to update.
 *
 * Because `activateAcademy` itself does NOT enforce profile completeness
 * (see lifecycle.ts's own comment on this), making this checklist item
 * required is *stricter* than the backend's actual gate — which is the
 * direction that's always safe for a precondition widget to err in: a
 * checklist item that's red when the real action would in fact succeed only
 * over-blocks (annoying, never wrong), whereas a checklist item that's green
 * when the real action would fail is the "silently clickable-but-failing"
 * bug this widget exists to prevent. Every item here is deliberately chosen
 * so that "all green" implies "activateAcademy will not reject the call for
 * a reason this checklist claims to cover."
 */

export type OnboardingChecklistItemKey =
  | "profile_complete"
  | "plan_selected"
  | "approved"
  | "payment_verified";

export interface OnboardingChecklistItem {
  key: OnboardingChecklistItemKey;
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface OnboardingChecklistStatus {
  academyId: string;
  items: OnboardingChecklistItem[];
  /**
   * True only when every item above is satisfied — this is exactly the
   * condition app/platform/academies/[id]/lifecycle-actions.tsx uses to
   * enable the Activate button (plus the subscription being in a state
   * `activateAcademy` will actually accept — see that component's own
   * comment for why that second, orthogonal check also has to hold).
   */
  allSatisfied: boolean;
}

const PROFILE_COMPLETE_FIELDS = [
  { key: "address", label: "Address" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "primaryContactName", label: "Primary contact name" },
  { key: "primaryContactPhone", label: "Primary contact phone" },
] as const;

/**
 * PLAN.md §4: `getOnboardingChecklistStatus`. Pure read, no permission check
 * of its own (matches lib/academies/approve.ts's listAcademies()/
 * getAcademyById() convention — the page gates once, this is just a display
 * query). Returns null for a missing/malformed academy id, same convention
 * as getAcademyById.
 */
export async function getOnboardingChecklistStatus(
  academyId: string,
  executor: DbClient = db,
): Promise<OnboardingChecklistStatus | null> {
  const parsed = z.string().uuid().safeParse(academyId);
  if (!parsed.success) return null;

  const [academy] = await executor
    .select({
      id: academies.id,
      approvedAt: academies.approvedAt,
      address: academies.address,
      phone: academies.phone,
      email: academies.email,
      primaryContactName: academies.primaryContactName,
      primaryContactPhone: academies.primaryContactPhone,
    })
    .from(academies)
    .where(eq(academies.id, parsed.data))
    .limit(1);
  if (!academy) return null;

  const missingFields = PROFILE_COMPLETE_FIELDS.filter((field) => !academy[field.key]);
  const profileComplete = missingFields.length === 0;

  const [subscription] = await executor
    .select({
      id: academySubscriptions.id,
      planId: academySubscriptions.planId,
    })
    .from(academySubscriptions)
    .where(eq(academySubscriptions.academyId, parsed.data))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);

  const planSelected = subscription !== undefined;

  let paymentSatisfied = false;
  let paymentDetail =
    "No subscription has been created for this academy yet — a plan must be assigned first.";

  if (subscription) {
    // Mirrors lib/academies/lifecycle.ts's activateAcademy exactly: a plan
    // that doesn't exist (shouldn't happen, FK-enforced) or is free requires
    // no payment; anything else needs one `verified` row for this specific
    // subscription.
    const [plan] = await executor
      .select({ priceAmountCents: subscriptionPlans.priceAmountCents })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, subscription.planId))
      .limit(1);

    if (!plan || plan.priceAmountCents === 0) {
      paymentSatisfied = true;
      paymentDetail = "This plan has no cost — no payment is required before activation.";
    } else {
      const [verifiedPayment] = await executor
        .select({ id: subscriptionPayments.id })
        .from(subscriptionPayments)
        .where(
          and(
            eq(subscriptionPayments.subscriptionId, subscription.id),
            eq(subscriptionPayments.status, "verified"),
          ),
        )
        .limit(1);

      if (verifiedPayment) {
        paymentSatisfied = true;
        paymentDetail = "A verified payment is on file for this subscription.";
      } else {
        const [pendingPayment] = await executor
          .select({ id: subscriptionPayments.id })
          .from(subscriptionPayments)
          .where(eq(subscriptionPayments.subscriptionId, subscription.id))
          .limit(1);

        paymentDetail = pendingPayment
          ? "A payment has been recorded but not yet verified. Activation requires a VERIFIED payment (see /platform/payments) — a pending or rejected/reversed payment is not enough."
          : "No payment has been recorded for this subscription yet.";
      }
    }
  }

  const approved = academy.approvedAt !== null;

  const items: OnboardingChecklistItem[] = [
    {
      key: "profile_complete",
      label: "Profile complete",
      satisfied: profileComplete,
      detail: profileComplete
        ? "All required profile fields are on file."
        : `Missing: ${missingFields.map((field) => field.label).join(", ")}.`,
    },
    {
      key: "plan_selected",
      label: "Plan selected",
      satisfied: planSelected,
      detail: planSelected
        ? "A subscription plan has been assigned to this academy."
        : "No subscription has been created for this academy.",
    },
    {
      key: "approved",
      label: "Approved",
      satisfied: approved,
      detail: approved
        ? "This academy has been approved by the platform owner."
        : "Awaiting platform owner approval (see the Approval section above).",
    },
    {
      // See this file's top-of-file "Deliberate deviation #1" comment for
      // why this checks for a VERIFIED payment, not merely a recorded one.
      key: "payment_verified",
      label: "Payment verified",
      satisfied: paymentSatisfied,
      detail: paymentDetail,
    },
  ];

  return {
    academyId: parsed.data,
    items,
    allSatisfied: items.every((item) => item.satisfied),
  };
}
