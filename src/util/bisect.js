export function bisectByT(arr, t) {
  // arr must be sorted by .t; null entries are treated as not-yet-set and skipped.
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const entry = arr[mid];
    if (entry == null || entry.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
