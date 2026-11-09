import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DevicesView } from "./devices-view";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("devices") };
}

export default function DevicesPage() {
  return <DevicesView />;
}
