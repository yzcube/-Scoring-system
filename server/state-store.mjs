export function createStateStore({ readState, writeState, sanitizeState, assertQueuedSession, revokeSession }) {
  let writeQueue = Promise.resolve();

  function requireStateObject(value, source) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${source} must return a state object`);
    }
    return value;
  }

  async function queueSessionRevocation(session) {
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        await revokeSession(session);
      });
    return writeQueue;
  }

  async function updateState(updater, mutation, session, allowedRoles = []) {
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        if (allowedRoles.length && !session) {
          const error = new Error("登录已失效，请重新登录");
          error.status = 401;
          throw error;
        }
        const state = await readState();
        await assertQueuedSession(state, session, allowedRoles);
        const updatedState = requireStateObject(await updater(state), "State updater");
        const nextState = requireStateObject(sanitizeState(updatedState), "State sanitizer");
        const resolvedMutation = typeof mutation === "function" ? mutation(nextState) : mutation;
        if (resolvedMutation?.type === "noop") return nextState;
        await writeState(nextState, resolvedMutation);
        return nextState;
      });
    return writeQueue;
  }

  async function applyContestControl(control, session, allowedRoles = []) {
    let outcome = null;
    const state = await updateState(
      (currentState) => {
        outcome = control(currentState);
        return currentState;
      },
      () => outcome.mutation,
      session,
      allowedRoles,
    );
    return { state, outcome };
  }

  return { applyContestControl, queueSessionRevocation, updateState };
}
