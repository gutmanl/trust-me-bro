"use client";

import { useActionState, useState } from "react";

import { ErrorBanner, primaryButtonClass } from "@/app/components/ui";
import type { Claim, ComplaintCategory } from "@/lib/pipeline";
import {
  COMPLAINT_CATEGORY_LABELS,
  COMPLAINT_CATEGORY_ORDER,
} from "./complaint-labels";
import type { DecisionFormState } from "./actions";
import { complainClaimAction, confirmClaimAction } from "./actions";

const initialState: DecisionFormState = { error: null };

/**
 * The adjudication actions of the detail panel (TMB-35): a confirmation
 * button plus the "Etwas stimmt nicht" complaint dialog with the taxonomy
 * categories in examiner language, multi-select, and a justification that
 * becomes mandatory with "Sonstiges". Discarding is deliberately absent —
 * every negative decision routes through beanstandet (repair first). The
 * measured duration enters as a hidden field, written at submit time.
 */
export function ComplaintDialog({
  projectId,
  claim,
  currentSeconds,
}: {
  projectId: string;
  claim: Claim;
  currentSeconds: () => number;
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<ComplaintCategory[]>([]);
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmClaimAction.bind(null, projectId, claim.id),
    initialState,
  );
  const [complainState, complainAction, complainPending] = useActionState(
    complainClaimAction.bind(null, projectId, claim.id),
    initialState,
  );

  const pending = confirmPending || complainPending;
  const sonstigesChecked = checked.includes("sonstiges");

  const toggle = (category: ComplaintCategory): void => {
    setChecked((previous) =>
      previous.includes(category)
        ? previous.filter((entry) => entry !== category)
        : [...previous, category],
    );
  };

  const stampDuration = (form: HTMLFormElement): void => {
    const input = form.elements.namedItem("duration_s");
    if (input instanceof HTMLInputElement) {
      input.value = String(currentSeconds());
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap gap-2">
        <form
          action={confirmAction}
          onSubmit={(event) => stampDuration(event.currentTarget)}
        >
          <input type="hidden" name="duration_s" value="" readOnly />
          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClass}
          >
            {confirmPending ? "Wird bestätigt …" : "Bestätigen"}
          </button>
        </form>
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen((previous) => !previous)}
          className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
        >
          ⚠ Etwas stimmt nicht {open ? "▴" : "▾"}
        </button>
      </div>

      <ErrorBanner message={confirmState.error} />

      {open ? (
        <form
          action={complainAction}
          onSubmit={(event) => stampDuration(event.currentTarget)}
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
        >
          <input type="hidden" name="duration_s" value="" readOnly />
          <div>
            <p className="text-sm font-medium text-slate-800">
              Warum stimmt etwas nicht?
            </p>
            <p className="text-xs text-slate-500">
              Wähle alle zutreffenden Punkte aus.
            </p>
          </div>
          <div className="space-y-1.5">
            {COMPLAINT_CATEGORY_ORDER.map((category) => (
              <label
                key={category}
                className="flex items-center gap-2 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  name="categories"
                  value={category}
                  checked={checked.includes(category)}
                  onChange={() => toggle(category)}
                  className="rounded border-slate-300"
                />
                {COMPLAINT_CATEGORY_LABELS[category]}
              </label>
            ))}
          </div>
          <div>
            <label
              htmlFor={`justification-${claim.id}`}
              className="text-xs font-medium text-slate-600"
            >
              Begründung {sonstigesChecked ? "(erforderlich)" : "(optional)"}
            </label>
            <textarea
              id={`justification-${claim.id}`}
              name="justification"
              rows={3}
              required={sonstigesChecked}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <ErrorBanner message={complainState.error} />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending || checked.length === 0}
              className={primaryButtonClass}
            >
              {complainPending ? "Wird übertragen …" : "Überarbeiten"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setChecked([]);
              }}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              Abbrechen
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
