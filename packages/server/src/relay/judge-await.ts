/** Pure observation/admission only. Never use this to release ownership of an active
 * process, transport, governor permit or inference stream before it actually settles. */
export function observeUntilAbort<T>(signal: AbortSignal, observe: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (body: () => void) => {
      if (done) return
      done = true
      signal.removeEventListener('abort', abort)
      body()
    }
    const abort = () => finish(() => reject(signal.reason))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    let pending: Promise<T>
    try {
      pending = observe()
    } catch (error) {
      finish(() => reject(error))
      return
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}
