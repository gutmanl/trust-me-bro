/**
 * Signals that the subscription quota, not the request, is the problem —
 * shared by all CLI backends. Deliberately broad: a missed rate limit
 * escalates a claim spuriously, while a false positive merely pauses the
 * run resumably.
 */
export const RATE_LIMIT_PATTERN =
  /rate.?limit|usage limit|too many requests|quota|overloaded|429|resets at/i;
