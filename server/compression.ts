import { brotliCompress, constants, gzip } from 'node:zlib'

export type ContentEncoding = 'br' | 'gzip'

/** Bodies below this size gain nothing worth the work. */
export const COMPRESS_MIN_BYTES = 1024

/**
 * The best encoding the browser accepts, from its `Accept-Encoding` header: Brotli before gzip.
 * An encoding listed with `q=0` is refused, and null means the body is sent as it is.
 */
export function acceptedEncoding(header: string | string[] | undefined): ContentEncoding | null {
  const accepted = new Set<string>()
  for (const part of (Array.isArray(header) ? header.join(',') : header || '').split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';')
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='))
    if (name && (!quality || Number(quality.slice(2)) > 0)) accepted.add(name)
  }
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null
}

/**
 * Compresses a body off the main thread. `fast` suits a response built for one request; `small` spends
 * more time on a file that is compressed once and served many times.
 */
export function compress(body: Buffer, encoding: ContentEncoding, effort: 'fast' | 'small'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer) => (error ? reject(error) : resolve(result))
    if (encoding === 'br')
      brotliCompress(
        body,
        {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: effort === 'small' ? constants.BROTLI_MAX_QUALITY : 4,
            [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        },
        done,
      )
    else gzip(body, { level: effort === 'small' ? 9 : 6 }, done)
  })
}
