import { notFound } from "next/navigation";

import { UnknownProjectError } from "@/lib/pipeline";

/** Loads project-scoped data or renders the 404 page for unknown ids. */
export async function loadProjectOrNotFound<T>(
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      notFound();
    }
    throw error;
  }
}
