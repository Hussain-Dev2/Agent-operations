import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DeviceView } from "./device-view";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("devices") };
}

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeviceView id={id} />;
}
