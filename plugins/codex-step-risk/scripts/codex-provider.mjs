import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

function stringValue(source) {
  const value = source.trim()
  const basic = value.match(/^("(?:\\.|[^"\\])*")(?:\s*(?:#.*)?)?$/)
  if (basic) {
    try { return JSON.parse(basic[1]) } catch { return null }
  }
  const literal = value.match(/^'([^']*)'(?:\s*(?:#.*)?)?$/)
  return literal ? literal[1] : null
}

function providerSettings(configText) {
  let section = ''
  let selected = ''
  const providers = new Map()
  for (const line of configText.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
    if (header) {
      section = header[1]
      continue
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/)
    if (!assignment) continue
    const value = stringValue(assignment[2])
    if (typeof value !== 'string') continue
    if (!section && assignment[1] === 'model_provider') selected = value
    const provider = section.match(/^model_providers\.(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')$/)
    if (provider && ['base_url', 'env_key', 'wire_api'].includes(assignment[1])) {
      const name = provider[1] || provider[2] || provider[3]
      if (!providers.has(name)) providers.set(name, {})
      providers.get(name)[assignment[1]] = value
    }
  }
  return { selected, providers }
}

function responsesUrl(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return null
  url.pathname = url.pathname.replace(/\/+$/, '') + '/responses'
  return url.toString()
}

export function resolveCodexLunaConnection(configText, env = process.env) {
  const { selected, providers } = providerSettings(configText)
  if (!selected || selected === 'openai') return {
    provider: 'openai', host: 'api.openai.com',
    apiUrl: OPENAI_RESPONSES_URL, apiKey: env.OPENAI_API_KEY || '',
  }
  const settings = providers.get(selected)
  const apiUrl = settings?.wire_api && settings.wire_api !== 'responses'
    ? null : responsesUrl(settings?.base_url)
  const envKey = settings?.env_key
  const apiKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey || '')
    ? env[envKey] || '' : ''
  return {
    provider: selected,
    host: apiUrl ? new URL(apiUrl).host : '',
    apiUrl,
    apiKey: apiUrl ? apiKey : '',
  }
}

export function loadCodexLunaConnection(env = process.env) {
  const customHome = env.CODEX_HOME
  const codexHome = customHome && isAbsolute(customHome)
    ? customHome : join(homedir(), '.codex')
  let configText = ''
  try { configText = readFileSync(join(codexHome, 'config.toml'), 'utf8') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  return resolveCodexLunaConnection(configText, env)
}
