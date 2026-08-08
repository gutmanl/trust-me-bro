"use client";

import { useState } from "react";

import type { QueueEntry, QueueRoutingFilter } from "@/lib/pipeline";
// Sanctioned deep import (pinned in architecture.test.ts): pure queue
// filter/sort shared with the server side, client-safe past the barrel.
import { filterQueue, sortQueue } from "@/lib/pipeline/adjudication/queue";
import { formatTimestamp } from "../../status-labels";
import { ROUTING_LABELS, ROUTING_ORDER } from "./routing-labels";

type QueueSort = "wartezeit" | "routing";

/**
 * Adjudication queue (TMB-36): all claims awaiting adjudication with their
 * routing reason, filterable and sortable by it. Selection drives the same
 * detail panel as the briefing markers; the decision itself happens there.
 */
export function QueuePanel({
  entries,
  selectedClaimId,
  onSelect,
}: {
  entries: QueueEntry[];
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
}) {
  const [filter, setFilter] = useState<QueueRoutingFilter>("alle");
  const [sort, setSort] = useState<QueueSort>("wartezeit");

  const sorted = sortQueue(filterQueue(entries, filter), sort, ROUTING_ORDER);

  return (
    <section className="rounded-md border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">
          Warteschlange ({entries.length})
        </h2>
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-xs text-slate-500">
            Routing-Grund
            <select
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as QueueRoutingFilter)
              }
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="alle">alle</option>
              {ROUTING_ORDER.map((routing) => (
                <option key={routing} value={routing}>
                  {ROUTING_LABELS[routing]}
                </option>
              ))}
              <option value="ohne_zuordnung">ohne Zuordnung</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">
            Sortierung
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as QueueSort)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="wartezeit">nach Wartezeit</option>
              <option value="routing">nach Routing-Grund</option>
            </select>
          </label>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-slate-500">
          {entries.length === 0
            ? "Kein Claim zur Adjudikation offen."
            : "Kein Claim entspricht dem Filter."}
        </p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-slate-100 overflow-y-auto">
          {sorted.map((entry) => (
            <li key={entry.claim.id}>
              <button
                type="button"
                onClick={() => onSelect(entry.claim.id)}
                className={`w-full px-4 py-3 text-left hover:bg-slate-50 ${
                  entry.claim.id === selectedClaimId ? "bg-slate-100" : ""
                }`}
              >
                <p className="line-clamp-2 text-xs text-slate-800">
                  {entry.claim.text}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
                    {entry.routing
                      ? ROUTING_LABELS[entry.routing]
                      : "ohne Zuordnung"}
                  </span>
                  <span className="text-slate-400">
                    seit {formatTimestamp(entry.queuedAt)}
                  </span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
