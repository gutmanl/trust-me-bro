import { PipelineError } from "@/lib/pipeline";

/**
 * Single policy for running a pipeline use-case inside a server action:
 * PipelineError is the user-facing outcome vocabulary and becomes form
 * state; everything else is a programming error and propagates.
 */
export async function runPipelineAction<T>(
  work: () => Promise<T>,
): Promise<{ error: string } | { error: null; value: T }> {
  try {
    return { error: null, value: await work() };
  } catch (error) {
    if (error instanceof PipelineError) {
      return { error: error.message };
    }
    throw error;
  }
}
