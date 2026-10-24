import { Composer, Icon, IconButton, SegmentedControl, StatusItem, Switch, UiLocaleProvider } from '@guanxi/ui'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'

// Real public controls under the regime attributes a catalog frame sets; the spec measures them.
const params = new URLSearchParams(location.search)
const root = document.documentElement
root.dataset.theme = params.get('theme') ?? 'light'
root.dataset.density = params.get('density') ?? 'compact'
root.dataset.motion = 'reduced'

function Fixture() {
  const [density, setDensity] = useState<'compact' | 'comfortable'>('compact')
  const [prompt, setPrompt] = useState('')
  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 24 }}>
      <div data-testid="switches" style={{ display: 'flex', gap: 16 }}>
        <Switch aria-label="Off switch" data-testid="switch-off" />
        <Switch aria-label="On switch" data-testid="switch-on" defaultChecked />
      </div>
      <div data-testid="icon-buttons" style={{ display: 'flex', gap: 16 }}>
        {(['sm', 'md'] as const).map(size => <IconButton key={size} size={size} label={`Icon ${size}`} data-testid={`icon-${size}`} icon={<Icon name="settings" />} />)}
        <StatusItem icon="memory-unified" label="Memory" data-testid="status-icon" />
        <StatusItem icon="runtime" label="Runtime" wide align="start" data-testid="status-wide">
          <ul>{Array.from({ length: 40 }, (_, index) => <li key={index}>Fact {index + 1}</li>)}</ul>
        </StatusItem>
      </div>
      <SegmentedControl label="Density" value={density} onValueChange={setDensity}
        options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]} />
      <div style={{ width: 560 }}>
        <Composer label="Message" value={prompt} onValueChange={setPrompt} onSend={() => setPrompt('')} />
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<UiLocaleProvider locale="en"><Fixture /></UiLocaleProvider>)
