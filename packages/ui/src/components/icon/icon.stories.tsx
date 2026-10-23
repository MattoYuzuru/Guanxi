import { machine, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { domainIconNames, Icon, iconNames, type IconName, type IconProps } from './icon.tsx'

const meta = {
  title: 'Primitives/Icon',
  component: Icon,
  args: { name: 'device-laptop' },
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<IconProps>

export default meta

function Grid({ names }: { names: IconName[] }) {
  return (
    <div className="gx-icon-grid">
      {names.map((name) => (
        <div key={name} className="gx-icon-cell">
          <Icon name={name} size={20} />
          <span>{machine(name)}</span>
        </div>
      ))}
    </div>
  )
}

export const SetState: Story<IconProps> = { name: 'set', render: () => <Grid names={iconNames} /> }

export const SizesState: Story<IconProps> = {
  name: 'sizes',
  render: () => (
    <div className="gx-icon-row">
      {([12, 14, 16, 18, 20, 24] as const).map((size) => <Icon key={size} name="memory-unified" size={size} />)}
    </div>
  ),
}

export const DomainState: Story<IconProps> = { name: 'domain', render: () => <Grid names={domainIconNames} /> }
