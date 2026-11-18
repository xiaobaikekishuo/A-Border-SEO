import { PageLoading } from "@/components/layout/page-loading";

// Each site page gets a fresh loading boundary when its menu segment changes.
export default function SitePageLoading() {
  return <PageLoading />;
}
