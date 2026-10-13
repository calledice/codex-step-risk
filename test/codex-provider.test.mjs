import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodexLunaConnection } from '../plugins/codex-step-risk/scripts/codex-provider.mjs'

const config = `
model_provider = "gateway"

[model_providers.gateway]
base_url = "https://gateway.example/v1" # custom Responses endpoint
env_key = "GATEWAY_KEY"
wire_api = "responses"

[model_providers.other]
base_url = "https://other.example/v1"
env_key = "OTHER_KEY"
`

test('Luna follows the selected Codex provider endpoint and key source', () => {
  const connection = resolveCodexLunaConnection(config, {
    GATEWAY_KEY: 'synthetic-gateway-key', OTHER_KEY: 'synthetic-other-key',
    OPENAI_API_KEY: 'synthetic-openai-key',
  })
  assert.deepEqual(connection, {
    provider: 'gateway', host: 'gateway.example',
    apiUrl: 'https://gateway.example/v1/responses',
    apiKey: 'synthetic-gateway-key',
  })
})

test('a missing provider key or insecure endpoint disables Luna', () => {
  assert.equal(resolveCodexLunaConnection(config, {}).apiKey, '')
  const insecure = config.replace('https://gateway.example', 'http://gateway.example')
  assert.equal(resolveCodexLunaConnection(insecure, { GATEWAY_KEY: 'synthetic' }).apiUrl, null)
  assert.equal(resolveCodexLunaConnection(insecure, { GATEWAY_KEY: 'synthetic' }).apiKey, '')
})

test('the built-in OpenAI provider uses the OpenAI API key', () => {
  assert.deepEqual(resolveCodexLunaConnection('model = "gpt-6-luna"', {
    OPENAI_API_KEY: 'synthetic-openai-key',
  }), {
    provider: 'openai', host: 'api.openai.com',
    apiUrl: 'https://api.openai.com/v1/responses',
    apiKey: 'synthetic-openai-key',
  })
})
