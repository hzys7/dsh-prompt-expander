/**
 * Bounded request-body reader.
 *
 * Reads at most `limit` bytes and rejects the moment the stream exceeds it, so
 * an oversized draft cannot grow the buffer without bound.
 *
 * @module dsh-prompt-boost/body
 */

/**
 * Collect a request body as UTF-8 text.
 * @param request - the incoming HTTP request.
 * @param limit - the maximum accepted byte count.
 * @returns the decoded body.
 * @throws {Error} when the body exceeds `limit`.
 */
export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new Error(`request body exceeds ${limit} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', fail)
  })
}
