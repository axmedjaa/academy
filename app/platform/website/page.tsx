import { redirect } from "next/navigation";

/** Platform -> Website settings opens on Contact information. */
export default function WebsiteSettingsPage() {
  redirect("/platform/website/contact");
}
