import { cn } from "@/lib/utils";
import { HeaderStatus } from "@/components/ui/header-status";

/**
 * Shared workspace title card with room for dates, context and page actions.
 */
export function PageHeader({
  title,
  meta,
  description,
  actions,
  reserveStatus = false,
  className,
}: {
  title: string;
  /** Short facts in mono uppercase, e.g. "Crawl 13 Sep 14:02 · 42 pages". */
  meta?: React.ReactNode;
  /** A sentence of explanation in plain text. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Always keep room for the status row, for headers whose actions report back (Sync GSC). */
  reserveStatus?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("workspace-heading mb-6 rounded-2xl border border-border p-5 sm:p-6", className)}>
      <HeaderStatus reserve={reserveStatus}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-[26px] leading-[1.2] font-semibold tracking-[-0.03em] break-words text-text-strong sm:text-[30px]">
              {title}
            </h1>
            {meta && (
              <p className="mono-label text-[12px] leading-[18px] text-muted-foreground">{meta}</p>
            )}
            {description && (
              <p className="max-w-[760px] text-[14px] leading-[22px] text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>
          )}
        </div>
      </HeaderStatus>
    </div>
  );
}
