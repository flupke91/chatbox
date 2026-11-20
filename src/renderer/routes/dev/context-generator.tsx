import { createFileRoute } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

const LazyContextGeneratorContent = lazy(() => import('@/dev/ContextGeneratorContent'))

export const Route = createFileRoute('/dev/context-generator')({
  component: ContextGeneratorPage,
})

function ContextGeneratorPage() {
  return (
    <Suspense fallback={null}>
      <LazyContextGeneratorContent />
    </Suspense>
  )
}

export default ContextGeneratorPage
