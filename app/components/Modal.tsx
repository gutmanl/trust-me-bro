"use client";

import { useEffect, useRef } from "react";

/**
 * The one modal primitive of the app (source work items — first overlay in
 * the codebase, so the conventions live here): a native `<dialog>` opened
 * with showModal(), which hands focus trapping, ESC handling and the
 * backdrop to the browser instead of re-implementing them. Mounting the
 * component IS opening the dialog — parents render it conditionally and
 * pass `onClose` to unmount it again; the native close event (ESC) and a
 * click on the backdrop (the dialog element itself, never its content)
 * both route through the same `onClose`.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) {
          onClose();
        }
      }}
      className="m-auto w-[36rem] max-w-[92vw] rounded-md border border-slate-200 bg-white p-0 shadow-lg backdrop:bg-slate-900/40"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="rounded px-1.5 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          ×
        </button>
      </div>
      <div className="max-h-[80vh] overflow-y-auto p-4">{children}</div>
    </dialog>
  );
}
