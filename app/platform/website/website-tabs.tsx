import { TabLinks } from "@/app/academy/_shell/page-blocks";

/** Platform -> Website settings sub-navigation. */
export function WebsiteTabs({ current }: { current: "contact" | "messages" }) {
  return (
    <TabLinks
      label="Website settings"
      current={current}
      tabs={[
        { key: "contact", label: "Contact information", href: "/platform/website/contact" },
        { key: "messages", label: "Contact messages", href: "/platform/website/messages" },
      ]}
    />
  );
}
