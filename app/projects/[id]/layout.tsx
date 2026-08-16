import { ProjectEventStreamProvider } from "@/app/lib/ProjectEventStream";
import { getProjectActivity } from "@/lib/pipeline";

import { RunStatusProvider } from "./RunStatusProvider";

export const dynamic = "force-dynamic";

/**
 * Wraps every project page with the ONE project event stream (all runs, all
 * kinds — panels subscribe to it instead of opening their own EventSource)
 * and, inside it, the run-status bar and start-gating. The snapshot is read
 * server-side on each render (force-dynamic); the stream takes it from there.
 */
export default async function ProjectLayout(
  props: LayoutProps<"/projects/[id]">,
) {
  const { id } = await props.params;
  return (
    <ProjectEventStreamProvider
      projectId={id}
      initialActivity={getProjectActivity(id)}
    >
      <RunStatusProvider projectId={id}>{props.children}</RunStatusProvider>
    </ProjectEventStreamProvider>
  );
}
