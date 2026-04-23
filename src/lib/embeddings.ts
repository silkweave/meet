import OpenAI from 'openai'
import { MeetClient } from '../classes/MeetClient.js'
import { EMBEDDING_DIM } from './transcriptDb.js'

const MAX_INPUT_CHARS = 24000

let client: OpenAI | undefined
let clientForKey: string | undefined

function getClient(): OpenAI | undefined {
  const { apiKey } = MeetClient.getOpenAIConfig()
  if (!apiKey) { return undefined }
  if (client && clientForKey === apiKey) { return client }
  client = new OpenAI({ apiKey })
  clientForKey = apiKey
  return client
}

export function isEmbeddingEnabled(): boolean {
  return !!MeetClient.getOpenAIConfig().apiKey
}

export function zeroEmbedding(): number[] {
  return new Array(EMBEDDING_DIM).fill(0)
}

export async function embedText(text: string): Promise<number[] | undefined> {
  const openai = getClient()
  if (!openai) { return undefined }
  const input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text
  if (!input.trim()) { return undefined }
  const { embeddingModel } = MeetClient.getOpenAIConfig()
  const model = embeddingModel ?? 'text-embedding-3-small'
  const params: { model: string; input: string; dimensions?: number } = { model, input }
  if (model.startsWith('text-embedding-3-')) { params.dimensions = EMBEDDING_DIM }
  const res = await openai.embeddings.create(params)
  const vec = res.data[0]?.embedding
  if (!vec) { return undefined }
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding model ${model} returned ${vec.length} dims; schema is ${EMBEDDING_DIM}. Use text-embedding-3-small, text-embedding-3-large (with dimensions=${EMBEDDING_DIM}), or text-embedding-ada-002.`)
  }
  return vec
}
