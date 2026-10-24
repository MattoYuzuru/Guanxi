/**
 * Тесты оценки влезаемости.
 *
 * Числа не выдуманы: это реальные замеры с MacBook M2 Pro 16 ГБ на Ollama 0.32.0,
 * снятые через /api/ps при разных значениях num_ctx.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@guanxi/contract'
import {
  calibrate,
  computeFit,
  extractArchParams,
  kvBytesPerToken,
} from '../src/hardware/fit.ts'

const M2_PRO_16GB: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'Apple M2 Pro',
  cpuCores: 10,
  totalMemoryBytes: 17_179_869_184,
  usableMemoryBytes: Math.floor(17_179_869_184 * 0.7),
  accelerator: 'metal',
  acceleratorName: 'Apple M2 Pro',
  unifiedMemory: true,
  freeDiskBytes: 302_000_000_000,
}

/** qwen2.5-coder:7b, Q4_K_M, вес файла 4 683 087 561 Б. */
const QWEN2_MODEL_BYTES = 4_683_087_561
const QWEN2_SAMPLES = [
  { contextLength: 4_096, sizeBytes: 4_638_040_390 },
  { contextLength: 16_384, sizeBytes: 5_024_964_934 },
  { contextLength: 32_768, sizeBytes: 5_540_864_326 },
]
const QWEN2_MODEL_INFO = {
  'general.architecture': 'qwen2',
  'qwen2.block_count': 28,
  'qwen2.attention.head_count': 28,
  'qwen2.attention.head_count_kv': 4,
  'qwen2.embedding_length': 3584,
  'qwen2.context_length': 32768,
}

/** Гибридная архитектура: 64 блока, но полный KV-кэш держат не все слои. */
const QWEN35_MODEL_INFO = {
  'general.architecture': 'qwen35',
  'qwen35.block_count': 64,
  'qwen35.attention.head_count': 24,
  'qwen35.attention.head_count_kv': 4,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.embedding_length': 5120,
}
const QWEN35_SAMPLES = [
  { contextLength: 4_096, sizeBytes: 4_495_004_138 },
  { contextLength: 16_384, sizeBytes: 4_756_613_364 },
]

describe('extractArchParams', () => {
  it('выводит размер головы из embedding_length, когда key_length не объявлен', () => {
    const params = extractArchParams(QWEN2_MODEL_INFO)
    assert.deepEqual(params, { blockCount: 28, headCountKv: 4, headDim: 128 })
  })

  it('предпочитает явный key_length расчёту через head_count', () => {
    // 5120 / 24 не делится нацело — вывод из embedding_length дал бы мусор.
    const params = extractArchParams(QWEN35_MODEL_INFO)
    assert.equal(params?.headDim, 256)
  })

  it('возвращает null, когда архитектура не указана', () => {
    assert.equal(extractArchParams({ 'llama.block_count': 32 }), null)
    assert.equal(extractArchParams(null), null)
  })
})

describe('kvBytesPerToken', () => {
  it('попадает в замер qwen2 с погрешностью меньше процента', () => {
    const params = extractArchParams(QWEN2_MODEL_INFO)!
    const predicted = kvBytesPerToken(params)
    const measured = 31_488 // (5 024 964 934 − 4 638 040 390) / (16384 − 4096)

    const error = Math.abs(predicted - measured) / measured
    assert.ok(error < 0.01, `погрешность ${(error * 100).toFixed(2)}% при предсказании ${predicted}`)
  })
})

describe('calibrate', () => {
  it('точно восстанавливает линейную зависимость по замерам qwen2', () => {
    const calibration = calibrate(QWEN2_SAMPLES)
    assert.ok(calibration)
    assert.equal(Math.round(calibration.bytesPerToken), 31_488)

    // Средняя точка не участвовала в выводе прямой — проверяем предсказание на ней.
    const predictedAt16k = calibration.baseBytes + calibration.bytesPerToken * 16_384
    assert.equal(Math.round(predictedAt16k), 5_024_964_934)
  })

  it('требует минимум две различные точки', () => {
    assert.equal(calibrate([]), null)
    assert.equal(calibrate([{ contextLength: 4_096, sizeBytes: 1_000 }]), null)
    assert.equal(
      calibrate([
        { contextLength: 4_096, sizeBytes: 1_000 },
        { contextLength: 4_096, sizeBytes: 1_000 },
      ]),
      null,
    )
  })
})

describe('computeFit', () => {
  it('калибровка по замерам вытесняет формулу и помечается как measured', () => {
    const verdict = computeFit({
      contextLength: 32_768,
      hardware: M2_PRO_16GB,
      modelBytes: QWEN2_MODEL_BYTES,
      modelInfo: QWEN2_MODEL_INFO,
      calibrationSamples: QWEN2_SAMPLES,
    })

    assert.equal(verdict.basis, 'measured')
    assert.equal(verdict.requiredBytes, 5_540_864_326)
    assert.equal(verdict.level, 'green')
  })

  it('спасает гибридную архитектуру, где формула завышает в разы', () => {
    const byFormula = computeFit({
      contextLength: 16_384,
      hardware: M2_PRO_16GB,
      modelBytes: 4_432_699_840,
      modelInfo: QWEN35_MODEL_INFO,
    })
    const byCalibration = computeFit({
      contextLength: 16_384,
      hardware: M2_PRO_16GB,
      modelBytes: 4_432_699_840,
      modelInfo: QWEN35_MODEL_INFO,
      calibrationSamples: QWEN35_SAMPLES,
    })

    /*
     * Формула насчитывает KV-кэш примерно в семь раз больше настоящего: она исходит
     * из того, что полный кэш держат все 64 блока, а в гибридной архитектуре это не так.
     */
    assert.equal(byFormula.basis, 'estimate')
    assert.ok(
      byFormula.kvCacheBytes > byCalibration.kvCacheBytes * 5,
      `формула ${byFormula.kvCacheBytes} против замера ${byCalibration.kvCacheBytes}`,
    )
    assert.equal(byCalibration.basis, 'measured')
    assert.equal(byCalibration.requiredBytes, 4_756_613_364)
    assert.equal(byCalibration.level, 'green')
  })

  it('загруженная модель с частичной выгрузкой на CPU — красный вердикт', () => {
    const verdict = computeFit({
      contextLength: 32_768,
      hardware: M2_PRO_16GB,
      modelBytes: QWEN2_MODEL_BYTES,
      loaded: { sizeBytes: 9_000_000_000, sizeVramBytes: 6_000_000_000 },
    })

    assert.equal(verdict.basis, 'measured')
    assert.equal(verdict.level, 'red')
    assert.equal(verdict.measured?.gpuPercent, 67)
    assert.match(verdict.summary, /CPU/)
  })

  it('модель целиком на ускорителе с запасом — зелёный', () => {
    const verdict = computeFit({
      contextLength: 16_384,
      hardware: M2_PRO_16GB,
      modelBytes: QWEN2_MODEL_BYTES,
      loaded: { sizeBytes: 5_024_964_934, sizeVramBytes: 5_024_964_934 },
    })

    assert.equal(verdict.level, 'green')
    assert.equal(verdict.measured?.processorLabel, '100% GPU')
  })

  it('облачная модель не расходует локальную память', () => {
    const verdict = computeFit({
      contextLength: 262_144,
      hardware: M2_PRO_16GB,
      modelBytes: 0,
      isCloud: true,
    })

    assert.equal(verdict.level, 'green')
    assert.equal(verdict.requiredBytes, 0)
  })

  it('огромное окно на слабом железе даёт красный вердикт', () => {
    const verdict = computeFit({
      contextLength: 262_144,
      hardware: M2_PRO_16GB,
      modelBytes: QWEN2_MODEL_BYTES,
      modelInfo: QWEN2_MODEL_INFO,
    })

    assert.equal(verdict.level, 'red')
    assert.ok(verdict.utilization > 1)
  })

  it('без данных о модели честно сообщает, что оценить нечем', () => {
    const verdict = computeFit({
      contextLength: 8_192,
      hardware: M2_PRO_16GB,
      modelBytes: 1_000_000_000,
      modelInfo: null,
    })

    assert.equal(verdict.level, 'unknown')
  })
})

describe('fit reason codes (localised by the client, never node prose)', () => {
  const usable = M2_PRO_16GB.usableMemoryBytes
  const base = { contextLength: 4_096, hardware: M2_PRO_16GB, modelBytes: QWEN2_MODEL_BYTES }
  const cases: Array<[string, Parameters<typeof computeFit>[0], string]> = [
    ['cloud', { ...base, isCloud: true }, 'cloud'],
    ['loaded, partly on the CPU', { ...base, loaded: { sizeBytes: 8_000_000_000, sizeVramBytes: 4_000_000_000 } }, 'loaded_partial_gpu'],
    ['loaded, fully on the accelerator with headroom', { ...base, loaded: { sizeBytes: 5_000_000_000, sizeVramBytes: 5_000_000_000 } }, 'loaded_on_accelerator'],
    ['loaded, fully on the accelerator but tight', { ...base, loaded: { sizeBytes: Math.round(usable * 0.95), sizeVramBytes: Math.round(usable * 0.95) } }, 'loaded_tight'],
    ['calibrated with headroom', { ...base, calibrationSamples: QWEN2_SAMPLES }, 'headroom'],
    ['formula, tight', { ...base, modelBytes: Math.round(usable * 0.9), modelInfo: QWEN2_MODEL_INFO }, 'tight'],
    ['formula, spills to the CPU', { ...base, contextLength: 1_048_576, modelInfo: QWEN2_MODEL_INFO }, 'spills_to_cpu'],
    ['vendor hint within memory', { ...base, vramHintBytes: 2_000_000_000 }, 'vendor_requires'],
    ['vendor hint over memory', { ...base, vramHintBytes: usable * 2 }, 'vendor_exceeds'],
    ['no model data', { ...base }, 'insufficient_data'],
  ]
  for (const [name, input, reason] of cases) {
    it(`${name}: ${reason}`, () => {
      assert.equal(computeFit(input).reason, reason)
    })
  }
  it('covers every code of the contract enum', async () => {
    const { fitReasonSchema } = await import('@guanxi/contract')
    assert.deepEqual([...new Set(cases.map(([, , reason]) => reason))].sort(), [...fitReasonSchema.options].sort())
  })
})
