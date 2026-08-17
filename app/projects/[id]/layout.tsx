import type { Metadata } from "next";

import { ProjectEventStreamProvider } from "@/app/lib/ProjectEventStream";
import { getProjectActivity, getProjectSummary } from "@/lib/pipeline";

import { RunStatusProvider } from "./RunStatusProvider";

export const dynamic = "force-dynamic";

/** Longest research question a browser tab still shows something useful of. */
const TITLE_MAX = 60;

/**
 * Titles every page of a project with its research question, and hands the
 * side views a template so theirs read "Verlauf · <Frage>". Without it every
 * tab of every project read "TrustMeBro" and none could be told apart.
 */
export async function generateMetadata(
  props: LayoutProps<"/projects/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  let question: string;
  try {
    question = (await getProjectSummary(id)).research_question;
  } catch {
    // An unreadable or missing project renders `not-found`; a thrown title
    // would replace that page with an error boundary.
    return { title: id };
  }
  const short =
    question.length > TITLE_MAX
      ? `${question.slice(0, TITLE_MAX - 1).trimEnd()}…`
      : question;
  return { title: { default: short, template: `%s · ${short}` } };
}

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
