import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAcademyConsoleShellData, getPlatformConsoleShellData } from "@/lib/console/shell-data";
import { ConsoleShell } from "@/app/_console/console-shell";

/**
 * Shared account pages (Screen Inventory S01/S02) open inside the signed-in
 * user's own console shell, as in the design, since the account menu links
 * here from both consoles. Platform staff get the Platform shell; academy
 * members with usable access get the Academy shell; anyone else (signed
 * out, e.g. an email-verification link, or a blocked academy) gets the page
 * on its own. Each page still performs its own auth checks.
 */
export default async function AccountLayout({ children }: LayoutProps<"/account">) {
  const context = await getAuthContext();
  if (!context) return children;

  if (context.platformRole) {
    return <ConsoleShell data={await getPlatformConsoleShellData(context)}>{children}</ConsoleShell>;
  }

  const access = await checkAcademyAccessForContext(context);
  if (access.level === "blocked") return children;

  const data = await getAcademyConsoleShellData(context, access.academyId, access.membershipRole);
  return <ConsoleShell data={data}>{children}</ConsoleShell>;
}
