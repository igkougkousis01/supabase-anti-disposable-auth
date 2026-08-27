/**
 * Captures the error a promise rejects with, typed.
 *
 * `promise.catch((error) => error as E)` widens to `E | <resolved type>`, which makes
 * every assertion on the error need a cast. This narrows properly, and fails loudly if
 * the operation unexpectedly succeeds -- a test asserting on an error message must never
 * pass quietly because nothing was thrown.
 */
export async function rejection<E>(promise: Promise<unknown>): Promise<E> {
  const resolved = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => resolved,
    (error: unknown) => error,
  );

  if (outcome === resolved) {
    throw new Error('Expected the operation to reject, but it resolved.');
  }

  return outcome as E;
}
