import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { ApiError } from '#/lib/api/api'
import { healthApi } from '#/lib/api/health'
import type { Health } from '#/lib/api/health'

export const Route = createFileRoute('/')({ component: Home })

// Starter page: shows that the client, the API and the base path are wired up.
// Replace it with your own.
function Home() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  function check(signal?: AbortSignal) {
    setError(null)
    healthApi.get(signal).then(setHealth, (err: unknown) => {
      if (signal?.aborted) return
      setHealth(null)
      setError(
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
      )
    })
  }

  useEffect(() => {
    const controller = new AbortController()
    check(controller.signal)
    return () => controller.abort()
  }, [])

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-3xl font-bold">It works</h1>
      <p className="text-muted-foreground mt-2">
        Edit <code>src/routes/index.tsx</code> to get started.
      </p>

      <section className="mt-8 rounded-lg border p-4">
        <h2 className="font-semibold">API</h2>
        {health && (
          <p className="mt-1 text-sm">
            Healthy · {health.env} · up {health.uptime}s
          </p>
        )}
        {error && <p className="text-destructive mt-1 text-sm">{error}</p>}
        {!health && !error && <p className="mt-1 text-sm">Checking…</p>}
        <Button className="mt-4" variant="outline" onClick={() => check()}>
          Check again
        </Button>
      </section>
    </main>
  )
}
