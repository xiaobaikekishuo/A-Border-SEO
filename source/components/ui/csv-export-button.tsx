"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

interface CsvExportButtonProps {
  siteId: string;
  type: "keywords" | "pages";
  label?: string;
}

export function CsvExportButton({ siteId, type, label }: CsvExportButtonProps) {
  const ui = useUiText();
  return (
    <a
      href={`/api/sites/${siteId}/export?type=${type}`}
      download
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <Download className="size-3.5" aria-hidden />
      {label ?? ui("Export {0} CSV", { "0": type === "keywords" ? ui("Keywords").toLowerCase() : ui("Pages").toLowerCase() })}
    </a>
  );
}
