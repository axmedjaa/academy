"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { LandingPlan } from "@/lib/marketing/landing";
import { PLAN_FEATURES, PLAN_LIMITS, formatLimit } from "@/lib/subscriptions/plan-catalog";
import type { PublicContactSettings } from "@/lib/marketing/website-settings-schema";
import { formatMoneyHeadline } from "@/lib/ui/money";
import { ContactForm, ContactSection, FooterContact } from "./contact-section";
import styles from "./landing.module.css";

/**
 * Dardar public landing page — design L01 ("Landing Page.dc.html" in the
 * Dardar Claude Design project), rebuilt on the app's own tokens and form
 * system. The copy is the design's. The dashboard, student, batch and
 * payment panels are illustrations labelled as sample data, exactly as in
 * the design; prices and contact details come from configuration
 * (lib/marketing/landing.ts), never from this file.
 */

const BODY = "text-[#374151]";
const MAX = "mx-auto max-w-[1160px]";
const H2 = "text-[clamp(26px,3.4vw,36px)] leading-[1.2] font-normal text-balance";
const EYEBROW = "mb-2 text-[13px] font-semibold tracking-[0.06em] text-brand uppercase";
const LIFT =
  "transition-[transform,box-shadow,border-color] duration-250 hover:-translate-y-1 hover:border-[#D9B3BB] hover:shadow-[0_12px_28px_rgba(17,24,39,0.10)]";

const NAV = [
  { label: "Home", href: "#top" },
  { label: "Features", href: "#features" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

const PROBLEMS = [
  {
    t: "Scattered student records",
    p: "Student details are spread across spreadsheets, documents, and paper files.",
    s: "One profile per student, searchable by staff with access.",
  },
  {
    t: "Confusing payment records",
    p: "Staff struggle to reconcile recorded payments and identify outstanding balances.",
    s: "Payments are recorded against fees, and balances are tracked.",
  },
  {
    t: "Disorganized courses and batches",
    p: "Managing students across several programs and batches becomes difficult.",
    s: "Programs, courses, batches, and enrollments stay linked.",
  },
  {
    t: "Manual certificate preparation",
    p: "Preparing, issuing, and verifying certificates takes unnecessary time.",
    s: "Certificates are issued from enrollment records with a QR code for verification.",
  },
  {
    t: "Limited operational visibility",
    p: "Owners lack a convenient overview of student numbers, finances, and academy activity.",
    s: "A dashboard and reports summarize students, batches, and payments.",
  },
  {
    t: "Disconnected communication",
    p: "Staff switch between different channels to reach students.",
    s: "Phone numbers carry WhatsApp and Telegram shortcuts, and notifications appear in the console.",
  },
];

const SAMPLE_STUDENTS = [
  { n: "Amina Yusuf", c: "Web Development" },
  { n: "Omar Hassan", c: "English B2" },
  { n: "Hodan Ali", c: "Tailoring" },
  { n: "Abdi Warsame", c: "Accounting" },
];

const SAMPLE_BATCHES = [
  { n: "Morning Batch, January", k: 2, d: "Sun to Thu, 08:00 to 11:00" },
  { n: "Evening Batch, March", k: 3, d: "Mon to Wed, 17:00 to 20:00" },
  { n: "Weekend Batch", k: 1, d: "Fri and Sat, 09:00 to 13:00" },
];

const SAMPLE_PAYMENTS = [
  { n: "Amina Yusuf", m: "Mobile money", a: "$120" },
  { n: "Omar Hassan", m: "Cash", a: "$80" },
  { n: "Hodan Ali", m: "Bank transfer", a: "$200" },
  { n: "Abdi Warsame", m: "Cash", a: "$60" },
];

const MINI_FEATURES = [
  {
    ic: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    t: "Staff and permissions",
    p: "Owners add staff and limit what each person can see and do.",
  },
  {
    ic: "M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14M8.21 13.89L7 23l5-3 5 3-1.21-9.12",
    t: "Certificates",
    p: "Issue one certificate per student per course, each with a QR code that can be checked on the verification page.",
  },
  {
    ic: "M18 20V10M12 20V4M6 20v-6",
    t: "Reports and dashboard",
    p: "An overview of students, batches, recorded payments, and balances for owners and authorized staff.",
  },
  {
    ic: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
    t: "Notifications",
    p: "In-console notifications, plus WhatsApp and Telegram shortcuts on phone numbers.",
  },
];

const STEPS = [
  {
    t: "Contact us",
    p: "Select Get Started and message us on WhatsApp or by email with your academy and owner details.",
  },
  {
    t: "Application review",
    p: "The platform owner reviews your request and approves or declines it. Contacting us does not activate your academy.",
  },
  {
    t: "Complete subscription setup",
    p: "After approval you receive the subscription details and manual payment instructions.",
  },
  {
    t: "Payment verification and activation",
    p: "The platform owner verifies your payment and activates the subscription. You can then sign in and use the features you are authorized for.",
  },
];

const ROLES = [
  {
    t: "Academy owners",
    items: ["Review academy activity", "Monitor financial reports", "Track recorded payments and balances", "Manage staff and settings"],
  },
  {
    t: "Administrators",
    items: ["Maintain student records", "Organize courses and batches", "Manage enrollments and daily operations"],
  },
  { t: "Finance staff", items: ["Record payments", "Review payment history", "Monitor outstanding balances"] },
  { t: "Trainers", items: ["View permitted students, batches, and courses"] },
];

const FAQS: [string, string][] = [
  [
    "What is Dardar?",
    "Dardar is an academy management platform for managing students, courses, batches, staff, fee records, and certificates in one system.",
  ],
  [
    "Which types of academies can use Dardar?",
    "Computer training academies, language institutes, vocational and technical training centers, professional development academies, and other organizations that run courses and student batches.",
  ],
  [
    "How do I get my academy on Dardar?",
    "Academies do not register themselves. Select Get Started and message us on WhatsApp or email your academy and owner details, and the platform owner reviews your request.",
  ],
  [
    "Is my academy activated immediately after I contact you?",
    "No. Your request is reviewed first, and the academy is activated after approval and a verified subscription payment.",
  ],
  [
    "How does approval work?",
    "The platform owner reviews each request and approves or declines it. You are told the next step after the review.",
  ],
  [
    "How do I pay for a Dardar subscription?",
    "After approval you receive the subscription details and manual payment instructions. Dardar does not charge cards or collect payment online.",
  ],
  [
    "How is my subscription payment verified?",
    "The platform owner checks the payment you made and records it as verified. The subscription is activated once verification is complete.",
  ],
  [
    "Can I record student payments made through mobile money or bank transfer?",
    "Yes. Authorized staff record student payments manually, including cash, mobile money, and bank transfer, and Dardar tracks outstanding balances. Dardar does not collect these payments for you.",
  ],
  [
    "Can I manage multiple courses and batches?",
    "Yes. Programs contain courses, and a batch can include several courses, each with its own classes, enrollments, exams, and fee plan.",
  ],
  [
    "Can staff have different access permissions?",
    "Yes. Owners assign permissions to each staff member, and staff see only the areas they are allowed to use.",
  ],
  [
    "Can Dardar generate and verify certificates?",
    "Yes. Certificates are issued per student per course and carry a QR code. A verification page lets anyone check a certificate.",
  ],
  [
    "What happens if my subscription expires?",
    "The subscription moves to past due, then suspended, according to the platform rules. The platform owner can reactivate it after a verified payment.",
  ],
  ["How do I contact support?", "Message us on WhatsApp or by email using the Get Started button."],
];

const PERIOD_LABEL: Record<LandingPlan["billingPeriod"], string> = {
  monthly: "month",
  quarterly: "quarter",
  annual: "year",
};

interface Props {
  /** Signed-in visitors get "Open console" here instead of Sign In. */
  consoleHref: string | null;
  /** Public contact settings (Platform -> Website settings). */
  contact: PublicContactSettings;
  /** Whether anything is configured for the Contact section. */
  showContact: boolean;
  plans: LandingPlan[];
  year: number;
}

export function LandingPage({ consoleHref, contact, showContact, plans, year }: Props) {
  const nav = showContact ? [...NAV, { label: "Contact", href: "#contact" }] : NAV;
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [problem, setProblem] = useState(0);
  const [faq, setFaq] = useState(-1);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const signIn = consoleHref
    ? { href: consoleHref, label: "Open console" }
    : { href: "/login", label: "Sign In" };
  const openApply = () => {
    setMenuOpen(false);
    setApplyOpen(true);
  };

  // Header shadow once the page has scrolled.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The mobile menu only exists below the 900px breakpoint.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    const onChange = () => query.matches && setMenuOpen(false);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Scroll reveal: elements marked data-rv fade up as they enter the view.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-in", "");
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
    );
    const items = root.querySelectorAll<HTMLElement>("[data-rv]");
    items.forEach((el) => {
      // Already on screen: show at once, no animation from a blank page.
      if (el.getBoundingClientRect().top < window.innerHeight * 0.85) el.setAttribute("data-in", "");
      else observer.observe(el);
    });
    root.classList.add(styles.revealOn);
    requestAnimationFrame(() => items.forEach((el) => el.getBoundingClientRect().top < window.innerHeight && el.setAttribute("data-in", "")));
    return () => observer.disconnect();
  }, []);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: PROBLEMS.length - 1,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = (keys[event.key] + PROBLEMS.length) % PROBLEMS.length;
    setProblem(next);
    tabRefs.current[next]?.focus();
  }

  const current = PROBLEMS[problem];

  return (
    <div ref={rootRef} className="w-full overflow-x-clip bg-app font-sans leading-normal text-ink">
      <header
        className={`sticky top-0 z-30 border-b border-border bg-white/92 backdrop-blur-md backdrop-saturate-[1.4] transition-shadow duration-250 ${
          scrolled ? "shadow-[0_4px_16px_rgba(17,24,39,0.08)]" : ""
        }`}
      >
        <div className="h-[3px] bg-[linear-gradient(90deg,#850019_0%,#850019_70%,#F5B638_70%,#F5B638_100%)]" />
        <div className={`${MAX} flex h-[72px] items-center gap-6 px-6`}>
          <Link href="/" aria-label="Dardar School System home" className="flex items-center">
            <Image src="/dardar-logo.png" alt="Dardar" width={52} height={38} priority className="h-[38px] w-auto" />
          </Link>
          <nav aria-label="Main" className="hidden flex-1 justify-center gap-7 min-[900px]:flex">
            {nav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="border-b-[3px] border-transparent px-0.5 pt-[26px] pb-[22px] text-sm font-medium tracking-[0.01em] !text-[#374151] no-underline transition-colors duration-200 hover:border-accent-gold hover:!text-brand"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="hidden items-center gap-3 min-[900px]:flex">
            <Link
              href={signIn.href}
              className="inline-flex h-[42px] items-center rounded-full border border-brand px-5 text-sm font-semibold !text-brand no-underline transition-colors duration-200 hover:bg-brand-tint"
            >
              {signIn.label}
            </Link>
            <button
              type="button"
              onClick={openApply}
              className="inline-flex h-[42px] cursor-pointer items-center gap-2 rounded-full bg-brand px-[22px] text-sm font-semibold text-white shadow-[0_4px_12px_rgba(133,0,25,0.25)] transition-[background-color,transform] duration-200 hover:bg-brand-hover active:scale-[0.97]"
            >
              Get Started <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="ml-auto flex items-center gap-2 min-[900px]:hidden">
            <button
              type="button"
              onClick={openApply}
              className="h-[42px] cursor-pointer rounded-full bg-brand px-[18px] text-sm font-semibold text-white"
            >
              Get Started
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              className="flex h-11 w-11 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-full border border-border-strong bg-white p-0"
            >
              <span className="h-0.5 w-[18px] bg-ink" />
              <span className="h-0.5 w-[18px] bg-ink" />
              <span className="h-0.5 w-[18px] bg-ink" />
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-menu"
            aria-label="Mobile"
            className={`${styles.menu} flex flex-col border-t border-border bg-white px-6 pt-2 pb-4 min-[900px]:hidden`}
          >
            {nav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="border-b border-[#F1F2F5] px-1 py-3.5 text-base font-medium !text-ink no-underline"
              >
                {link.label}
              </a>
            ))}
            <Link href={signIn.href} className="px-1 py-3.5 text-base font-semibold !text-brand no-underline">
              {signIn.label}
            </Link>
          </nav>
        )}
      </header>

      <main id="top">
        {/* HERO */}
        <section className="bg-[linear-gradient(#fff,#F7F8FA)] px-6 pt-16 pb-[72px]">
          <div className={`${MAX} grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-center gap-12`}>
            <div>
              <div
                data-rv
                style={{ transitionDelay: "80ms" }}
                className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3.5 py-1.5 text-[13px] font-semibold text-brand"
              >
                <span className={`${styles.pulse} h-2 w-2 rounded-full bg-accent-gold`} />
                Academy management platform
              </div>
              <h1
                data-rv
                style={{ transitionDelay: "190ms" }}
                className="mt-5 mb-4 text-[clamp(34px,5vw,54px)] leading-[1.1] font-bold tracking-[-0.02em] text-balance"
              >
                Run Your Academy. Not the Paperwork.
              </h1>
              <p data-rv style={{ transitionDelay: "300ms" }} className={`mb-7 max-w-[540px] text-lg text-pretty ${BODY}`}>
                Manage students, courses, batches, fee records, staff, and certificates in one organized platform built for
                growing training academies.
              </p>
              <div data-rv style={{ transitionDelay: "410ms" }} className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={openApply}
                  className="h-12 cursor-pointer rounded-lg bg-brand px-6 text-base font-semibold text-white transition-[background-color,transform] duration-200 hover:bg-brand-hover active:scale-[0.97]"
                >
                  Get Started
                </button>
                <a
                  href="#features"
                  className="inline-flex h-12 items-center justify-center rounded-lg border border-brand bg-white px-6 text-base font-semibold whitespace-nowrap !text-brand no-underline hover:bg-brand-tint"
                >
                  Explore Features
                </a>
              </div>
              <p data-rv style={{ transitionDelay: "520ms" }} className="mt-4 max-w-[460px] text-[13px] text-muted">
                New academies are set up by the Dardar team after review. Contacting us does not activate an academy.
              </p>
            </div>
            <DashboardPreview />
          </div>
        </section>

        {/* PROBLEM */}
        <section className="bg-white px-6 py-[72px]">
          <div className={MAX}>
            <h2 data-rv className={`mb-3 max-w-[720px] ${H2}`}>
              Running an Academy Shouldn&apos;t Mean Managing Endless Paperwork.
            </h2>
            <p data-rv className={`mb-9 max-w-[640px] text-[17px] ${BODY}`}>
              Dardar brings these everyday problems into one system with a single record for each student, course, batch, and
              payment.
            </p>
            <div data-rv className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-stretch gap-6">
              <div role="tablist" aria-label="Common problems" aria-orientation="vertical" className="grid content-start gap-2">
                {PROBLEMS.map((item, index) => {
                  const on = index === problem;
                  return (
                    <button
                      key={item.t}
                      ref={(el) => {
                        tabRefs.current[index] = el;
                      }}
                      type="button"
                      role="tab"
                      id={`problem-tab-${index}`}
                      aria-selected={on}
                      aria-controls="problem-panel"
                      tabIndex={on ? 0 : -1}
                      onClick={() => setProblem(index)}
                      onKeyDown={(event) => onTabKey(event, index)}
                      className={`flex min-h-14 w-full cursor-pointer items-center gap-3.5 rounded-xl border px-[18px] text-left text-base font-semibold transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-brand ${
                        on
                          ? "border-brand bg-brand text-white shadow-[0_8px_20px_rgba(133,0,25,0.25)]"
                          : "border-border bg-white text-ink"
                      }`}
                    >
                      <span className="flex-none text-[13px] font-bold opacity-70">0{index + 1}</span>
                      <span className="flex-1">{item.t}</span>
                      <span aria-hidden="true" className={`transition-opacity duration-200 ${on ? "opacity-100" : "opacity-0"}`}>
                        →
                      </span>
                    </button>
                  );
                })}
              </div>
              <div
                role="tabpanel"
                id="problem-panel"
                aria-labelledby={`problem-tab-${problem}`}
                className="flex flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-[0_12px_36px_rgba(17,24,39,0.08)]"
              >
                <div className="border-b border-border bg-app px-8 py-7">
                  <div className="mb-2.5 text-xs font-semibold tracking-[0.1em] text-muted uppercase">The problem</div>
                  <div className="mb-2 text-xl font-semibold">{current.t}</div>
                  <div className={`text-[15px] leading-[1.6] ${BODY}`}>{current.p}</div>
                </div>
                <div className="flex-1 bg-brand px-8 py-7 text-white">
                  <div className="mb-2.5 text-xs font-semibold tracking-[0.1em] text-accent-gold uppercase">With Dardar</div>
                  <div className="text-[19px] leading-[1.55] text-pretty">{current.s}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FEATURES */}
        <section id="features" className="scroll-mt-20 px-6 py-[72px]">
          <div className={MAX}>
            <div data-rv className={EYEBROW}>
              Features
            </div>
            <h2 data-rv className={`mb-12 max-w-[640px] ${H2}`}>
              The tools an academy uses every day
            </h2>

            <FeatureRow
              text={
                <FeatureText
                  title="Student management"
                  body="Authorized staff register and maintain student profiles, search and filter records, and follow each student's enrollments and history."
                  items={[
                    "Profiles with photo, contact details, and guardians",
                    "Search and filter by course, batch, or status",
                    "Access follows each staff member's permissions",
                  ]}
                />
              }
              visual={
                <div className="overflow-hidden rounded-xl border border-border bg-white text-[13px]" aria-label="Sample student list">
                  <div className="flex gap-2 border-b border-border px-3.5 py-3">
                    <div className="flex-1 rounded-lg border border-border-strong px-2.5 py-2 text-muted">Search students</div>
                    <div className="rounded-lg border border-border-strong px-2.5 py-2 text-muted">Status: Active</div>
                  </div>
                  {SAMPLE_STUDENTS.map((s) => (
                    <div key={s.n} className="flex justify-between gap-2 border-b border-[#F1F2F5] px-3.5 py-[11px]">
                      <span className="font-semibold">{s.n}</span>
                      <span className="text-muted">{s.c}</span>
                      <span className="rounded-full bg-[#DCFCE7] px-2 text-xs text-[#166534]">Active</span>
                    </div>
                  ))}
                </div>
              }
            />

            <FeatureRow
              visualFirst
              text={
                <FeatureText
                  title="Programs, courses, and batches"
                  body="Organize training programs into courses and run them in batches. A batch can contain several courses, each with its own classes, enrollments, exams, and fee plan."
                  items={["Timetables for each batch", "Student enrollments per course", "Related records stay linked"]}
                />
              }
              visual={
                <div className="grid gap-3 rounded-xl border border-border bg-white p-4 text-[13px]" aria-label="Sample batches">
                  {SAMPLE_BATCHES.map((b) => (
                    <div key={b.n} className="rounded-[10px] border border-border p-3">
                      <div className="flex justify-between font-semibold">
                        <span>{b.n}</span>
                        <span className="text-brand">{b.k} courses</span>
                      </div>
                      <div className="mt-0.5 text-muted">{b.d}</div>
                    </div>
                  ))}
                </div>
              }
            />

            <FeatureRow
              text={
                <FeatureText
                  title="Finance and payment records"
                  body="Staff with finance access record what students pay in cash, mobile money, or bank transfer, review payment history, and track outstanding fee balances."
                  items={["Manual entry with receipts", "Outstanding balance per student", "Available financial reports"]}
                  note="These are your students' tuition records. Dardar does not collect student tuition or process online payments, and these records are separate from your Dardar subscription."
                />
              }
              visual={
                <div className="overflow-hidden rounded-xl border border-border bg-white text-[13px]" aria-label="Sample payment records">
                  <div className="grid grid-cols-[1.4fr_1fr_1fr] bg-app px-3.5 py-2.5 font-semibold text-muted">
                    <span>Student</span>
                    <span>Method</span>
                    <span className="text-right">Amount</span>
                  </div>
                  {SAMPLE_PAYMENTS.map((p) => (
                    <div key={p.n} className="grid grid-cols-[1.4fr_1fr_1fr] border-t border-[#F1F2F5] px-3.5 py-[11px]">
                      <span>{p.n}</span>
                      <span className="text-muted">{p.m}</span>
                      <span className="text-right font-semibold">{p.a}</span>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-border bg-app px-3.5 py-[11px]">
                    <span>Outstanding balance</span>
                    <span className="font-bold text-brand">$2,150</span>
                  </div>
                </div>
              }
            />

            <div
              data-rv
              className="overflow-hidden rounded-xl border border-border bg-white shadow-[0_1px_2px_rgba(17,24,39,0.04)]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-border bg-app px-6 py-4">
                <span className="text-xs font-semibold tracking-[0.1em] text-brand uppercase">Also included</span>
                <span className="h-[3px] w-10 rounded-sm bg-accent-gold" />
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-px bg-border">
                {MINI_FEATURES.map((f) => (
                  <div key={f.t} className="flex items-start gap-4 bg-white px-6 py-7 transition-colors duration-200 hover:bg-[#FCF5F6]">
                    <div className="flex h-11 w-11 flex-none items-center justify-center rounded-[10px] bg-brand-tint text-brand">
                      <svg
                        width="22"
                        height="22"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d={f.ic} />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <h3 className="mb-1.5 text-[17px] font-normal">{f.t}</h3>
                      <p className={`text-[15px] leading-[1.6] text-pretty ${BODY}`}>{f.p}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* BEFORE / WITH */}
        <section className="bg-white px-6 py-[72px]">
          <div className={MAX}>
            <h2 data-rv className={`mb-8 ${H2}`}>
              Before Dardar and with Dardar
            </h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-6">
              <div data-rv className="rounded-xl border border-border bg-app p-6">
                <div className="mb-3.5 font-semibold text-muted">Without a centralized academy system</div>
                <ul className={`grid list-none gap-2 pl-5 ${BODY}`}>
                  <li>Student details scattered across different files</li>
                  <li>Payment information kept in separate records</li>
                  <li>Difficult batch and enrollment tracking</li>
                  <li>Time-consuming certificate preparation</li>
                  <li>Reports assembled manually</li>
                  <li>Limited visibility into academy activity</li>
                </ul>
              </div>
              <div data-rv style={{ transitionDelay: "90ms" }} className="rounded-xl border-2 border-brand bg-white p-6">
                <div className="mb-3.5 font-semibold text-brand">With Dardar</div>
                <ul className="grid list-none gap-2 pl-5 text-ink">
                  <li>Organized student records</li>
                  <li>Centralized course and batch information</li>
                  <li>Structured payment history and balances</li>
                  <li>More consistent certificate workflows</li>
                  <li>Reports available through supported dashboard features</li>
                  <li>A clearer operational overview</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how-it-works" className="scroll-mt-20 px-6 py-[72px]">
          <div className={MAX}>
            <div data-rv className={EYEBROW}>
              How it works
            </div>
            <h2 data-rv className={`mb-3 ${H2}`}>
              From application to a working academy
            </h2>
            <p data-rv className={`mb-9 max-w-[640px] text-[17px] ${BODY}`}>
              Each academy is reviewed and activated by the platform owner. Nothing in this process is automatic.
            </p>
            <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-6 p-0">
              {STEPS.map((step, index) => (
                <li
                  key={step.t}
                  data-rv
                  style={{ transitionDelay: `${index * 90}ms` }}
                  className={`relative rounded-xl border border-border bg-white p-5 ${LIFT}`}
                >
                  <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-full bg-brand font-bold text-white">
                    {index + 1}
                  </div>
                  <div className="mb-1.5 text-[17px] font-semibold">{step.t}</div>
                  <div className={`text-sm ${BODY}`}>{step.p}</div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ROLES */}
        <section className="bg-white px-6 py-[72px]">
          <div className={MAX}>
            <h2 data-rv className={`mb-3 ${H2}`}>
              Built for each person on your team
            </h2>
            <p data-rv className={`mb-8 max-w-[640px] text-[17px] ${BODY}`}>
              Access depends on the permissions you assign. Not everyone sees everything.
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-6">
              {ROLES.map((role, index) => (
                <div
                  key={role.t}
                  data-rv
                  style={{ transitionDelay: `${index * 90}ms` }}
                  className={`rounded-xl border border-border bg-app p-5 ${LIFT}`}
                >
                  <div className="mb-2.5 text-lg font-semibold text-brand">{role.t}</div>
                  <ul className={`grid list-none gap-1.5 pl-[18px] text-sm ${BODY}`}>
                    {role.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing" className="scroll-mt-20 px-6 py-[72px]">
          <div className={MAX}>
            <div data-rv className={EYEBROW}>
              Pricing
            </div>
            <h2 data-rv className={`mb-3 ${H2}`}>
              Plans for academies of every size
            </h2>
            <p data-rv className={`mb-8 max-w-[680px] text-[17px] ${BODY}`}>
              These are Dardar subscription plans. They are separate from the fees your academy charges its own students.
            </p>
            {plans.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] items-stretch gap-6">
                {plans.map((plan, index) => (
                  <PlanCard key={plan.id} plan={plan} featured={index === 1} delay={index * 90} onGetStarted={openApply} />
                ))}
              </div>
            ) : (
              <div
                data-rv
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-white p-6"
              >
                <p className={`max-w-[620px] ${BODY}`}>
                  Plan details, limits and prices are shared after your request is reviewed.
                </p>
                <button
                  type="button"
                  onClick={openApply}
                  className="h-11 cursor-pointer rounded-lg border border-brand bg-brand px-5 font-semibold text-white hover:bg-brand-hover"
                >
                  Get Started
                </button>
              </div>
            )}
            <p data-rv className="mt-5 max-w-[720px] text-sm text-muted">
              Activation follows approval and manual verification of your subscription payment. Trial terms, discounts, and
              refunds are not described here.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 bg-white px-6 py-[72px]">
          <div className="mx-auto max-w-[820px]">
            <h2 data-rv className={`mb-7 ${H2}`}>
              Frequently asked questions
            </h2>
            <div data-rv className="border-t border-border">
              {FAQS.map(([question, answer], index) => {
                const open = faq === index;
                return (
                  <div key={question} className="border-b border-border">
                    <h3 className="m-0">
                      <button
                        type="button"
                        id={`faq-q-${index}`}
                        onClick={() => setFaq(open ? -1 : index)}
                        aria-expanded={open}
                        aria-controls={`faq-${index}`}
                        className="flex min-h-14 w-full cursor-pointer items-center justify-between gap-4 border-0 bg-transparent py-3 text-left text-base font-semibold text-ink"
                      >
                        <span>{question}</span>
                        <span aria-hidden="true" className="flex-none text-[22px] leading-none text-brand">
                          {open ? "−" : "+"}
                        </span>
                      </button>
                    </h3>
                    <div
                      id={`faq-${index}`}
                      role="region"
                      aria-labelledby={`faq-q-${index}`}
                      className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
                    >
                      <div className={`min-h-0 overflow-hidden transition-[visibility] duration-300 ${open ? "visible" : "invisible"}`}>
                        <div className={`pr-10 pb-[18px] text-[15px] ${BODY}`}>{answer}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {showContact && <ContactSection contact={contact} />}

        {/* FINAL CTA */}
        <section className="px-6 py-[72px]">
          <div data-rv className={`${MAX} relative overflow-hidden rounded-2xl bg-brand px-8 py-14 text-center`}>
            <div className="absolute top-0 left-0 h-1 w-full bg-accent-gold" />
            <h2 className="mx-auto mb-3 max-w-[720px] text-[clamp(26px,3.6vw,38px)] leading-[1.2] font-normal text-balance text-white">
              Spend Less Time Managing Paperwork. More Time Growing Your Academy.
            </h2>
            <p className="mb-7 text-[17px] text-brand-tint">Bring your academy&apos;s essential operations into one organized system.</p>
            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={openApply}
                className="h-12 cursor-pointer rounded-lg bg-accent-gold px-[26px] text-base font-semibold text-ink"
              >
                Get Started
              </button>
              <Link
                href={signIn.href}
                className="inline-flex h-12 items-center justify-center rounded-lg border border-white px-[26px] text-base font-semibold whitespace-nowrap !text-white no-underline hover:bg-white/12"
              >
                {signIn.label}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative bg-ink text-[#D1D5DB]">
        <div className="h-[3px] bg-[linear-gradient(90deg,#850019_0%,#850019_60%,#F5B638_60%,#F5B638_100%)]" />
        <div className={`${MAX} px-6 pt-14 pb-8`}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-x-8 gap-y-10">
            <div className="col-span-2 max-w-[400px] min-w-[min(100%,260px)] max-[479px]:col-span-1">
              <div className="inline-block rounded-[10px] bg-white px-3.5 py-2.5">
                <Image src="/dardar-logo.png" alt="Dardar" width={41} height={30} className="h-[30px] w-auto" />
              </div>
              <p className="mt-[18px] mb-[22px] text-[15px] leading-[1.65] text-[#9CA3AF]">
                Academy management for training academies: students, courses, batches, fee records, staff, and certificates in
                one organized system.
              </p>
              <button
                type="button"
                onClick={openApply}
                className="h-11 cursor-pointer rounded-lg bg-accent-gold px-5 text-sm font-semibold text-ink hover:bg-[#e6a62a]"
              >
                Get Started
              </button>
            </div>
            <nav aria-label="Explore">
              <div className="mb-4 text-xs font-semibold tracking-[0.1em] text-accent-gold uppercase">Explore</div>
              <div className="grid gap-3 text-[15px]">
                {nav.slice(1).map((link) => (
                  <a key={link.href} href={link.href} className="!text-[#E5E7EB] no-underline hover:!text-white hover:!underline">
                    {link.label}
                  </a>
                ))}
              </div>
            </nav>
            <nav aria-label="Account">
              <div className="mb-4 text-xs font-semibold tracking-[0.1em] text-accent-gold uppercase">Account</div>
              <div className="grid gap-3 text-[15px]">
                <Link href={signIn.href} className="!text-[#E5E7EB] no-underline hover:!text-white hover:!underline">
                  {signIn.label}
                </Link>
                {showContact && (
                  <a href="#contact" className="!text-[#E5E7EB] no-underline hover:!text-white hover:!underline">
                    Contact us
                  </a>
                )}
              </div>
            </nav>
            <FooterContact contact={contact} />
          </div>
          <div className="mt-12 flex flex-wrap justify-between gap-x-6 gap-y-3 border-t border-[#374151] pt-5 text-[13px] text-[#9CA3AF]">
            <span>© {year} Dardar School System</span>
            <span>Academies are reviewed before activation.</span>
          </div>
        </div>
      </footer>

      <GetStartedDialog open={applyOpen} onOpenChange={setApplyOpen} contact={contact} signIn={signIn} />
    </div>
  );
}

function DashboardPreview() {
  const bars = [40, 55, 48, 70, 62, 92];
  return (
    <div
      data-rv
      style={{ transitionDelay: "300ms" }}
      role="img"
      aria-label="Dardar dashboard preview with sample data"
      className="overflow-hidden rounded-xl border border-border bg-white shadow-[0_12px_40px_rgba(17,24,39,0.10)]"
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-app px-3.5 py-2.5">
        <span className="h-[9px] w-[9px] rounded-full bg-border" />
        <span className="h-[9px] w-[9px] rounded-full bg-border" />
        <span className="h-[9px] w-[9px] rounded-full bg-border" />
        <span className="ml-2.5 text-xs text-muted">Dashboard · Sample data</span>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3">
          {[
            ["Total students", "312"],
            ["Active batches", "14"],
            ["Recorded this month", "$8,420"],
            ["Outstanding balances", "$2,150"],
          ].map(([label, value], index) => (
            <div key={label} className="rounded-[10px] border border-border p-3">
              <div className="text-xs text-muted">{label}</div>
              <div className={`text-2xl font-bold ${index === 3 ? "text-brand" : ""}`}>{value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-[10px] border border-border p-3">
          <div className="mb-2 text-xs text-muted">Recorded payments, last 6 months</div>
          <div className="flex h-16 items-end gap-2.5">
            {bars.map((height, index) => (
              <div
                key={index}
                data-bar
                style={{ height: `${height}%` }}
                className={`flex-1 rounded ${index === bars.length - 1 ? "bg-brand" : "bg-brand-tint"}`}
              />
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-[10px] border border-border text-[13px]">
          <div className="flex justify-between border-b border-[#F1F2F5] px-3 py-2.5">
            <span>Amina Yusuf · Web Development</span>
            <span className="font-semibold">$120 · Mobile money</span>
          </div>
          <div className="flex justify-between px-3 py-2.5">
            <span>Omar Hassan · English B2</span>
            <span className="font-semibold">$80 · Cash</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureRow({ text, visual, visualFirst = false }: { text: ReactNode; visual: ReactNode; visualFirst?: boolean }) {
  return (
    <div className="mb-[72px] grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-center gap-12">
      {visualFirst ? (
        <>
          <div data-rv>{visual}</div>
          <div data-rv style={{ transitionDelay: "90ms" }}>
            {text}
          </div>
        </>
      ) : (
        <>
          <div data-rv>{text}</div>
          <div data-rv style={{ transitionDelay: "90ms" }}>
            {visual}
          </div>
        </>
      )}
    </div>
  );
}

function FeatureText({ title, body, items, note }: { title: string; body: string; items: string[]; note?: string }) {
  return (
    <>
      <h3 className="mb-2.5 text-2xl font-normal">{title}</h3>
      <p className={`mb-4 ${BODY}`}>{body}</p>
      <ul className={`grid list-none gap-1.5 pl-5 ${BODY} ${note ? "mb-4" : ""}`}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {note && <div className={`rounded-lg bg-brand-tint px-3.5 py-3 text-sm ${BODY}`}>{note}</div>}
    </>
  );
}

function PlanCard({
  plan,
  featured,
  delay,
  onGetStarted,
}: {
  plan: LandingPlan;
  featured: boolean;
  delay: number;
  onGetStarted: () => void;
}) {
  // Same values the server enforces; null limits read "Unlimited".
  const limits: [string, string][] = PLAN_LIMITS.map((limit) => [limit.label, formatLimit(limit.unit, plan.limits[limit.key])]);
  const features = PLAN_FEATURES.filter((feature) => plan.features.includes(feature.key));
  return (
    <div
      data-rv
      style={{ transitionDelay: `${delay}ms` }}
      className={`flex flex-col rounded-xl bg-white p-6 transition-[transform,box-shadow] duration-250 hover:-translate-y-1 hover:shadow-[0_12px_28px_rgba(17,24,39,0.10)] ${
        featured ? "border-2 border-brand" : "border border-border"
      }`}
    >
      <div className="text-lg font-semibold">{plan.name}</div>
      {plan.description && <p className={`mt-1 text-sm ${BODY}`}>{plan.description}</p>}
      <div className="mt-2.5 mb-[18px]">
        <span className="text-[38px] font-bold">{formatMoneyHeadline(plan.priceAmountCents, plan.currency)}</span>
        <span className="text-muted">
          {" "}
          {plan.currency} / {PERIOD_LABEL[plan.billingPeriod]}
        </span>
      </div>
      <ul className={`grid list-none gap-2 p-0 text-sm ${BODY}`}>
        {limits.map(([label, value]) => (
          <li key={label} className="flex justify-between border-b border-[#F1F2F5] pb-2">
            <span>{label}</span>
            <span className="font-semibold text-ink">{value}</span>
          </li>
        ))}
      </ul>
      <ul className={`mt-4 mb-6 grid flex-1 content-start list-none gap-2 p-0 text-sm ${BODY}`} aria-label={`${plan.name} features`}>
        {features.map((feature) => (
          <li key={feature.key} className="flex items-start gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 flex-none text-brand">
              <path d="M5 12l5 5L20 7" />
            </svg>
            {feature.label}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onGetStarted}
        className={`h-11 cursor-pointer rounded-lg border border-brand font-semibold ${
          featured ? "bg-brand text-white hover:bg-brand-hover" : "bg-white text-brand hover:bg-brand-tint"
        }`}
      >
        Get Started
      </button>
    </div>
  );
}

/** "Get started with Dardar": WhatsApp, the website contact form (stored
 * for the platform owner), or the support email and phone — whichever are
 * configured in Platform -> Website settings. Nothing here registers an
 * academy: the platform owner registers and approves academies by hand. */
function GetStartedDialog({
  open,
  onOpenChange,
  contact,
  signIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: PublicContactSettings;
  signIn: { href: string; label: string };
}) {
  const hasAny = Boolean(contact.whatsappUrl || contact.contactFormEnabled || contact.supportEmail || contact.phone);
  const description = !hasAny
    ? "Contact details for new academy requests are not available yet. Please check back soon."
    : contact.whatsappUrl && contact.contactFormEnabled
      ? "Message us on WhatsApp or send your academy details below. We review every request, and sending a message does not activate an academy."
      : "Send us your academy details. We review every request, and sending a message does not activate an academy.";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={`${styles.overlay} fixed inset-0 z-50 bg-[rgba(17,24,39,0.55)] backdrop-blur-[4px]`} />
        {/* The dialog itself is the scroll area: Radix's scroll lock only lets
            the dialog content scroll, so a tall form must scroll inside it. */}
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <DialogPrimitive.Content
            className={`${styles.dialog} pointer-events-auto max-h-[calc(100dvh-2rem)] w-full max-w-[480px] overflow-y-auto overscroll-contain rounded-xl bg-white font-sans text-ink focus:outline-none sm:max-h-[calc(100dvh-3rem)]`}
          >
            <div className="h-[3px] bg-accent-gold" />
            <div className="p-6">
              <div className="flex items-start justify-between gap-3">
                <DialogPrimitive.Title className="mb-1.5 text-[22px] font-normal">Get started with Dardar</DialogPrimitive.Title>
                <DialogPrimitive.Close
                  aria-label="Close"
                  className="-mt-2 -mr-2 flex h-11 w-11 flex-none cursor-pointer items-center justify-center border-0 bg-transparent text-2xl text-muted"
                >
                  ×
                </DialogPrimitive.Close>
              </div>
              <DialogPrimitive.Description className={`mb-5 text-[15px] ${BODY}`}>{description}</DialogPrimitive.Description>

              {contact.whatsappUrl && (
                <a
                  href={contact.whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[52px] items-center justify-center rounded-lg bg-brand text-base font-semibold !text-white no-underline hover:bg-brand-hover"
                >
                  Message us on WhatsApp
                </a>
              )}

              {contact.whatsappUrl && contact.contactFormEnabled && (
                <div className="my-4 flex items-center gap-3 text-[13px] text-muted">
                  <span className="h-px flex-1 bg-border" />
                  or send a message
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              {contact.contactFormEnabled ? (
                <ContactForm idPrefix="get-started" defaultSubject="New academy request" />
              ) : (
                (contact.supportEmail || contact.phone) && (
                  <div className={`grid gap-2 text-[15px] ${contact.whatsappUrl ? "mt-4" : ""}`}>
                    {contact.supportEmail && (
                      <a
                        href={`mailto:${contact.supportEmail}?subject=${encodeURIComponent("New academy request")}`}
                        className="flex min-h-12 items-center justify-center rounded-lg border border-brand font-semibold !text-brand no-underline hover:bg-brand-tint"
                      >
                        Email {contact.supportEmail}
                      </a>
                    )}
                    {contact.phone && (
                      <a
                        href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}
                        className="flex min-h-12 items-center justify-center rounded-lg border border-brand font-semibold !text-brand no-underline hover:bg-brand-tint"
                      >
                        Call {contact.phone}
                      </a>
                    )}
                  </div>
                )
              )}

              <p className="mt-4 text-[13px] text-muted">
                Already approved?{" "}
                <Link href={signIn.href} className="!text-brand hover:!text-brand-hover hover:!underline">
                  {signIn.label === "Sign In" ? "Sign in" : signIn.label}
                </Link>
                .
              </p>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
