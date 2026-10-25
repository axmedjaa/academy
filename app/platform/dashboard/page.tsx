import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getPlatformDashboardData } from "@/lib/platform/dashboard";
import { PlatformDashboardView } from "./dashboard-view";

/** `/platform/dashboard` (P01). Layout and per-section access rules are
 * documented on `PlatformDashboardView`. */
export default async function PlatformDashboardPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  return <PlatformDashboardView data={await getPlatformDashboardData(context)} />;
}

