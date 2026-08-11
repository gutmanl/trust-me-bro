import { getActiveRun } from "@/lib/pipeline";

import { RunStatusProvider } from "./RunStatusProvider";

export const dynamic = "force-dynamic";

/**
 * Wraps every project page with the run-status provider, so the shared status
 * bar and the global start-gating see one truth for "what is running for this
 * project". The snapshot is read server-side on each render (force-dynamic);
 * the provider then follows the live stream.
 */
export default async function ProjectLayout(
  props: LayoutProps<"/projects/[id]">,
) {
  const { id } = await props.params;
  return (
    <RunStatusProvider projectId={id} initial={getActiveRun(id)}>
      {props.children}
    </RunStatusProvider>
  );
}
