import { useRef, useState } from 'react'
import * as api from './api'
import { useToast } from './components/Toast'
import type { ConnectionState, ServiceStatus } from './components/config/parts'
import {
  instanceConfigured,
  instanceOfService,
  serviceLabel,
  SERVICES,
  type ConfigDraft,
  type IntegrationService,
  type Service,
} from './config-services'
import type { SecretConfigKey } from '../../shared/contracts.js'
import { errorMessage } from '../../shared/errors.js'

const IDLE: ConnectionState = { phase: 'idle' }

/** Connection tests of the draft settings, one result per integration, including additional instances. */
export function useConnectionTests(form: ConfigDraft, clearedSecrets: Set<SecretConfigKey>) {
  const [connections, setConnections] = useState<Partial<Record<IntegrationService, ConnectionState>>>({})
  const [testingAll, setTestingAll] = useState(false)
  // A result only counts while it is the latest test of settings that have not changed since.
  const generation = useRef<Partial<Record<IntegrationService, number>>>({})
  const toast = useToast()

  const connection = (service: IntegrationService): ConnectionState => connections[service] || IDLE
  const show = (service: IntegrationService, state: ConnectionState) =>
    setConnections(current => ({ ...current, [service]: state }))
  const nextGeneration = (service: IntegrationService) =>
    (generation.current[service] = (generation.current[service] || 0) + 1)

  /** A changed setting voids the last result for its service, including one still on its way. */
  const invalidate = (service: IntegrationService) => {
    nextGeneration(service)
    show(service, IDLE)
  }

  const test = async (service: IntegrationService, quiet = false): Promise<boolean> => {
    const started = nextGeneration(service)
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
      if (!quiet) toast.show(`${serviceLabel(form, service)}: ${message}`, 'error')
      return false
    }
  }

  const testAll = async (services: IntegrationService[]) => {
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
  const describe = (service: IntegrationService): ServiceStatus => {
    const { phase } = connection(service)
    if (phase === 'success') return { word: 'Connected', tone: 'good' }
    if (phase === 'error') return { word: 'Failed', tone: 'bad' }
    if (phase === 'testing') return { word: 'Testing…', tone: 'busy' }
    if (service.startsWith('arr:')) {
      const instance = instanceOfService(form, service)
      return instance && instanceConfigured(instance)
        ? { word: 'Not tested', tone: 'muted' }
        : { word: 'Not configured', tone: 'dim' }
    }
    const { enabledBy, configured } = SERVICES[service as Service]
    if (enabledBy && !form[enabledBy]) return { word: 'Disabled', tone: 'dim' }
    return configured(form) ? { word: 'Not tested', tone: 'muted' } : { word: 'Not configured', tone: 'dim' }
  }

  const failed = (services: IntegrationService[]) => services.some(service => connection(service).phase === 'error')

  return { connection, testingAll, invalidate, test, testAll, describe, failed }
}
