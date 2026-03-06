export function bpsToFrac(bps){ return (bps||0) / 10000; }

// mid = bar.c (or chosen price)
// buy fills at ask, sell fills at bid, then apply slippage + fees
export function effectiveFill({ side, mid, spreadBps=0, slippageBps=0, feeBps=0 }) {
  const spread = mid * bpsToFrac(spreadBps);
  const slip = mid * bpsToFrac(slippageBps);
  const fee = mid * bpsToFrac(feeBps);

  let price = mid;
  if (side === "buy") price = mid + spread*0.5 + slip;
  if (side === "sell") price = mid - spread*0.5 - slip;

  // fees hurt both sides (approx; you can split maker/taker later)
  price = (side === "buy") ? (price + fee) : (price - fee);

  return price;
}
