import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getPlatformDashboardData } from "@/lib/platform/dashboard";
import { Icon } from "@/app/academy/_shell/icons";
import {
  Badge,
  EmptyState,
  LinkButton,
  PAGE_WRAP,
  PageHeader,
  Section,
  StatCard,
  TableWrap,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(date));
}

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

const PAYMENT_STATUS_TONE: Record<string, "amber" | "green" | "red" | "slate" | "gray"> = {
  pending: "amber",
  verified: "green",
  rejected: "red",
  reversed: "slate",
};

/**
 * Navigation-audit Phase 3 — the one genuinely new page from the audit's
 * §10 table: a lightweight landing page for `/platform/*` so a platform
 * actor doesn't land on a bare "Academies" list with no sense of what needs
 * attention. All data comes from `lib/platform/dashboard.ts`'s
 * `getPlatformDashboardData`, which only calls already-existing, already-gated
 * reads — see that file's module comment.
 *
 * No single page-level capability gate: `app/platform/layout.tsx` already
 * requires *some* platform role before any `/platform/*` route (including
 * this one) renders at all, exactly like `/academy/dashboard` has no gate
 * beyond its own layout. Each section below is independently omitted (not
 * shown as an error) when the actor's specific capability grant doesn't
 * cover it — mirrors the academy dashboard's per-section visibility.
 */
export default async function PlatformDashboardPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const data = await getPlatformDashboardData(context);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Dashboard" description="Overview of academies, subscriptions, and payments across the platform." />

      <div className="flex flex-col gap-6">
        {(data.pendingApprovals !== null || data.expiringSubscriptions !== null) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {data.pendingApprovals !== null && (
              <StatCard
                label="Pending Approvals"
                value={data.pendingApprovals.length}
                icon={<Icon name="apartment" />}
                index={0}
                href="/platform/academies"
              />
            )}
            {data.expiringSubscriptions !== null && (
              <StatCard
                label="Expiring Subscriptions"
                value={data.expiringSubscriptions.length}
                icon={<Icon name="autorenew" />}
                index={1}
                href="/platform/reports"
              />
            )}
          </div>
        )}

        <Section>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Pending approvals</h2>
            <LinkButton href="/platform/academies" variant="secondary">
              View all academies
            </LinkButton>
          </div>
          {data.pendingApprovals === null ? (
            <EmptyState message="You don't have permission to view academy approvals." icon={<Icon name="apartment" />} />
          ) : data.pendingApprovals.length === 0 ? (
            <EmptyState message="No academies awaiting approval." icon={<Icon name="apartment" />} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Academy</th>
                  <th className={th}>Submitted by</th>
                  <th className={th}>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {data.pendingApprovals.map((academy) => (
                  <tr key={academy.id} className={trHover}>
                    <td className={td}>{academy.name}</td>
                    <td className={td}>{academy.createdByEmail ?? "—"}</td>
                    <td className={td}>{formatDate(academy.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>

        <Section>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Expiring subscriptions</h2>
            <LinkButton href="/platform/reports" variant="secondary">
              View reports
            </LinkButton>
          </div>
          {data.expiringSubscriptions === null ? (
            <EmptyState message="You don't have permission to view platform reports." icon={<Icon name="autorenew" />} />
          ) : data.expiringSubscriptions.length === 0 ? (
            <EmptyState message="No subscriptions expiring soon." icon={<Icon name="autorenew" />} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Academy</th>
                  <th className={th}>Plan</th>
                  <th className={th}>Ends</th>
                  <th className={th}>Days left</th>
                </tr>
              </thead>
              <tbody>
                {data.expiringSubscriptions.map((row) => (
                  <tr key={row.subscriptionId} className={trHover}>
                    <td className={td}>{row.academyName}</td>
                    <td className={td}>{row.planName}</td>
                    <td className={td}>{formatDate(row.endsAt)}</td>
                    <td className={td}>
                      <Badge
                        label={row.daysUntilExpiry < 0 ? "Overdue" : `${row.daysUntilExpiry}d`}
                        tone={row.daysUntilExpiry < 0 ? "red" : "amber"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>

        <Section>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Recent payments</h2>
            <LinkButton href="/platform/payments" variant="secondary">
              View all payments
            </LinkButton>
          </div>
          {data.recentPayments === null ? (
            <EmptyState message="You don't have permission to view subscription payments." icon={<Icon name="payments" />} />
          ) : data.recentPayments.length === 0 ? (
            <EmptyState message="No payments recorded yet." icon={<Icon name="payments" />} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Academy</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Received</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recentPayments.map((payment) => (
                  <tr key={payment.id} className={trHover}>
                    <td className={td}>{payment.academyName ?? "—"}</td>
                    <td className={td}>{formatMoney(payment.amountCents, payment.currency)}</td>
                    <td className={td}>{formatDate(payment.receivedAt)}</td>
                    <td className={td}>
                      <Badge label={payment.status} tone={PAYMENT_STATUS_TONE[payment.status] ?? "gray"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>
      </div>
    </div>
  );
}
