export async function runBatch(items, concurrency, run, onResult = () => {}) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { value: await run(items[index]) };
      } catch (error) {
        results[index] = { error: error.message };
      }
      onResult(results[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
