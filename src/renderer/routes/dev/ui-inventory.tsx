import { createFileRoute } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

const LazyUiInventoryContent = lazy(() => import('@/dev/UiInventoryContent'))

export const Route = createFileRoute('/dev/ui-inventory')({
  component: UiInventoryPage,
})

function UiInventoryPage() {
  return (
    <Suspense fallback={null}>
      <LazyUiInventoryContent />
    </Suspense>
  )
}

export default UiInventoryPage
