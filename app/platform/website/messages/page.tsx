import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listContactSubmissions, type ContactSubmissionStatus } from "@/lib/marketing/contact-submissions";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";
import { WebsiteTabs } from "../website-tabs";
import { ContactMessagesList } from "./contact-messages-list";

const STATUSES: ContactSubmissionStatus[] = ["new", "read", "archived"];

/**
 * Platform -> Website settings -> Contact messages: messages sent through
 * the public website's contact form. Platform owner only — the list and
 * every status change check `platform.website.manage` on the server.
 */
export default async function ContactMessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const params = await searchParams;
  const rawStatus = typeof params.status === "string" ? params.status : "";
  const status = STATUSES.includes(rawStatus as ContactSubmissionStatus) ? (rawStatus as ContactSubmissionStatus) : undefined;
  const page = Number(typeof params.page === "string" ? params.page : "1") || 1;

  const result = await listContactSubmissions(context, { status, page });
  if (!result.ok) {
    return <PageMessage title="Access denied" message={result.error.message} />;
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Website settings"
        description="Messages sent through the public website's contact form. Only the platform owner can read them."
      />
      <WebsiteTabs current="messages" />
      <ContactMessagesList
        rows={result.rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          notifiedAt: row.notifiedAt?.toISOString() ?? null,
          reviewedAt: row.reviewedAt?.toISOString() ?? null,
        }))}
        status={status ?? "all"}
        newCount={result.newCount}
        totalCount={result.totalCount}
      />
      <PaginationNav page={result.page} pageSize={result.pageSize} totalCount={result.totalCount} searchParams={params} />
    </div>
  );
}
