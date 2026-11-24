"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import { Icon } from "@/app/academy/_shell/icons";

/**
 * A student's photo full screen: dark backdrop, the whole photo (never
 * cropped), name underneath. A click (mouse) or tap (touch) anywhere,
 * on the photo too, closes it, as do Escape and the close button. Radix handles focus, scroll lock and the
 * portal.
 */
export function PhotoLightbox({
  open,
  onOpenChange,
  photoUrl,
  fullName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photoUrl: string;
  fullName: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-[rgba(10,12,16,0.92)] motion-safe:animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onClick={() => onOpenChange(false)}
          className="fixed inset-0 z-[70] flex cursor-zoom-out flex-col items-center justify-center gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(4rem,env(safe-area-inset-top))] focus:outline-none sm:p-10"
        >
          <DialogPrimitive.Title className="sr-only">{`${fullName}'s photo`}</DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Close photo"
            className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors duration-150 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Icon name="close" width={22} height={22} />
          </DialogPrimitive.Close>
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 URL, like every student photo in this app. */}
          <img
            src={photoUrl}
            alt={`${fullName}'s profile photo`}
            draggable={false}
            className="max-h-[calc(100dvh-9rem)] max-w-full select-none rounded-xl object-contain shadow-[0_24px_64px_rgba(0,0,0,0.5)] motion-safe:animate-scale-in"
          />
          <p className="max-w-full truncate text-center text-[15px] font-semibold text-white">{fullName}</p>
          {/* Mouse: "Click … or press Esc"; touch screens: "Tap …". */}
          <p className="text-xs text-white/70">
            <span className="[@media(pointer:fine)]:hidden">Tap anywhere to close</span>
            <span className="hidden [@media(pointer:fine)]:inline">Click anywhere or press Esc to close</span>
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
