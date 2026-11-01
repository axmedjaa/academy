import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getLandingPlans } from "@/lib/marketing/landing";
import { getPublicContactSettings, hasPublicContact } from "@/lib/marketing/website-settings";
import { LandingPage } from "./_landing/landing-page";

export const metadata: Metadata = {
  title: "Dardar School System — Academy management platform",
  description:
    "Manage students, courses, batches, fee records, staff, and certificates in one organized platform built for growing training academies.",
};

/**
 * Public landing page (design L01, "Landing Page" in the Dardar Claude
 * Design project). Sign In goes to the existing /login; Get Started opens
 * the contact dialog — academies are still registered, approved and
 * activated by the platform owner, nothing here creates an account or an
 * academy. A signed-in visitor gets "Open console" (the same destination
 * sign-in uses) in place of Sign In; visiting this page never signs anyone
 * out or redirects them.
 *
 * Contact details come from Platform -> Website settings and are read on
 * every request (this page is dynamic: it reads the session cookie), so a
 * saved change shows on the next page load with no redeploy.
 */
export default async function Home() {
  const [context, plans, contact] = await Promise.all([getAuthContext(), getLandingPlans(), getPublicContactSettings()]);
  const consoleHref = context ? (context.platformRole ? "/platform/dashboard" : "/academy/dashboard") : null;

  return (
    <LandingPage
      consoleHref={consoleHref}
      contact={contact}
      showContact={hasPublicContact(contact)}
      plans={plans}
      year={new Date().getFullYear()}
    />
  );
}
