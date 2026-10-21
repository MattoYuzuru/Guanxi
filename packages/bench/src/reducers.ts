// Copyright (c) 2024 UK AI Security Institute
// MIT License (LICENSE.inspect-ai). Modified by Guanxi contributors.
// Ported scalar pass_k estimator from inspect_ai/scorer/_reducer/reducer.py,
// 5e06ec2d8ba569c4ec867bfd48a7d66cda53c370. Binary, finite scores only.
import { binary, mean } from './stats.ts'
export { mean }
/** Probability all k attempts pass, drawing without replacement. Not pass@k. */
export function passHat(scores: number[], k: number): number | null {
  binary(scores)
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('invalid_k')
  if (scores.length < k) return null
  const correct = scores.filter(x => x === 1).length
  if (correct < k) return 0
  let result = 1
  for (let i = 0; i < k; i++) result *= (correct - i) / (scores.length - i)
  return result
}
