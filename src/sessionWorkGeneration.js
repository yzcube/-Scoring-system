export function createOperationGeneration() {
  let current = 0;

  return {
    begin() {
      current += 1;
      return current;
    },
    invalidate() {
      current += 1;
    },
    isCurrent(operation) {
      return operation === current;
    },
  };
}
