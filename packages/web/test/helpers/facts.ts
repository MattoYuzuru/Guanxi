/** The label/value pairs of every fact list (`dl.model-facts`) under `root`, in document order. */
export function factPairs(root: ParentNode = document.body): Array<[string, string]> {
  return [...root.querySelectorAll('dl.model-facts .model-fact')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ])
}
