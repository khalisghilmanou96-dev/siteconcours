import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'data', 'store.json')
const initial = { nextTicket: 1, payments: {}, pending: {}, processedEvents: {} }
let queue = Promise.resolve()

async function readStore() {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(initial, null, 2))
    return structuredClone(initial)
  }
}

async function writeStore(data) {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2))
  await fs.rename(tmp, file)
}

export function transaction(fn) {
  const run = queue.then(async () => {
    const data = await readStore()
    const result = await fn(data)
    await writeStore(data)
    return result
  })
  queue = run.catch(() => {})
  return run
}

export async function snapshot() { return readStore() }
