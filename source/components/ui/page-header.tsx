import { cn } from "@/lib/utils";
import { HeaderStatus } from "@/components/ui/header-status";

/**
 * Shared page header: the title on the page itself (no card), short facts and
 * a sentence of context below it, and the page actions on the right.
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
  /** Short facts, e.g. "Crawl 13 Sep 14:02 · 42 pages". */
  meta?: React.ReactNode;
  /** A sentence of explanation in plain text. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Always keep room for the status row, for headers whose actions report back (Sync GSC). */
  reserveStatus?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("workspace-heading mb-6 pb-1", className)}>
      <HeaderStatus reserve={reserveStatus}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.01em] break-words text-text-strong">
              {title}
            </h1>
            {meta && (
              <p className="text-[13px] leading-5 text-muted-foreground">{meta}</p>
            )}
            {description && (
              <p className="max-w-[760px] text-[13.5px] leading-[22px] text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      </HeaderStatus>
    </div>
  );
}
