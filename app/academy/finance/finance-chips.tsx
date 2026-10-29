import { Chip } from "@/app/academy/_shell/page-blocks";

/**
 * The design's finance chips (academy-engine.js `catChip` / `methodChip`):
 * a category or payment method as a tinted pill with an icon. Categories
 * are free text, so the icon is picked from a few recognisable words and
 * falls back to a plain receipt.
 */
const CATEGORY_ICONS: [RegExp, string, "brand" | "gold" | "slate"][] = [
  [/book/i, "book", "brand"],
  [/id card|card/i, "idcard", "brand"],
  [/sponsor|donat|grant/i, "bank", "gold"],
  [/print/i, "print", "gold"],
  [/suppl|station|material/i, "clipboard", "brand"],
  [/rent|electric|water|internet|util/i, "apartment", "slate"],
  [/salar|wage|staff/i, "group", "slate"],
  [/exam|certificate/i, "workspace_premium", "brand"],
];

export function categoryChip(label: string) {
  const hit = CATEGORY_ICONS.find(([pattern]) => pattern.test(label));
  return <Chip label={label} icon={hit?.[1] ?? "receipt_long"} tone={hit?.[2] ?? "slate"} />;
}

export const METHOD_OPTIONS = [
  { value: "cash", label: "Cash", icon: "cash" },
  { value: "mobile_money", label: "Mobile money", icon: "phone" },
  { value: "bank_transfer", label: "Bank transfer", icon: "bank" },
] as const;

export function methodChip(method: string) {
  const option = METHOD_OPTIONS.find((m) => m.value === method);
  const tone = method === "cash" ? "brand" : method === "mobile_money" ? "gold" : "slate";
  return <Chip label={option?.label ?? method} icon={option?.icon ?? "payments"} tone={tone} nowrap />;
}
