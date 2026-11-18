import { PageLoading } from "@/components/layout/page-loading";

// Only the page segment is replaced; the existing AppShell stays interactive.
export default function DashboardLoading() {
  return <PageLoading />;
}
