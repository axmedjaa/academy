import type { SVGProps } from "react";
import { CHAT_UNAVAILABLE_HINT, chatLinks } from "@/lib/ui/chat-links";

/**
 * WhatsApp and Telegram contact actions, as the design draws them: the
 * official brand marks (the Simple Icons glyphs the design itself uses,
 * WhatsApp green #25D366 and Telegram blue #26A5E4) inside white bordered
 * buttons. Links come from `chatLinks`, which only accepts international
 * numbers; anything else renders the same controls disabled with the reason
 * in their tooltip, so a chat never opens to a guessed number.
 *
 * No hooks: usable from server and client components alike.
 */

export function WhatsAppMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" {...props}>
      <path
        fill="#25D366"
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"
      />
    </svg>
  );
}

export function TelegramMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" {...props}>
      <path
        fill="#26A5E4"
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
      />
    </svg>
  );
}

type Variant = "icon" | "pill" | "field";

const SHAPE: Record<Variant, string> = {
  // Table cells: 36px round buttons under the number.
  icon: "h-9 w-9 justify-center rounded-full border border-border",
  // Detail key-value rows: labelled pills.
  pill: "min-h-9 gap-1.5 rounded-full border border-border px-3 text-xs font-semibold",
  // Inside the phone input: square segments split by a left rule.
  field: "h-[42px] w-11 justify-center border-l border-border",
};

function ChatButton({
  href,
  label,
  title,
  variant,
  children,
  text,
}: {
  href: string | null;
  label: string;
  title: string;
  variant: Variant;
  children: React.ReactNode;
  text: string;
}) {
  const base = `inline-flex shrink-0 items-center bg-surface !text-[#374151] transition-colors duration-150 ${SHAPE[variant]}`;
  if (!href) {
    return (
      <span role="link" aria-disabled="true" aria-label={label} title={title} className={`${base} cursor-not-allowed opacity-45`}>
        {children}
        {variant === "pill" && text}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={title}
      className={`${base} hover:border-[#9CA3AF] hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40`}
    >
      {children}
      {variant === "pill" && text}
    </a>
  );
}

/** The pair of chat buttons for a number. Renders nothing when there is no
 * number at all; disabled buttons (with the reason) when it cannot be used. */
export function ChatActions({
  phone,
  who,
  variant = "icon",
  className = "",
}: {
  phone: string | null | undefined;
  /** Name used in the accessible label ("Chat with Amina Hassan on WhatsApp"). */
  who?: string;
  variant?: Variant;
  className?: string;
}) {
  const links = chatLinks(phone);
  if (!links.ok && links.reason === "missing") return null;
  const target = who ? ` with ${who}` : "";
  const size = variant === "pill" ? 16 : 18;
  return (
    <span className={`inline-flex items-center ${variant === "field" ? "" : "gap-2"} ${className}`}>
      <ChatButton
        href={links.ok ? links.whatsapp : null}
        label={`Chat${target} on WhatsApp`}
        title={links.ok ? "Chat on WhatsApp" : CHAT_UNAVAILABLE_HINT}
        variant={variant}
        text="WhatsApp"
      >
        <WhatsAppMark width={size} height={size} />
      </ChatButton>
      <ChatButton
        href={links.ok ? links.telegram : null}
        label={`Chat${target} on Telegram`}
        title={links.ok ? "Chat on Telegram" : CHAT_UNAVAILABLE_HINT}
        variant={variant}
        text="Telegram"
      >
        <TelegramMark width={size} height={size} />
      </ChatButton>
    </span>
  );
}

/** A phone number with its chat buttons beneath it (design table cell). */
export function PhoneCell({ phone, who }: { phone: string | null | undefined; who?: string }) {
  if (!phone) return <span className="text-muted">Not given</span>;
  return (
    <span className="inline-flex flex-col items-start gap-2">
      <span className="tabular-nums">{phone}</span>
      <ChatActions phone={phone} who={who} />
    </span>
  );
}
