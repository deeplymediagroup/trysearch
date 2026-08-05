"use client";

/** The one interactive bit of /client-reports: hand the page to the browser's print dialog. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="h-8 rounded-[8px] bg-[var(--primary)] px-3.5 text-[12.5px] font-medium text-white hover:opacity-90 print:hidden"
    >
      Print / PDF
    </button>
  );
}
