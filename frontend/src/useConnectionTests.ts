import { useRef, useState } from 'react'
import * as api from './api'
import { useToast } from './components/Toast'
import type { ConnectionState, ServiceStatus } from './components/config/parts'
import { SERVICE_IDS, SERVICES, type ConfigDraft, type Service } from './config-services'
import type { SecretConfigKey } from '../../shared/contracts.js'
import { errorMessage } from '../../shared/errors.js'

const forEachService = <Value>(value: () => Value) =>
  Object.fromEntries(SERVICE_IDS.map(service => [service, value()])) as Record<Service, Value>

/** Connection tests of the draft settings, one result per integration. */
export function useConnectionTests(form: ConfigDraft, clearedSecrets: Set<SecretConfigKey>) {
  const [connections, setConnections] = useState(() => forEachService<ConnectionState>(() => ({ phase: 'idle' })))
  const [testingAll, setTestingAll] = useState(false)
  // A result only counts while it is the latest test of settings that have not changed since.
  const generation = useRef(forEachService(() => 0))
  const toast = useToast()

  const show = (service: Service, state: ConnectionState) =>
    setConnections(current => ({ ...current, [service]: state }))

  /** A changed setting voids the last result for its service, including one still on its way. */
  const invalidate = (service: Service) => {
    generation.current[service] += 1
    show(service, { phase: 'idle' })
  }

  const test = async (service: Service, quiet = false): Promise<boolean> => {
    const started = ++generation.current[service]
    show(service, { phase: 'testing' })
    try {
      const result = await api.testConnection(service, { ...form, clear_secrets: [...clearedSecrets] })
      if (started !== generation.current[service]) return false
      show(service, { phase: 'success', message: result.message })
      if (!quiet) toast.show(result.message, 'success')
      return true
    } catch (error) {
      if (started !== generation.current[service]) return false
      const message = errorMessage(error)
      show(service, { phase: 'error', message })
      if (!quiet) toast.show(`${SERVICES[service].label}: ${message}`, 'error')
      return false
    }
  }

  const testAll = async (services: Service[]) => {
    if (!services.length) {
      toast.show('Configure at least one integration before testing connections', 'info')
      return
    }
    setTestingAll(true)
    const outcomes = await Promise.all(services.map(service => test(service, true)))
    const passed = outcomes.filter(Boolean).length
    toast.show(
      `${passed}/${outcomes.length} configured integration${outcomes.length === 1 ? '' : 's'} connected`,
      passed === outcomes.length ? 'success' : 'error',
    )
    setTestingAll(false)
  }

  /** One word for where an integration stands: the last test if there is one, otherwise how far it is set up. */
  const describe = (service: Service): ServiceStatus => {
    const { phase } = connections[service]
    if (phase === 'success') return { word: 'Connected', tone: 'good' }
    if (phase === 'error') return { word: 'Failed', tone: 'bad' }
    if (phase === 'testing') return { word: 'Testing…', tone: 'busy' }
    const { enabledBy, configured } = SERVICES[service]
    if (enabledBy && !form[enabledBy]) return { word: 'Disabled', tone: 'dim' }
    return configured(form) ? { word: 'Not tested', tone: 'muted' } : { word: 'Not configured', tone: 'dim' }
  }

  const failed = (services: Service[]) => services.some(service => connections[service].phase === 'error')

  return { connections, testingAll, invalidate, test, testAll, describe, failed }
}
